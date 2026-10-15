/** Read-only list of the Agent resources a Team session would load: shared, or shared plus one project. */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { nativeConfigurationApi } from "./rotom-kernel.ts";

type Scope = "shared" | "project";
type Resolved = {
    path: string;
    enabled: boolean;
    metadata: {
        source: string;
        scope: string;
        origin: string;
        baseDir?: string;
        packageRoot?: string;
    };
};
type Diagnostic = {
    type: string;
    message: string;
    path?: string;
    collision?: { name: string; winnerPath: string; loserPath: string };
};
type Skill = { name: string; description: string; filePath: string };
type McpEntry = {
    name: string;
    config: { enabled?: boolean; command?: string; args?: string[]; url?: string };
    source: string;
    scope?: string;
    override?: string;
};

export type ResourceOrigin = { scope: Scope; source: string; packageRoot?: string };
export type ListedSkill = ResourceOrigin & {
    name: string;
    description: string;
    path: string;
    enabled: boolean;
    /** Same name found earlier: native keeps that one and does not load this file. */
    sameNameAs?: string;
};
export type ListedExtension = ResourceOrigin & { path: string; enabled: boolean };
export type ListedMcpServer = {
    name: string;
    file: string;
    scope: Scope;
    enabled: boolean;
    target: string;
    /** Project `mcp.json` that overrides this shared server's settings. */
    override?: string;
};
export type ScannedPlace = { path: string; exists: boolean };
export type AgentResourceList = {
    shared: string;
    project?: string;
    /** Settings that failed to load and packages that are not installed: the lists may be incomplete. */
    problems: string[];
    instructions: { path: string; scope: Scope | "ancestor" }[];
    skills: ListedSkill[];
    skillProblems: string[];
    extensions: ListedExtension[];
    mcp: ListedMcpServer[];
    mcpProblems: string[];
    scanned: { skills: ScannedPlace[]; extensions: ScannedPlace[]; mcp: ScannedPlace[] };
};

const place = (path: string): ScannedPlace => ({ path, exists: existsSync(path) });

const origin = (resource: Resolved): ResourceOrigin => ({
    scope: resource.metadata.scope === "project" ? "project" : "shared",
    source: resource.metadata.source,
    ...(resource.metadata.packageRoot ? { packageRoot: resource.metadata.packageRoot } : {}),
});

/** The resolved resource a loaded skill file came from: its own path, or the closest directory holding it. */
function owner(resources: Resolved[], file: string): Resolved | undefined {
    return resources
        .filter((resource) => file === resource.path || file.startsWith(resource.path + sep))
        .sort((a, b) => b.path.length - a.path.length)[0];
}

/**
 * Resolve with the pinned native resolver, the way Team starts a session: the shared profile as the agent directory and
 * the project trusted. Nothing is installed; a missing package is reported. Built-in extensions have no file and are
 * not listed, nor the service user's `~/.agents/skills`, which Team never gives a member.
 */
export async function listAgentResources(
    shared: string,
    project?: string,
): Promise<AgentResourceList> {
    const api = await nativeConfigurationApi();
    const cwd = project ?? shared;
    const settings = api.SettingsManager.create(cwd, shared, { projectTrusted: !!project });
    const problems: string[] = settings
        .drainErrors()
        .map(
            (each: { path?: string; error: Error }) =>
                `${each.path ?? "settings.json"}: ${each.error.message}`,
        );
    const resolved = await new api.DefaultPackageManager({
        cwd,
        agentDir: shared,
        settingsManager: settings,
    }).resolve(async (source: string) => {
        problems.push(`Package not installed: ${source}`);

        return "skip";
    });
    const serviceAgents = join(homedir(), ".agents");
    const skillResources = (resolved.skills as Resolved[]).filter(
        (resource) => resource.metadata.baseDir !== serviceAgents,
    );
    const enabledSkills = skillResources.filter((resource) => resource.enabled);
    const disabledSkills = skillResources.filter((resource) => !resource.enabled);
    const load = (resources: Resolved[]) =>
        api.loadSkills({
            cwd,
            agentDir: shared,
            skillPaths: resources.map((resource) => resource.path),
            includeDefaults: false,
        }) as { skills: Skill[]; diagnostics: Diagnostic[] };
    const loaded = load(enabledSkills);
    const skills: ListedSkill[] = [];

    for (const [list, enabled] of [
        [loaded.skills, true],
        [load(disabledSkills).skills, false],
    ] as const) {
        for (const skill of list) {
            skills.push({
                name: skill.name,
                description: skill.description,
                path: skill.filePath,
                enabled,
                ...origin(owner(skillResources, skill.filePath)!),
            });
        }
    }

    const skillProblems: string[] = [];

    for (const diagnostic of loaded.diagnostics) {
        const collision = diagnostic.collision;

        if (diagnostic.type === "collision" && collision) {
            skills.push({
                name: collision.name,
                description: "",
                path: collision.loserPath,
                enabled: false,
                sameNameAs: collision.winnerPath,
                ...origin(owner(skillResources, collision.loserPath)!),
            });
        } else {
            skillProblems.push(
                diagnostic.path ? `${diagnostic.path}: ${diagnostic.message}` : diagnostic.message,
            );
        }
    }

    const mcp = api.loadMcpConfig({ agentDir: shared, cwd, projectTrusted: !!project }) as {
        servers: McpEntry[];
        errors: string[];
    };
    const projectPi = project ? join(project, ".pi") : undefined;
    const both = (name: string) => [
        place(join(shared, name)),
        ...(projectPi ? [place(join(projectPi, name))] : []),
    ];

    return {
        shared,
        ...(project ? { project } : {}),
        problems,
        instructions: api
            .loadProjectContextFiles({ cwd, agentDir: shared })
            // Without a project the walk from the shared folder up to `/` is not what any session loads.
            .filter(({ path }: { path: string }) => project || dirname(path) === shared)
            .map(({ path }: { path: string }) => ({
                path,
                scope:
                    dirname(path) === shared
                        ? "shared"
                        : dirname(path) === project
                          ? "project"
                          : "ancestor",
            })),
        // By name, so a same-name file sits under the one that loads (the sort is stable).
        skills: skills.sort((a, b) => a.name.localeCompare(b.name)),
        skillProblems,
        extensions: (resolved.extensions as Resolved[]).map((resource) => ({
            path: resource.path,
            enabled: resource.enabled,
            ...origin(resource),
        })),
        mcp: mcp.servers.map((server) => ({
            name: server.name,
            file: server.source,
            scope: server.scope === "project" ? "project" : "shared",
            enabled: server.config.enabled !== false,
            target:
                server.config.url ??
                [server.config.command, ...(server.config.args ?? [])].join(" "),
            ...(server.override ? { override: server.override } : {}),
        })),
        mcpProblems: mcp.errors,
        scanned: {
            skills: [
                ...both("skills"),
                ...(project ? [place(join(project, ".agents/skills"))] : []),
                ...both("settings.json"),
            ],
            extensions: [...both("extensions"), ...both("settings.json")],
            mcp: both("mcp.json"),
        },
    };
}
