import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

export function nativeHome(dataDir: string, memberId: string): string {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(memberId)) {
        throw new Error("Invalid native member identity");
    }

    const parent = join(dataDir, "kernel-homes");

    for (const path of [parent, join(parent, memberId)]) {
        mkdirSync(path, { recursive: true, mode: 0o700 });

        if (
            realpathSync(path) !== path ||
            !lstatSync(path).isDirectory() ||
            lstatSync(path).mode & 0o077
        ) {
            throw new Error("Native HOME must be canonical and private");
        }
    }

    return join(parent, memberId);
}
