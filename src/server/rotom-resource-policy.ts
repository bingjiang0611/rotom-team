/** Fail closed on the bundled subagent loader's independent project/member resource readers. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, lstatSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { nativeConfigurationApi } from "./rotom-kernel.ts";

export class TeamResourcePolicyError extends Error {}

export const privateConfigurationNames = new Set([
    "auth.json",
    "mcp-auth.json",
    "models.json",
    "models-store.json",
    "sessions",
    "subagent-store",
    "trust.json",
]);

/** Configuration is copied, never linked. Reject aliases before reading or writing private state. */
export function safeConfigurationPath(root: string, name: string): string {
    const parts = name.split(/[\\/]/);

    if (
        isAbsolute(name) ||
        parts.some(
            (part) =>
                !part ||
                part === "." ||
                part === ".." ||
                privateConfigurationNames.has(part.toLowerCase()),
        )
    ) {
        throw new TeamResourcePolicyError(`Invalid shared configuration path: ${name}`);
    }

    const rootStat = lstatSync(root, { throwIfNoEntry: false });

    if (rootStat && (!rootStat.isDirectory() || rootStat.isSymbolicLink())) {
        throw new TeamResourcePolicyError("Configuration root must be a real directory");
    }

    let path = root;

    for (const [index, part] of parts.entries()) {
        path = join(path, part);
        const stat = lstatSync(path, { throwIfNoEntry: false });

        if (!stat) {
            continue;
        }

        if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1)) {
            throw new TeamResourcePolicyError(`Configuration links are not allowed: ${name}`);
        }

        if (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()) {
            throw new TeamResourcePolicyError(
                `Configuration path has the wrong file type: ${name}`,
            );
        }
    }

    return path;
}

export function resourceFileDigest(file: string): string {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Only native resource-selection fields; credentials/default model/runtime state are not shared resources. */
export function teamResourceSettings(settings: Record<string, any>) {
    return Object.fromEntries(
        ["packages", "extensions", "skills", "prompts", "themes"].map((key) => [
            key,
            settings[key],
        ]),
    );
}

function json(file: string): Record<string, any> {
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

function packageRoots(directory: string): string[] {
    if (!existsSync(directory)) {
        return [];
    }

    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        if (entry.name.startsWith(".") || (!entry.isDirectory() && !entry.isSymbolicLink())) {
            return [];
        }

        const path = join(directory, entry.name);

        return entry.name.startsWith("@")
            ? readdirSync(path, { withFileTypes: true })
                  .filter((child) => child.isDirectory() || child.isSymbolicLink())
                  .map((child) => join(path, child.name))
            : [path];
    });
}

function rejectAgentPackage(root: string) {
    const manifest = json(join(root, "package.json"));

    for (const config of [manifest["pi-subagents"], manifest.pi?.subagents]) {
        if (
            [config?.agents, config?.chains].some(
                (value) =>
                    Array.isArray(value) &&
                    value.some((path) => typeof path === "string" && path.trim()),
            )
        ) {
            throw new TeamResourcePolicyError(
                `Agent package sources belong to the shared Team profile, not ${root}`,
            );
        }
    }
}

/** Mirrors the pinned loader's file discovery boundary, not its role parser. Skills and pruned runtime trees stay untouched. */
function definitionFiles(directory: string, legacy = false): string[] {
    if (!existsSync(directory)) {
        return [];
    }

    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const file = join(directory, entry.name);

        if (entry.isDirectory()) {
            if (
                [".git", "node_modules"].includes(entry.name) ||
                (legacy && entry.name === "skills") ||
                [".git", ".pi", ".agents"].some((name) => existsSync(join(file, name)))
            ) {
                return [];
            }

            return definitionFiles(file, legacy || entry.name === ".agents");
        }

        return (entry.isFile() || entry.isSymbolicLink()) &&
            (entry.name.endsWith(".md") || entry.name.endsWith(".chain.json"))
            ? [file]
            : [];
    });
}

