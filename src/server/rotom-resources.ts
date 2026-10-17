/** Owner-managed native resources; member HOMEs remain credential and session boundaries. */
import { createHash, randomUUID } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    lstatSync,
    writeFileSync,
} from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
    assertTeamResourceSources,
    teamResourceSettings,
    resourceFileDigest,
    safeConfigurationPath,
    privateConfigurationNames,
    TeamResourcePolicyError,
} from "./rotom-resource-policy.ts";
import { nativeConfigurationApi } from "./rotom-kernel.ts";

const resourceKeys = ["extensions", "skills", "prompts", "themes"] as const;
const standardFiles = [
    "AGENTS.md",
    "SYSTEM.md",
    "APPEND_SYSTEM.md",
    "mcp.json",
    "sol-pi.json",
    "extensions/pi-computer-use.json",
];

function json(file: string): Record<string, any> {
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

function write(file: string, value: string | Buffer) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const wanted = Buffer.isBuffer(value) ? value : Buffer.from(value);

    if (existsSync(file)) {
        const info = lstatSync(file);

        // Existing public-mode legacy files still need replacement with a private atomic write. Never follow a link
        // for the byte comparison; the policy checks above decide whether replacing it is allowed.
        if (
            info.isFile() &&
            !info.isSymbolicLink() &&
            !(info.mode & 0o077) &&
            readFileSync(file).equals(wanted)
        ) {
            return;
        }
    }

    const temporary = `${file}.${randomUUID()}.tmp`;

    writeFileSync(temporary, wanted, { mode: 0o600 });
    renameSync(temporary, file);
}

/** A plugin's non-native config files must be explicitly declared by the owner; never guess unknown files' meaning. */
export function sharedConfigFiles(directory: string): string[] {
    const declared = json(safeConfigurationPath(directory, "team.json")).configFiles ?? [];

    if (
        !Array.isArray(declared) ||
        declared.some(
            (file) =>
                typeof file !== "string" ||
                isAbsolute(file) ||
                file
                    .split(/[\\/]/)
                    .some(
                        (part: string) =>
                            !part ||
                            part === "." ||
                            part === ".." ||
                            privateConfigurationNames.has(part.toLowerCase()),
                    ) ||
                ["settings.json", "team.json", "team-resource-view.json"].includes(
                    file.toLowerCase(),
                ),
        )
    ) {
        throw new Error(
            "team.json configFiles must name relative configuration files, never credentials, models or session storage",
        );
    }

    const names = [...standardFiles, ...declared.map((file: string) => file.replaceAll("\\", "/"))];
    const unique = new Map<string, string>();

    for (const name of names) {
        const old = unique.get(name.toLowerCase());

        if (old && old !== name) {
            throw new TeamResourcePolicyError(`Ambiguous configuration filename casing: ${name}`);
        }

        unique.set(name.toLowerCase(), name);
    }

    return [...unique.values()];
}

/** Bounded, read-only freshness hint: declared configuration and immediate resource metadata, never dependency trees. */
export function teamResourceRevision(directory: string, workspace?: string): string {
    const hash = createHash("sha256");

    if (workspace) {
        for (const name of ["settings.json", "mcp.json", "SYSTEM.md", "APPEND_SYSTEM.md"]) {
            const file = join(workspace, ".pi", name);

            hash.update(file);

            if (existsSync(file)) {
                hash.update(readFileSync(file));
            }
        }
    }

    for (const name of [
        "settings.json",
        "team.json",
        "npm/package.json",
        "npm/package-lock.json",
        "npm/npm-shrinkwrap.json",
        ...sharedConfigFiles(directory),
    ].sort()) {
        const file = safeConfigurationPath(directory, name);

        hash.update(name);

        if (existsSync(file)) {
            hash.update(readFileSync(file));
        }
    }

    for (const name of [
        "extensions",
        "skills",
        "prompts",
        "themes",
        "agents",
        "chains",
        "global-npm/lib/node_modules",
    ]) {
        const file = join(directory, name);
        const stat = lstatSync(file, { throwIfNoEntry: false });

        hash.update(name);

        if (!stat) {
            continue;
        }

        hash.update(`${stat.mtimeMs}:${stat.size}:${stat.isSymbolicLink()}`);

        if (stat.isDirectory() && !name.includes("node_modules")) {
            for (const entry of readdirSync(file).sort()) {
                const child = lstatSync(join(file, entry), { bigint: true });

                hash.update(`${entry}:${child.mtimeNs}:${child.size}:${child.isSymbolicLink()}`);
            }
        }
    }

    return hash.digest("hex");
}

