/** Experimental pinned rotom product boundary. Not yet connected to Pocket's Durable execution backend. */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { clampThinkingLevel, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { teamSubagentEnvironment } from "./rotom-resource-policy.ts";
import { accessSync, constants, lstatSync, readFileSync, realpathSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { RotomRpc } from "./rotom-rpc.ts";
import { nativeStartChannel, parseWithWork, type NativeStartSignal } from "./perf-channels.ts";
import { prepareTeamResources, sharedContextPaths } from "./rotom-resources.ts";

const runtime = fileURLToPath(new URL("../../runtime/rotom/", import.meta.url));
const product = join(runtime, "node_modules/@bingjiang0611/rotom");

/** Team's own extensions: every member session loads both, next to the product's (each one runs through the gate). */
export const teamSkillsExtension = fileURLToPath(new URL("./rotom-skills.mjs", import.meta.url));
export const teamPolicyExtension = fileURLToPath(new URL("./rotom-policy.mjs", import.meta.url));

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
export async function nativeBuiltinCommands(): Promise<
    Array<{ name: string; description?: string; argumentHint?: string }>
> {
    verifyRotomKernel();
    const { resolveInstalledPi } = await import(
        pathToFileURL(join(product, "runtime/resolve-installed-pi.mjs")).href
    );

    await resolveInstalledPi(product);
    const entry = canonical(
        join(
            product,
            "runtime/pi/node_modules/@earendil-works/pi-coding-agent/dist/core/slash-commands.js",
        ),
        "file",
    );
    const module = (await import(pathToFileURL(entry).href)) as {
        BUILTIN_SLASH_COMMANDS?: Array<{
            name?: unknown;
            description?: unknown;
            argumentHint?: unknown;
        }>;
    };

    return (module.BUILTIN_SLASH_COMMANDS ?? []).filter(
        (command): command is { name: string; description?: string; argumentHint?: string } =>
            typeof command.name === "string" &&
            (command.description === undefined || typeof command.description === "string") &&
            (command.argumentHint === undefined || typeof command.argumentHint === "string"),
    );
}

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

    const manager = await import(pathToFileURL(entry).href);
    const ai = await import(
        pathToFileURL(
            canonical(
                join(product, "runtime/pi/node_modules/@earendil-works/pi-ai/dist/index.js"),
                "file",
            ),
        ).href
    );

    return { ...manager, contentText: ai.contentText };
}

/** Pinned native serializers, without starting extensions or a model process. */
export async function nativeSessionExports() {
    await nativeSessionManager();
    const core = join(product, "runtime/pi/node_modules/@earendil-works/pi-coding-agent/dist/core");
    const jsonl = await import(
        pathToFileURL(canonical(join(core, "session-export.js"), "file")).href
    );
    const html = await import(
        pathToFileURL(canonical(join(core, "export-html/index.js"), "file")).href
    );

    return {
        serializeSessionBranch: jsonl.serializeSessionBranch,
        exportFromFile: html.exportFromFile,
    };
}

export async function nativeConfigurationApi() {
    await nativeSessionManager();
    const root = join(product, "runtime/pi/node_modules/@earendil-works/pi-coding-agent/dist");
    const settings = await import(
        pathToFileURL(canonical(join(root, "core/settings-manager.js"), "file")).href
    );
    const trust = await import(
        pathToFileURL(canonical(join(root, "core/trust-manager.js"), "file")).href
    );
    const productInfo = await import(
        pathToFileURL(canonical(join(root, "utils/rotom-product.js"), "file")).href
    );
    const models = await import(
        pathToFileURL(canonical(join(root, "core/model-resolver.js"), "file")).href
    );

    const packages = await import(
        pathToFileURL(canonical(join(root, "core/package-manager.js"), "file")).href
    );

    const resourceLoader = await import(pathToFileURL(join(root, "core/resource-loader.js")).href);
    const skills = await import(pathToFileURL(join(root, "core/skills.js")).href);
    const mcp = await import(pathToFileURL(join(root, "extensions/mcp/config.js")).href);
    const args = await import(pathToFileURL(join(root, "cli/args.js")).href);
    const builtIn = await import(pathToFileURL(join(root, "extensions/index.js")).href);
    const productConfig = await import(
        pathToFileURL(canonical(join(product, "runtime/product-config.mjs"), "file")).href
    );

    return {
        bundledResourceRoot: product,
        productVersion: JSON.parse(readFileSync(join(product, "package.json"), "utf8"))
            .version as string,
        /** What the product launcher adds to every session, as `--extension`/`--skill` paths. */
        productResources: (
            productConfig.RESOURCE_DESCRIPTORS_V1 as {
                id: string;
                kind: "extension" | "skill";
                path: string;
                loadPath?: string;
            }[]
        ).map((resource) => ({
            id: resource.id,
            kind: resource.kind,
            path: resolve(product, resource.loadPath ?? resource.path),
        })),
        /** The packages the product's `third-party` extension bundles. */
        thirdPartyPackages: Object.keys(productConfig.VERIFIED_THIRD_PARTY_PACKAGES),
        // Inside a session the launcher sets ROTOM_PRODUCT_VERSION, and native then leaves Codemode to the product's
        // own extension. This process has no such variable, so the native list still names it here.
        builtInExtensions: (builtIn.builtInExtensions as { name: string }[])
            .map((each) => each.name)
            .filter((name) => name !== "codemode"),
        parseArgs: args.parseArgs,
        loadProjectContextFiles: resourceLoader.loadProjectContextFiles,
        loadSkills: skills.loadSkills,
        loadMcpConfig: mcp.loadMcpConfig,
        DefaultPackageManager: packages.DefaultPackageManager,
        SettingsManager: settings.SettingsManager,
        ProjectTrustStore: trust.ProjectTrustStore,
        getProjectTrustOptions: trust.getProjectTrustOptions,
        resolveModelScopeFromModels: models.resolveModelScopeFromModels,
        packageUrl: productInfo.ROTOM_PACKAGE_URL,
        updateGuidance: productInfo.ROTOM_UPDATE_GUIDANCE,
    };
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
 * `rotom mcp <args>` for a member: shared/project definitions, their private HOME and the scrubbed environment.
 * The MCP-only CLI reads native trust but does not load project extensions or packages.
 * Signing in never opens a browser on the server: a stand-in `open` shadows the real one, and the member opens the
 * address in their own browser. Otherwise the server's browser, signed in as the service user, could answer for them.
 */
export async function startRotomMcp(options: {
    home: string;
    workspace: string;
    teamAgentDir: string;
    args: string[];
}): Promise<ChildProcess> {
    const { executable } = verifyRotomKernel();
    const home = canonical(options.home, "directory"),
        workspace = canonical(options.workspace, "directory");

    if (lstatSync(home).mode & 0o077) {
        throw new Error("Kernel HOME must be private (0700)");
    }

    const teamAgentDir = options.teamAgentDir;

    await prepareTeamResources(home, teamAgentDir, workspace);
    const api = await nativeConfigurationApi();

    // The MCP-only CLI and Agent startup use the same trusted project configuration.
    new api.ProjectTrustStore(join(home, ".pi/agent")).set(workspace, true);
    const node = realpathSync(process.execPath);
    const environment = memberEnvironment(home, node);

    const child = spawn(executable, ["mcp", ...options.args], {
        cwd: workspace,
        env: {
            ...environment,
            ...teamSubagentEnvironment(teamAgentDir),
            PATH: `${fileURLToPath(new URL("./no-browser", import.meta.url))}:${environment.PATH}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
    });

    await once(child, "spawn");

    return child;
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
    teamAgentDir: string;
    configuration?: { contextFile: string; skills: string[] };
}): Promise<RotomRpc> {
    const started = performance.now();
    let phase = started;
    const { executable } = verifyRotomKernel();
    const verifyMs = performance.now() - phase;

    phase = performance.now();
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

    const teamAgentDir = options.teamAgentDir;
    const validateMs = performance.now() - phase;

    phase = performance.now();
    await prepareTeamResources(home, teamAgentDir, workspace, {
        provider: options.provider,
        model: options.model,
    });
    const resourcesMs = performance.now() - phase;

    phase = performance.now();
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

    const helperMs = performance.now() - phase;

    phase = performance.now();
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
            "--approve",
            "--no-skills",
            "--extension",
            teamSkillsExtension,
            ...(options.configuration
                ? [
                      // Legacy snapshots freeze instructions, not trusted project executable resources.
                      "--no-context-files",
                      ...(await sharedContextPaths(teamAgentDir)).flatMap((path) => [
                          "--append-system-prompt",
                          path,
                      ]),
                      "--append-system-prompt",
                      options.configuration.contextFile,
                      ...options.configuration.skills.flatMap((path) => ["--skill", path]),
                  ]
                : []),
            // Sessions stay in the member HOME, whatever a project's `sessionDir` says.
            "--session-dir",
            join(home, ".pi/agent/sessions"),
            ...(options.sessionFile ? ["--session", options.sessionFile] : []),
            ...(options.gateFile ? ["--extension", teamPolicyExtension] : []),
        ],
        {
            cwd: workspace,
            // Image-bearing user/tool messages use the journal's same bounded record size.
            recordLimit: 64 * 1024 * 1024,
            env: {
                ...memberEnvironment(home, node),
                ...teamSubagentEnvironment(teamAgentDir),
                ...(options.configuration
                    ? {
                          ROTOM_TEAM_FROZEN_CONTEXT: options.configuration.contextFile,
                          ROTOM_TEAM_FROZEN_SKILLS: JSON.stringify(options.configuration.skills),
                      }
                    : {}),
                ROTOM_TEAM_AGENT_DIR: teamAgentDir,
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
                          ROTOM_TEAM_POLICY: teamPolicyExtension,
                          ROTOM_TEAM_SKILLS: teamSkillsExtension,
                      }
                    : {}),
            },
        },
    );

    try {
        const state = (await client.request({ type: "get_state" })) as {
            model?: Model<any>;
            isStreaming?: boolean;
            thinkingLevel?: string;
        };

        if (
            state.model?.provider !== options.provider ||
            state.model.id !== options.model ||
            state.isStreaming !== false ||
            // Pi clamps a restored level to the model without recording it; a new model may lack "off".
            (options.thinkingLevel !== undefined &&
                state.thinkingLevel !==
                    clampThinkingLevel(state.model, options.thinkingLevel as ModelThinkingLevel))
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
                    value = parseWithWork("native-rpc", event.message);
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

        if (nativeStartChannel.hasSubscribers) {
            const rpcReadyMs = performance.now() - phase;
            const rpcSpawnMs = client.spawnMs;

            if (rpcSpawnMs === undefined) {
                throw new Error("Native RPC answered before its process spawn was observed");
            }

            nativeStartChannel.publish({
                verifyMs,
                validateMs,
                resourcesMs,
                helperMs,
                rpcSpawnMs,
                rpcInitializeMs: rpcReadyMs - rpcSpawnMs,
                rpcReadyMs,
                totalMs: performance.now() - started,
            } satisfies NativeStartSignal);
        }

        return client;
    } catch (error) {
        await client.close();

        throw error;
    }
}
