/**
 * The pinned rotom product's identity and the few native modules the team's resource checks need, without the native
 * process client (`rotom-kernel.ts`), its model library or its RPC. The validator a subagent start runs imports only
 * this, so each start loads less; the checks are the same.
 */
import { createHash } from "node:crypto";
import { accessSync, constants, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseWithWork, withParseWork } from "./perf-channels.ts";

export const runtime = fileURLToPath(new URL("../../runtime/rotom/", import.meta.url));
export const product = join(runtime, "node_modules/@bingjiang0611/rotom");

const bootstrapFiles = [
    "package.json",
    "bin/rotom",
    "bin/rotom-launcher",
    "runtime/launch-runtime.mjs",
    "runtime/product-config.mjs",
    "runtime/resolve-installed-pi.mjs",
    "runtime/verify-pi-runtime.mjs",
];

export function canonical(path: string, kind: "file" | "directory"): string {
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
    const pin = parseWithWork("native-pin", readFileSync(join(runtime, "pin.json"), "utf8"));
    const pkg = parseWithWork("native-pin", readFileSync(join(product, "package.json"), "utf8"));
    const lock = parseWithWork(
        "native-pin",
        readFileSync(join(runtime, "package-lock.json"), "utf8"),
    );
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

/**
 * The native settings, package and context loaders the team's resource policy uses, from the verified product: the
 * same identity checks (`verifyRotomKernel`, the product's own Pi resolution) and canonical module paths as
 * `nativeConfigurationApi`, without its other modules.
 */
export async function nativeResourcePolicyApi() {
    verifyRotomKernel();
    const { resolveInstalledPi } = await import(
        pathToFileURL(join(product, "runtime/resolve-installed-pi.mjs")).href
    );

    await withParseWork("native-resolver", () => resolveInstalledPi(product));
    const root = join(product, "runtime/pi/node_modules/@earendil-works/pi-coding-agent/dist");
    const settings = await import(
        pathToFileURL(canonical(join(root, "core/settings-manager.js"), "file")).href
    );
    const packages = await import(
        pathToFileURL(canonical(join(root, "core/package-manager.js"), "file")).href
    );
    const resourceLoader = await import(pathToFileURL(join(root, "core/resource-loader.js")).href);

    return {
        loadProjectContextFiles: resourceLoader.loadProjectContextFiles,
        DefaultPackageManager: packages.DefaultPackageManager,
        SettingsManager: settings.SettingsManager,
    };
}

/** Pinned session-file operations only, without the process client or the model-provider library. */
export async function nativeSessionDataApi() {
    verifyRotomKernel();
    const { resolveInstalledPi } = await import(
        pathToFileURL(join(product, "runtime/resolve-installed-pi.mjs")).href
    );

    await withParseWork("native-resolver", () => resolveInstalledPi(product));
    const entry = canonical(
        join(
            product,
            "runtime/pi/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js",
        ),
        "file",
    );

    return import(pathToFileURL(entry).href);
}
