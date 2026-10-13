/** Experimental pinned rotom product boundary. Not yet connected to Pocket's Durable execution backend. */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
    accessSync,
    constants,
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { RotomRpc } from "./rotom-rpc.ts";

const runtime = fileURLToPath(new URL("../../runtime/rotom/", import.meta.url));
const product = join(runtime, "node_modules/@bingjiang0611/rotom");
const bootstrapFiles = [
    "package.json",
    "bin/rotom",
    "bin/rotom-launcher",
    "runtime/launch-runtime.mjs",
    "runtime/product-config.mjs",
    "runtime/resolve-installed-pi.mjs",
    "runtime/verify-pi-runtime.mjs",
];

function canonical(path: string, kind: "file" | "directory"): string {
    if (!isAbsolute(path)) {
        throw new Error("Kernel paths must be absolute");
    }

    const stat = lstatSync(path),
        actual = realpathSync(path);

    if (actual !== resolve(path) || (kind === "file" ? !stat.isFile() : !stat.isDirectory())) {
        throw new Error("Kernel path must be canonical and must not be a symlink");
    }

    return actual;
}

/** Session data operations only: load the pinned fork, never a second Agent execution loop. */
export async function nativeSessionManager() {
    verifyRotomKernel();
    const { resolveInstalledPi } = await import(
        pathToFileURL(join(product, "runtime/resolve-installed-pi.mjs")).href
    );

    await resolveInstalledPi(product);
    const entry = canonical(
        join(
            product,
            "runtime/pi/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js",
        ),
        "file",
    );

    return import(pathToFileURL(entry).href);
}

export function verifyRotomKernel(): { version: string; executable: string } {
    canonical(product, "directory");
    const pin = JSON.parse(readFileSync(join(runtime, "pin.json"), "utf8"));
    const pkg = JSON.parse(readFileSync(join(product, "package.json"), "utf8"));
    const lock = JSON.parse(readFileSync(join(runtime, "package-lock.json"), "utf8"));
    const locked = lock.packages["node_modules/@bingjiang0611/rotom"];

    if (locked.version !== pin.version || locked.integrity !== pin.integrity) {
        throw new Error("Kernel lock and product pin disagree");
    }

    if (
        pkg.version !== pin.version ||
        pkg.name !== "@bingjiang0611/rotom" ||
        pkg.bin?.rotom !== "bin/rotom"
    ) {
        throw new Error("Pinned rotom package identity mismatch");
    }

    for (const relative of bootstrapFiles) {
        const path = canonical(join(product, relative), "file");

        if (
            createHash("sha256").update(readFileSync(path)).digest("hex") !== pin.sha256[relative]
        ) {
            throw new Error(`Pinned rotom bootstrap mismatch: ${relative}`);
        }
    }

    const executable = join(product, "bin/rotom");

    accessSync(executable, constants.X_OK);

    // The verified product launcher performs its own bundled Pi/resource identity gate. Never invoke raw Pi instead.
    return { version: pkg.version, executable };
}

/** Preserve network routing, not general environment credentials. The local auth gate must never traverse a proxy. */
export function kernelNetworkEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
    const routing: Record<string, string> = {};

    for (const name of [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ]) {
        const value = environment[name];

        if (value !== undefined) {
            routing[name] = value;
        }
    }

    // Undici gives lowercase no_proxy precedence. Normalize it before adding the fixed IPv4 broker host.
    const bypass = environment.no_proxy ?? environment.NO_PROXY;

    routing.NO_PROXY = bypass ? `${bypass},127.0.0.1` : "127.0.0.1";

    // Node reads extra trust roots only at process startup. Preserve the parent's explicit trust file, not NODE_OPTIONS.
    if (environment.NODE_EXTRA_CA_CERTS) {
        routing.NODE_EXTRA_CA_CERTS = canonical(environment.NODE_EXTRA_CA_CERTS, "file");
    }

    return routing;
}

/** The service user's Chrome relay socket: `browserRelaySocketPathV1()` in rotom's `browser-relay.ts`. */
const relaySocket = join(
    homedir(),
    "Library",
    "Application Support",
    "rotom",
    "browser-relay",
    "relay.sock",
);

