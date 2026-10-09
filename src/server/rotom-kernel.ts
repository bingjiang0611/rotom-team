/** Experimental pinned rotom product boundary. Not yet connected to Pocket's Durable execution backend. */
import { createHash } from "node:crypto";
import { accessSync, constants, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
        pin.version !== "0.1.14" ||
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

/** Caller owns a private HOME and a stopped/authorized session. No ambient credential or user-extension inheritance. */
export async function startRotomKernel(options: {
    home: string;
    workspace: string;
    provider: string;
    model: string;
}): Promise<RotomRpc> {
    const { executable } = verifyRotomKernel();
    const home = canonical(options.home, "directory"),
        workspace = canonical(options.workspace, "directory");

    if (lstatSync(home).mode & 0o077) {
        throw new Error("Kernel HOME must be private (0700)");
    }

    const node = realpathSync(process.execPath);
    const client = new RotomRpc(
        executable,
        [
            "--mode",
            "rpc",
            "--provider",
            options.provider,
            "--model",
            options.model,
            "--tools",
            "read,write,edit,bash",
            "--no-mcp",
        ],
        {
            cwd: workspace,
            env: {
                HOME: home,
                PATH: `${dirname(node)}:/usr/bin:/bin`,
                ROTOM_NODE: node,
                PI_CODING_AGENT_DIR: join(home, ".pi/agent"),
                ROTOM_OBSERVABILITY: "0",
                LANG: "en_US.UTF-8",
            },
        },
    );

    try {
        const state = (await client.request({ type: "get_state" })) as {
            model?: { provider: string; id: string };
            isStreaming?: boolean;
        };

        if (
            state.model?.provider !== options.provider ||
            state.model.id !== options.model ||
            state.isStreaming !== false
        ) {
            throw new Error("Kernel startup model/state mismatch; no fallback allowed");
        }

        await client.request({ type: "set_auto_retry", enabled: false });
        await client.request({ type: "set_auto_compaction", enabled: false });

        return client;
    } catch (error) {
        await client.close();

        throw error;
    }
}
