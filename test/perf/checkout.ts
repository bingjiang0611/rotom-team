/**
 * Every measured run happens in a temporary checkout, never in the developer's own folder.
 *
 * Why: the server's data carries the checkout's path (bundled extensions, skills, and commands are listed by where they
 * are), so character and byte counters change with the path's length. Two runs compare only when their checkouts sit
 * at paths of one length. These checkouts are `<real tmpdir>/rotom-team-perf-checkout-XXXXXX`: one length on one machine,
 * and the ledger keeps baselines per platform.
 */
import { execFileSync } from "node:child_process";
import {
    cpSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
    }).trim();
const lines = (text: string) => text.split("\0").filter((each) => each !== "");

/** Copy the complete on-disk change, including changes already staged for commit. */
export function copyWorkingTree(repo: string, target: string): void {
    // --no-renames keeps both ends of a move explicit; the target starts at HEAD.
    for (const file of lines(
        git(repo, "diff", "--no-renames", "--name-only", "--diff-filter=D", "-z", "HEAD"),
    )) {
        rmSync(join(target, file), { force: true });
    }

    const changed = [
        ...lines(git(repo, "diff", "--no-renames", "--name-only", "--diff-filter=d", "-z", "HEAD")),
        ...lines(git(repo, "ls-files", "-z", "--others", "--exclude-standard")),
    ];

    for (const file of changed) {
        const destination = join(target, file);

        mkdirSync(dirname(destination), { recursive: true });
        cpSync(join(repo, file), destination);
    }
}

/**
 * Check `commit` out into a temporary folder and make it runnable.
 *
 * - `workingTree`: also carry this checkout's uncommitted edits, new files, and deletions (to measure what is on disk).
 * - Always: put this checkout's benchmark (`test/perf/`, `test/helpers.ts`) in, so every side is measured by one
 *   instrument.
 * - Root dependencies are shared with this checkout when the lock file and runtime patch list agree, and installed
 *   otherwise. The rotom kernel is always installed: its trust check refuses a kernel reached through a symbolic link,
 *   and that check is part of what runs. npm serves an unchanged lock from its cache.
 */
export function prepareCheckout(commit: string, options: { workingTree: boolean }): string {
    // Canonical: macOS reaches its temporary folder through /var -> /private/var, and the kernel check compares real
    // paths.
    const path = realpathSync(mkdtempSync(join(tmpdir(), "rotom-team-perf-checkout-")));

    git(REPO, "worktree", "add", "--detach", "--force", path, commit);

    try {
        if (options.workingTree) {
            copyWorkingTree(REPO, path);
        }

        rmSync(join(path, "test", "perf"), { recursive: true, force: true });
        cpSync(join(REPO, "test", "perf"), join(path, "test", "perf"), { recursive: true });
        cpSync(join(REPO, "test", "helpers.ts"), join(path, "test", "helpers.ts"));

        const same = ["package-lock.json", "vendor/pi-durable/patches.json"].every(
            (file) =>
                readFileSync(join(REPO, file), "utf8") === readFileSync(join(path, file), "utf8"),
        );

        if (same) {
            symlinkSync(join(REPO, "node_modules"), join(path, "node_modules"), "dir");
        } else {
            console.error("This revision installs other dependencies: installing them.");
            execFileSync("npm", ["ci"], { cwd: path, stdio: "inherit" });
        }

        execFileSync("npm", ["run", "install:kernel"], { cwd: path, stdio: "inherit" });
    } catch (error) {
        removeCheckout(path);

        throw error;
    }

    return path;
}

export function removeCheckout(path: string) {
    git(REPO, "worktree", "remove", "--force", path);
    rmSync(path, { recursive: true, force: true });
}