/**
 * The service user's Computer Use helper socket: the helper's own default for the service HOME. A member HOME sits too
 * deep for a socket (macOS caps the path at 103 bytes): the helper started there could never be reached, and each
 * session start waited about 3 s for it.
 */
const computerUseSocket = join(homedir(), "Library", "Caches", "pi-computer-use", "bridge.sock");

/** Members reach the helper as an external socket, which the extension never starts, so the service starts it. */
async function startComputerUseHelper(app: string): Promise<void> {
    const answers = await new Promise<boolean>((resolve) => {
        const socket = connect(computerUseSocket);

        socket.once("connect", () => {
            socket.destroy();
            resolve(true);
        });
        socket.once("error", () => resolve(false));
    });

    if (answers) {
        return;
    }

    // The helper holds a lock beside its socket, so a second concurrent launch exits on its own.
    await promisify(execFile)("open", [
        "-n",
        "-g",
        app,
        "--args",
        "serve",
        "--socket",
        computerUseSocket,
    ]).catch((error: Error) =>
        console.warn(
            `Computer Use helper did not start, desktop tools are unavailable: ${error.message}`,
        ),
    );
}

/**
 * What rotom would load from a member's own agent folder or HOME. All configuration belongs to the project, so a member
 * HOME holds none: a run refuses to start rather than quietly apply one member's file to that member's runs.
 */
const MEMBER_RESOURCES = [
    ".pi/agent/AGENTS.override.md",
    ".pi/agent/AGENTS.md",
    ".pi/agent/AGENTS.MD",
    ".pi/agent/CLAUDE.md",
    ".pi/agent/CLAUDE.MD",
    ".pi/agent/SYSTEM.md",
    ".pi/agent/APPEND_SYSTEM.md",
    ".pi/agent/mcp.json",
    ".pi/agent/extensions",
    ".pi/agent/skills",
    ".pi/agent/prompts",
    ".pi/agent/themes",
    ".agents/skills",
];
/** Settings that name resources to load. */
const RESOURCE_SETTINGS = ["extensions", "skills", "prompts", "themes", "packages"];

function settingsOf(file: string): Record<string, unknown> {
    return existsSync(file)
        ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>)
        : {};
}

function refuseMemberResources(home: string): void {
    const found = MEMBER_RESOURCES.filter((path) => existsSync(join(home, path)));
    const settings = settingsOf(join(home, ".pi/agent/settings.json"));

    found.push(
        ...RESOURCE_SETTINGS.filter((key) => key in settings).map(
            (key) => `settings.json "${key}"`,
        ),
    );

    if (found.length > 0) {
        throw new Error(
            `Configuration belongs to the project; remove it from this member's HOME (${home}): ${found.join(", ")}`,
        );
    }
}

/**
 * Where a run in the project finds skills besides `.pi/skills`: the paths in the project's settings (relative to
 * `.pi`), and `.agents/skills` in the workspace and each folder above it, up to the repository root.
 */
export function projectSkillPaths(workspace: string): string[] {
    const listed = settingsOf(join(workspace, ".pi/settings.json")).skills;
    const paths = Array.isArray(listed)
        ? listed
              .filter((path): path is string => typeof path === "string")
              .map((path) => resolve(workspace, ".pi", path))
        : [];

    for (let dir = workspace; ; dir = dirname(dir)) {
        paths.push(join(dir, ".agents/skills"));

        if (existsSync(join(dir, ".git")) || dirname(dir) === dir) {
            break;
        }
    }

    return paths;
}

/** Packages would install from the network as each run starts. */
function refuseProjectPackages(workspace: string): void {
    const packages = settingsOf(join(workspace, ".pi/settings.json")).packages;

    if (Array.isArray(packages) ? packages.length > 0 : packages !== undefined) {
        throw new Error(
            'Project packages are not loaded: put the extensions in .pi/extensions instead (.pi/settings.json "packages").',
        );
    }
}