export async function assertTeamResourceSources(
    home: string,
    shared: string,
    cwd: string,
    phase: "prepare" | "live" = "live",
): Promise<void> {
    const api = await nativeConfigurationApi();
    const agentDir = join(home, ".pi/agent");
    const previous = json(safeConfigurationPath(home, ".pi/agent/team-resource-view.json"));
    const member = json(safeConfigurationPath(home, ".pi/agent/settings.json"));

    // Parent preparation replaces resource fields. A live tool/child must not consume later private overrides.
    if (phase === "live") {
        if (
            previous.directory !== shared ||
            !isDeepStrictEqual(teamResourceSettings(member), previous.resourceSettings)
        ) {
            throw new TeamResourcePolicyError(
                "Member resource settings changed; restore the shared resource view before continuing",
            );
        }

        for (const name of previous.declaredFiles) {
            const file = safeConfigurationPath(home, `.pi/agent/${name}`);
            const digest = existsSync(file) ? resourceFileDigest(file) : undefined;

            if (digest !== previous.fileDigests?.[name]) {
                throw new TeamResourcePolicyError(`Member configuration changed: ${name}`);
            }
        }
    }

    const matchesDerivedRoles = isDeepStrictEqual(member.subagents, previous.subagents);
    const unpreparedDefaults = phase === "prepare" && !member.subagents;

    if (!matchesDerivedRoles && !unpreparedDefaults) {
        throw new TeamResourcePolicyError(
            "Member subagent settings are not allowed; migrate configuration to the shared Team profile",
        );
    }

    for (const file of [
        ...definitionFiles(join(agentDir, "agents")),
        ...definitionFiles(join(agentDir, "chains")),
        ...definitionFiles(join(home, ".agents"), true),
    ]) {
        const name = relative(agentDir, file);

        if (
            previous.directory !== shared ||
            previous.fileDigests?.[name] !== resourceFileDigest(file)
        ) {
            throw new TeamResourcePolicyError(`Member agent definitions are not allowed: ${file}`);
        }
    }

    const memberAuto = await new api.DefaultPackageManager({
        cwd,
        agentDir,
        settingsManager: api.SettingsManager.fromStorage(
            { withLock: (_scope: string, read: (text: string) => unknown) => read("{}") },
            { projectTrusted: false },
        ),
    }).resolve(async () => "error");

    if (
        memberAuto.extensions.some(
            (resource: { path: string }) => !resource.path.startsWith("builtin:"),
        ) ||
        memberAuto.prompts.length ||
        memberAuto.themes.length
    ) {
        throw new TeamResourcePolicyError(
            "Member extensions are not allowed; install them in the shared Team profile",
        );
    }

    for (const root of packageRoots(join(agentDir, "npm/node_modules"))) {
        rejectAgentPackage(root);
    }

    // The native plugin can select an ancestor via projectRootResolution. Reject that configuration before it resolves a root.
    let projectRoot: string | undefined;

    for (let directory = resolve(cwd); ; directory = dirname(directory)) {
        if (
            existsSync(join(directory, ".pi/settings.json")) &&
            "subagents" in json(join(directory, ".pi/settings.json"))
        ) {
            throw new TeamResourcePolicyError(
                `Project subagent settings are not allowed: ${directory}`,
            );
        }

        if (
            !projectRoot &&
            [".pi", ".agents"].some(
                (name) =>
                    existsSync(join(directory, name)) &&
                    statSync(join(directory, name)).isDirectory(),
            )
        ) {
            projectRoot = directory;
        }

        if (dirname(directory) === directory) {
            break;
        }
    }

    projectRoot ??= resolve(cwd);
    const definitions = [
        ...definitionFiles(join(projectRoot, ".pi/agents")),
        ...definitionFiles(join(projectRoot, ".pi/chains")),
        ...definitionFiles(join(projectRoot, ".agents"), true),
    ];

    if (definitions.length) {
        throw new TeamResourcePolicyError(
            `Project agent definitions are not allowed: ${definitions[0]}`,
        );
    }

    const configDir = join(projectRoot, ".pi");
    const manager = new api.DefaultPackageManager({
        cwd: projectRoot,
        agentDir,
        settingsManager: api.SettingsManager.fromStorage({
            withLock: (_scope: string, read: (value: string) => unknown) => read("{}"),
        }),
    });
    const roots = [projectRoot, ...packageRoots(join(configDir, "npm/node_modules"))];

    for (const entry of json(join(configDir, "settings.json")).packages ?? []) {
        const source = typeof entry === "string" ? entry : entry.source;

        if (typeof source !== "string") {
            continue;
        }

        const normalized = source.replace(/^file:/, "").replace(/^~(?=\/|$)/, home);
        const installed = manager.getInstalledPath(normalized, "project");

        if (installed) {
            roots.push(installed);
        }
    }

    for (const root of roots) {
        rejectAgentPackage(root);
    }
}

export function teamSubagentEnvironment(shared: string): Record<string, string> {
    return {
        npm_config_prefix: join(shared, "global-npm"),
        PI_SUBAGENT_EXTRA_AGENT_DIRS: join(shared, "agents"),
    };
}

/** Native parsing handles actual aliases and option values. Canonical paths defeat project symlinks into an allowlist. */
export async function assertTeamChildArguments(
    args: string[],
    home: string,
    shared: string,
    cwd: string,
): Promise<void> {
    await assertTeamResourceSources(home, shared, cwd);
    const api = await nativeConfigurationApi();
    const parsed = api.parseArgs(args);

    if (parsed.projectTrustOverride === true) {
        throw new TeamResourcePolicyError("Child --approve/-a is not allowed in Team");
    }

    const settings = json(join(home, ".pi/agent/settings.json"));
    const roots = [realpathSync(shared), realpathSync(api.bundledResourceRoot)];
    const configured = (settings.extensions ?? []).filter(
        (path: string) => !path.startsWith("-") && !path.startsWith("builtin:"),
    );
    const allowed = new Set(configured.map((path: string) => realpathSync(path)));

    for (const source of parsed.extensions ?? []) {
        if (source.startsWith("builtin:")) {
            if (!(settings.extensions ?? []).includes(source)) {
                throw new TeamResourcePolicyError(`Child extension is not shared: ${source}`);
            }

            continue;
        }

        const file = realpathSync(
            isAbsolute(source) ? source : resolve(cwd, source.replace(/^~(?=\/|$)/, home)),
        );

        if (
            !allowed.has(file) &&
            !roots.some((root) => file === root || file.startsWith(root + sep))
        ) {
            throw new TeamResourcePolicyError(
                `Child extension is not shared or bundled: ${source}`,
            );
        }
    }
}
