/**
 * Watches a session's repository for changes, so tabs showing Changes read it again when something moved instead of
 * on a timer. One watch per folder, shared by every session in it; it tells its listeners only that something moved,
 * never what: each tab then asks `GET changes`, which checks who may see what on every request.
 *
 * Recursive watching is cheap only where the system provides it (FSEvents on macOS, ReadDirectoryChangesW on
 * Windows). Elsewhere Node would add a watch for every folder, node_modules included, so `watching` is false there and
 * tabs keep reading after each entry, as before. Watches can miss events (network file systems, a full event queue):
 * tabs also read slowly on a timer either way.
 */
import { type FSWatcher, lstatSync, watch } from "node:fs";
import { dirname, join, sep } from "node:path";
import { gitDirOf } from "./branches.ts";

/** How long after the last event a change is told, and the longest a stream of events delays it. */
const SETTLE_MS = 300;
const MAX_DELAY_MS = 2000;

/** Recursive watching that does not walk the tree itself. */
const RECURSIVE = process.platform === "darwin" || process.platform === "win32";

/**
 * Git's own bookkeeping that changes nothing Changes shows: new objects, reflogs, and the locks around its writes.
 * `inGitDir`: `file` is relative to a git folder watched by itself (a linked worktree's), else to the top folder.
 */
function ignored(file: string | null, inGitDir: boolean): boolean {
    if (file === null) {
        return false;
    }

    const path = file.split(sep).join("/");
    const git = inGitDir ? path : path.startsWith(".git/") ? path.slice(".git/".length) : undefined;

    return (
        git !== undefined &&
        (git.startsWith("objects/") || git.startsWith("logs/") || git.endsWith(".lock"))
    );
}

/** The repository's top folder: the nearest folder up from `cwd` with a `.git` entry; undefined in none. */
function topOf(cwd: string): string | undefined {
    for (let folder = cwd; ; folder = dirname(folder)) {
        try {
            if (lstatSync(join(folder, ".git"), { throwIfNoEntry: false }) !== undefined) {
                return folder;
            }
        } catch {
            return undefined;
        }

        if (dirname(folder) === folder) {
            return undefined;
        }
    }
}

export type ChangeWatch = {
    /** Whether a change in the folder is told: false when unsupported here or after the watch failed. */
    readonly watching: boolean;
    close(): void;
};

type Folder = {
    watchers: FSWatcher[];
    listeners: Set<(watching: boolean) => void>;
    watching: boolean;
    timer: NodeJS.Timeout | undefined;
    firstAt: number;
};

export class ChangeWatches {
    readonly #folders = new Map<string, Folder>();
    readonly #recursive: boolean;

    constructor(recursive = RECURSIVE) {
        this.#recursive = recursive;
    }

    /** Folders watched now, for tests and diagnostics. */
    get size(): number {
        return this.#folders.size;
    }

    /**
     * Call `onChange(watching)` a moment after something changes in the repository `cwd` is in (or once with false when
     * the watch fails). Outside a repository only Pi's edits, which tabs see as entries, change Changes: nothing to
     * watch, and `watching` is true.
     */
    watch(cwd: string, onChange: (watching: boolean) => void): ChangeWatch {
        const top = topOf(cwd);

        if (top === undefined) {
            return { watching: true, close: () => {} };
        }

        let folder = this.#folders.get(top);

        if (folder === undefined) {
            folder = this.#open(top, cwd);
            this.#folders.set(top, folder);
        }

        const kept = folder;

        kept.listeners.add(onChange);

        return {
            get watching() {
                return kept.watching;
            },
            close: () => {
                kept.listeners.delete(onChange);

                if (kept.listeners.size === 0 && this.#folders.get(top) === kept) {
                    this.#stop(kept);
                    this.#folders.delete(top);
                }
            },
        };
    }

    close(): void {
        for (const folder of this.#folders.values()) {
            this.#stop(folder);
        }

        this.#folders.clear();
    }

    #open(top: string, cwd: string): Folder {
        const folder: Folder = {
            watchers: [],
            listeners: new Set(),
            watching: this.#recursive,
            timer: undefined,
            firstAt: 0,
        };

        if (!this.#recursive) {
            return folder;
        }

        // A linked worktree keeps HEAD and its index in the main repository's git folder.
        const gitDir = gitDirOf(cwd);
        const places =
            gitDir === undefined || gitDir.startsWith(`${top}${sep}`) ? [top] : [top, gitDir];

        const failed = () => {
            if (!folder.watching) {
                return;
            }

            this.#stop(folder);
            folder.watching = false;

            for (const listener of folder.listeners) {
                listener(false);
            }
        };

        try {
            for (const place of places) {
                const inGitDir = place !== top;
                const watcher = watch(place, { recursive: true, persistent: false }, (_, file) => {
                    if (!ignored(typeof file === "string" ? file : null, inGitDir)) {
                        this.#moved(folder);
                    }
                });

                watcher.on("error", failed);
                folder.watchers.push(watcher);
            }
        } catch {
            this.#stop(folder);
            folder.watching = false;
        }

        return folder;
    }

    #moved(folder: Folder): void {
        const now = Date.now();

        if (folder.timer === undefined) {
            folder.firstAt = now;
        }

        clearTimeout(folder.timer);
        folder.timer = setTimeout(
            () => {
                folder.timer = undefined;

                for (const listener of folder.listeners) {
                    listener(folder.watching);
                }
            },
            Math.max(0, Math.min(SETTLE_MS, folder.firstAt + MAX_DELAY_MS - now)),
        );
        folder.timer.unref();
    }

    #stop(folder: Folder): void {
        clearTimeout(folder.timer);
        folder.timer = undefined;

        for (const watcher of folder.watchers) {
            watcher.close();
        }

        folder.watchers = [];
    }
}
