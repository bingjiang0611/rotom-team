/** Experimental pinned rotom product boundary. Not yet connected to Pocket's Durable execution backend. */
import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
                      "--no-context-files",
                      "--no-skills",
                      "--no-prompt-templates",
                      "--append-system-prompt",
                      options.configuration.contextFile,
                      ...options.configuration.skills.flatMap((path) => ["--skill", path]),
                  ]
                : []),
            ...(options.sessionFile ? ["--session", options.sessionFile] : []),
            ...(options.gateFile
                ? ["--extension", fileURLToPath(new URL("./rotom-policy.mjs", import.meta.url))]
                : []),
        ],
        {
            cwd: workspace,
            env: {
                ...kernelNetworkEnvironment(process.env),
                HOME: home,
                // Coding tools need the service's developer toolchain (git, rg, package managers).
                PATH: `${dirname(node)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
                PI_COMPUTER_USE_HELPER_APP_PATH: resolveMacosHelperAppPath({ homeDir: homedir() }),
                ROTOM_NODE: node,
                PI_CODING_AGENT_DIR: join(home, ".pi/agent"),
                ROTOM_OBSERVABILITY: "0",
                LANG: "en_US.UTF-8",
                ...(options.gateFile ? { ROTOM_TEAM_KERNEL_GATE: options.gateFile } : {}),
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