/** Resolve already-installed shared packages with the pinned native resolver; never install on a member's run. */
export async function prepareTeamResources(
    home: string,
    directory: string,
    workspace: string,
    payerModel?: { provider: string; model: string },
) {
    safeConfigurationPath(directory, "settings.json");
    safeConfigurationPath(directory, "team.json");
    safeConfigurationPath(home, ".pi/agent/settings.json");
    safeConfigurationPath(home, ".pi/agent/team-resource-view.json");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    await assertTeamResourceSources(home, directory, workspace, "prepare");
    const api = await nativeConfigurationApi();
    const manager = api.SettingsManager.create(workspace, directory, { projectTrusted: false });
    const errors = manager.drainErrors();

    if (errors.length) {
        throw new Error("Invalid shared native settings");
    }

    const packageManager = new api.DefaultPackageManager({
        cwd: workspace,
        agentDir: directory,
        settingsManager: manager,
    });
    const resources = await packageManager.resolve(async () => "error");
    const base = manager.getGlobalSettings();
    const settings = {
        ...base,
        packages: packageManager.listConfiguredPackages().map((pkg: { installedPath: string }) => ({
            source: pkg.installedPath,
            extensions: [],
            skills: [],
            prompts: [],
            themes: [],
        })),
        subagents: base.subagents,
    };

    for (const key of resourceKeys) {
        settings[key] = resources[key]
            .filter(
                (resource: { enabled: boolean; metadata: { baseDir?: string } }) =>
                    resource.enabled && resource.metadata.baseDir !== join(homedir(), ".agents"),
            )
            .map((resource: { path: string }) => resource.path);
    }

    settings.extensions.push(
        ...resources.extensions
            .filter(
                (resource: { enabled: boolean; path: string }) =>
                    !resource.enabled && resource.path.startsWith("builtin:"),
            )
            .map((resource: { path: string }) => `-${resource.path}`),
    );
    const agentDir = join(home, ".pi/agent");
    const memberNames = existsSync(agentDir) ? readdirSync(agentDir) : [];

    for (const name of ["AGENTS.override.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]) {
        if (memberNames.includes(name)) {
            throw new Error(`Member instructions are not allowed: ${name}`);
        }
    }

    const previous = json(join(agentDir, "team-resource-view.json"));
    const files = sharedConfigFiles(directory);

    if (previous.directory && previous.directory !== directory) {
        throw new Error("Member resource view belongs to a different Team profile");
    }

    const contents = new Map(
        files
            .filter((name) => existsSync(safeConfigurationPath(directory, name)))
            .map((name) => [name, readFileSync(safeConfigurationPath(directory, name))]),
    );

    if (payerModel && !contents.has("sol-pi.json")) {
        // Preserve rotom 0.1.25's feature defaults, but auxiliary inference must use the admitted payer/model.
        contents.set(
            "sol-pi.json",
            Buffer.from(
                `${JSON.stringify({
                    version: 1,
                    actionFusion: true,
                    observationPack: true,
                    evidencePreservingReducer: true,
                    evidencePreservingReducerProvider: payerModel.provider,
                    evidencePreservingReducerModel: payerModel.model,
                    onlineContextCompact: false,
                })}\n`,
            ),
        );
    }

    const present = [...contents.keys()];
    const retiring = [...new Set<string>([...(previous.files ?? []), ...files])].filter(
        (name) => !present.includes(name),
    );

    for (const name of [...present, ...retiring]) {
        safeConfigurationPath(home, `.pi/agent/${name}`);
    }

    // Retire only bytes previously written by Team. Changed or unclassified files require explicit migration.
    for (const name of retiring) {
        const target = safeConfigurationPath(home, `.pi/agent/${name}`);

        if (existsSync(target) && previous.fileDigests?.[name] !== resourceFileDigest(target)) {
            throw new TeamResourcePolicyError(
                `Refusing to remove unmanaged or changed member configuration: ${name}`,
            );
        }
    }

    for (const name of present) {
        const sourceDigest = createHash("sha256").update(contents.get(name)!).digest("hex");
        const target = safeConfigurationPath(home, `.pi/agent/${name}`);

        if (
            existsSync(target) &&
            !previous.files?.includes(name) &&
            resourceFileDigest(target) !== sourceDigest
        ) {
            throw new TeamResourcePolicyError(
                `Shared configuration collides with an unmanaged member file: ${name}`,
            );
        }
    }

    for (const name of retiring) {
        rmSync(safeConfigurationPath(home, `.pi/agent/${name}`), { force: true });
    }

    for (const name of present) {
        write(safeConfigurationPath(home, `.pi/agent/${name}`), contents.get(name)!);
    }

    write(join(agentDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
    const view = {
        directory,
        files: present,
        fileDigests: Object.fromEntries(
            present.map((file) => [file, resourceFileDigest(join(agentDir, file))]),
        ),
        subagents: settings.subagents,
        resourceSettings: teamResourceSettings(settings),
        declaredFiles: files,
        revision: teamResourceRevision(directory),
    };

    write(join(agentDir, "team-resource-view.json"), `${JSON.stringify(view)}\n`);

    return settings;
}

/** Snapshot only declared configuration. Unclassified plugin state remains untouched and unverified. */
export function memberConfigurationSnapshot(home: string, directory: string) {
    return Object.fromEntries(
        ["settings.json", ...sharedConfigFiles(directory)].map((name) => {
            const file = safeConfigurationPath(home, `.pi/agent/${name}`);

            return [
                name,
                existsSync(file)
                    ? name === "settings.json"
                        ? json(file)
                        : resourceFileDigest(file)
                    : null,
            ];
        }),
    );
}

/** Commands cannot silently customize a member resource profile. Configuration writes must use the owner-managed
 * shared profile, not a plugin's implicit member HOME target. An effect already happened, so callers keep unknown. */
export function memberConfigurationChanges(
    home: string,
    directory: string,
    before: ReturnType<typeof memberConfigurationSnapshot>,
) {
    const after = memberConfigurationSnapshot(home, directory);
    const changed = Object.keys(before).filter(
        (file) => !isDeepStrictEqual(before[file], after[file]),
    );

    return changed;
}

/** Keep the native context-file precedence, adding only the shared base to frozen project context. */
export async function sharedContextPaths(directory: string): Promise<string[]> {
    const api = await nativeConfigurationApi();

    return api
        .loadProjectContextFiles({ cwd: directory, agentDir: directory })
        .filter((file: { path: string }) => dirname(file.path) === resolve(directory))
        .map((file: { path: string }) => file.path);
}
