/** Preserve the derived shared member profile; trusted projects use native resource discovery. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, lstatSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { nativeConfigurationApi } from "./rotom-kernel.ts";
import { parseWithWork } from "./perf-channels.ts";

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
    return existsSync(file) ? parseWithWork("native-settings", readFileSync(file, "utf8")) : {};
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
}

export function teamSubagentEnvironment(shared: string): Record<string, string> {
    return {
        npm_config_prefix: join(shared, "global-npm"),
        PI_SUBAGENT_EXTRA_AGENT_DIRS: join(shared, "agents"),
    };
}