/** What every rotom process of a member sees: its own HOME, the service's toolchain, and no ambient credential. */
function memberEnvironment(home: string, node: string): Record<string, string> {
    return {
        ...kernelNetworkEnvironment(process.env),
        HOME: home,
        // Coding tools need the service's developer toolchain (git, rg, package managers).
        PATH: `${dirname(node)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        PI_CODING_AGENT_DIR: join(home, ".pi/agent"),
        ROTOM_OBSERVABILITY: "0",
        LANG: "en_US.UTF-8",
    };
}

/**
 * `rotom mcp <args>` for a member in a project, as their runs see it: their HOME, the project's servers, the scrubbed
 * environment. `rotom mcp` has no `--approve`, so the project's trust is recorded in the member's `trust.json`.
 * Signing in never opens a browser on the server: a stand-in `open` shadows the real one, and the member opens the
 * address in their own browser. Otherwise the server's browser, signed in as the service user, could answer for them.
 */
export function startRotomMcp(options: {
    home: string;
    workspace: string;
    args: string[];
}): ChildProcess {
    const { executable } = verifyRotomKernel();
    const home = canonical(options.home, "directory"),
        workspace = canonical(options.workspace, "directory");

    if (lstatSync(home).mode & 0o077) {
        throw new Error("Kernel HOME must be private (0700)");
    }

    refuseMemberResources(home);
    const trustFile = join(home, ".pi/agent/trust.json");
    const trust = settingsOf(trustFile);

    if (trust[workspace] !== true) {
        mkdirSync(dirname(trustFile), { recursive: true, mode: 0o700 });
        writeFileSync(trustFile, `${JSON.stringify({ ...trust, [workspace]: true }, null, 2)}\n`, {
            mode: 0o600,
        });
    }

    const node = realpathSync(process.execPath);
    const environment = memberEnvironment(home, node);

    return spawn(executable, ["mcp", ...options.args], {
        cwd: workspace,
        env: {
            ...environment,
            PATH: `${fileURLToPath(new URL("./no-browser", import.meta.url))}:${environment.PATH}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
}

/** Caller owns a private HOME and a stopped/authorized session. No ambient credential or user-extension inheritance. */
export async function startRotomKernel(options: {
    home: string;
    workspace: string;
    provider: string;
    model: string;
    thinkingLevel?: string;
    sessionFile?: string;
    gateFile?: string;
    configuration?: { contextFile: string; skills: string[] };
}): Promise<RotomRpc> {
    const { executable } = verifyRotomKernel();
    const home = canonical(options.home, "directory"),
        workspace = canonical(options.workspace, "directory");

    if (lstatSync(home).mode & 0o077) {
        throw new Error("Kernel HOME must be private (0700)");
    }

    if (options.sessionFile) {
        canonical(options.sessionFile, "file");

        if (!options.sessionFile.startsWith(join(home, ".pi/agent/sessions") + "/")) {
            throw new Error("Native session must belong to this kernel HOME");
        }
    }

    if (options.gateFile) {
        canonical(options.gateFile, "file");

        if (lstatSync(options.gateFile).mode & 0o077) {
            throw new Error("Kernel gate file must be private");
        }
    }

    if (options.configuration) {
        canonical(options.configuration.contextFile, "file");

        for (const skill of options.configuration.skills) {
            canonical(skill, "file");
        }
    }

    refuseMemberResources(home);

    // Without a frozen snapshot the project's own configuration applies: rotom trusts the project and reads its
    // AGENTS.md, `.pi` (settings, mcp.json, extensions, skills, prompts, SYSTEM.md) and `.agents/skills` itself.
    if (!options.configuration) {
        refuseProjectPackages(workspace);
    }

    const node = realpathSync(process.execPath);
    // Desktop tools run as the service user. The member HOME isolates credentials, not the screen:
    // reuse the service user's installed (and TCC-authorized) Computer Use helper.
    const { resolveMacosHelperAppPath } = await import(
        pathToFileURL(
            join(
                product,
                "extensions/third-party/node_modules/@injaneity/pi-computer-use/src/platform/macos/helper-path.mjs",
            ),
        ).href
    );
    const computerUseApp = resolveMacosHelperAppPath({ homeDir: homedir() });

    if (process.platform === "darwin") {
        await startComputerUseHelper(computerUseApp);
    }

    const client = new RotomRpc(
        executable,
        [
            "--mode",
            "rpc",
            "--provider",
            options.provider,
            "--model",
            options.model,
            ...(options.thinkingLevel ? ["--thinking", options.thinkingLevel] : []),
            ...(options.configuration
                ? [
                      // A member's stored project trust (MCP sign-in records one) must not reopen the project.
                      "--no-approve",
                      "--no-context-files",
                      "--no-skills",
                      "--no-prompt-templates",
                      "--append-system-prompt",
                      options.configuration.contextFile,
                      ...options.configuration.skills.flatMap((path) => ["--skill", path]),
                  ]
                : ["--approve"]),
            // Sessions stay in the member HOME, whatever a project's `sessionDir` says.
            "--session-dir",
            join(home, ".pi/agent/sessions"),
            ...(options.sessionFile ? ["--session", options.sessionFile] : []),
            ...(options.gateFile
                ? ["--extension", fileURLToPath(new URL("./rotom-policy.mjs", import.meta.url))]
                : []),
        ],
        {
            cwd: workspace,
            // Image-bearing user/tool messages use the journal's same bounded record size.
            recordLimit: 64 * 1024 * 1024,
            env: {
                ...memberEnvironment(home, node),
                PI_COMPUTER_USE_HELPER_APP_PATH: computerUseApp,
                PI_CU_SOCKET_PATH: computerUseSocket,
                // Browser tools drive the service user's Chrome too, through its relay: see rotom-relay.mjs.
                NODE_OPTIONS: `--import=${new URL("./rotom-relay.mjs", import.meta.url).href}`,
                ROTOM_TEAM_BROWSER_RELAY: relaySocket,
                ROTOM_NODE: node,
                ...(options.gateFile
                    ? {
                          ROTOM_TEAM_KERNEL_GATE: options.gateFile,
                          // Subagents start through the team wrapper, so they reach the model through this gate too.
                          PI_SUBAGENT_PI_BINARY: fileURLToPath(
                              new URL("./rotom-child.sh", import.meta.url),
                          ),
                          ROTOM_TEAM_POLICY: fileURLToPath(
                              new URL("./rotom-policy.mjs", import.meta.url),
                          ),
                      }
                    : {}),
            },
        },
    );

    try {
        const state = (await client.request({ type: "get_state" })) as {
            model?: { provider: string; id: string };
            isStreaming?: boolean;
            thinkingLevel?: string;
        };

        if (
            state.model?.provider !== options.provider ||
            state.model.id !== options.model ||
            state.isStreaming !== false ||
            (options.thinkingLevel !== undefined && state.thinkingLevel !== options.thinkingLevel)
        ) {
            throw new Error("Kernel startup model/state mismatch; no fallback allowed");
        }

        if (options.gateFile) {
            const nonce = randomUUID();
            let installed = false;
            const detach = client.onEvent((event) => {
                if (
                    event.type !== "extension_ui_request" ||
                    event.method !== "notify" ||
                    typeof event.message !== "string"
                ) {
                    return;
                }

                let value;

                try {
                    value = JSON.parse(event.message);
                } catch {
                    return;
                }

                if (
                    value?.kind === "team-kernel-policy-v1" &&
                    value.nonce === nonce &&
                    value.ready === true
                ) {
                    installed = true;
                }
            });

            try {
                const disposition = await client.prompt(`/team-kernel-probe ${nonce}`);

                if (disposition !== "handled" || !installed) {
                    throw new Error(
                        "Kernel dispatch policy did not initialize; no inference admitted",
                    );
                }
            } finally {
                detach();
            }
        }

        await client.request({ type: "set_auto_retry", enabled: false });
        await client.request({ type: "set_auto_compaction", enabled: false });

        return client;
    } catch (error) {
        await client.close();

        throw error;
    }
}
