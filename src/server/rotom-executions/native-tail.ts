import { createHash } from "node:crypto";
import {
    constants,
    closeSync,
    fstatSync,
    existsSync,
    openSync,
    readSync,
    realpathSync,
} from "node:fs";
import { parseWithWork } from "../perf-channels.ts";
import type { KernelEntry } from "../rotom-journal.ts";
import type { RotomRpc } from "../rotom-rpc.ts";

/** A screenshot-bearing tool result can be large; a single record above this is refused, not truncated. */
const NATIVE_LINE_LIMIT = 64 * 1024 * 1024;
const NATIVE_TAIL_CACHE_LIMIT = 1024 * 1024;

/**
 * Native JSONL is an append-only prefix of get_entries. Read that prefix locally, then ask native
 * for its in-memory suffix and current leaf. This preserves unflushed custom entries and branches
 * without sending the whole image-heavy history through one bounded RPC record.
 * The native RPC limit still applies to a single event or an unflushed suffix.
 */
export async function readNativeSnapshot(
    kernel: Pick<RotomRpc, "request">,
    state: { sessionFile: string; sessionId: string },
    workspace: string,
    tail?: NativeTail,
): Promise<{ entries: KernelEntry[]; leafId: string | null }> {
    const persisted = existsSync(state.sessionFile)
        ? (tail
              ? tail.snapshot(state.sessionFile, state.sessionId, workspace)
              : new NativeTail(
                    state.sessionFile,
                    state.sessionId,
                    workspace,
                    "native-jsonl-snapshot",
                ).read()
          ).filter((entry) => entry.type !== "session")
        : [];
    const since = persisted.at(-1)?.id;
    const delta = (await kernel.request({ type: "get_entries", ...(since ? { since } : {}) })) as {
        entries: KernelEntry[];
        leafId: string | null;
    };

    return { entries: [...persisted, ...delta.entries], leafId: delta.leafId };
}

/** One complete snapshot of a native session file. */
function readNativeEntries(path: string, sessionId: string, workspace: string): KernelEntry[] {
    const tail = new NativeTail(path, sessionId, workspace, "native-jsonl-snapshot");
    const entries = tail.read();

    if (!tail.complete) {
        throw new Error("Incomplete native session tail");
    }

    return entries;
}

/**
 * Reads an append-only native session file incrementally: complete lines only, each checked once against the header
 * and the entry tree. A file that shrinks or a malformed line fails; a partial last line waits for the next read.
 */
export class NativeTail {
    readonly #path: string;
    readonly #sessionId: string;
    readonly #workspace: string;
    readonly #source: "native-jsonl-ingest" | "native-jsonl-snapshot";
    readonly #ids = new Set<string>();
    #cachedEntries: KernelEntry[] | undefined = [];
    readonly #prefixHash = createHash("sha256");
    #undelivered: KernelEntry[] = [];
    #offset = 0;
    #pending = Buffer.alloc(0);
    #header = false;
    constructor(
        path: string,
        sessionId: string,
        workspace: string,
        source: "native-jsonl-ingest" | "native-jsonl-snapshot" = "native-jsonl-ingest",
    ) {
        this.#path = path;
        this.#sessionId = sessionId;
        this.#workspace = workspace;
        this.#source = source;
    }

    /** True when the last read ended exactly at a line break. */
    get complete(): boolean {
        return this.#header && this.#pending.length === 0;
    }

    /** Newly validated entries for journal ingestion. Snapshot reads do not consume this delivery cursor. */
    read(): KernelEntry[] {
        this.#refresh();
        const entries = this.#undelivered;

        this.#undelivered = [];

        return entries;
    }

    /** Every validated complete entry, refreshing only the unread file suffix. */
    snapshot(
        path = this.#path,
        sessionId = this.#sessionId,
        workspace = this.#workspace,
    ): KernelEntry[] {
        if (path !== this.#path || sessionId !== this.#sessionId || workspace !== this.#workspace) {
            throw new Error("Native tail snapshot identity mismatch");
        }

        const fresh = () =>
            new NativeTail(
                this.#path,
                this.#sessionId,
                this.#workspace,
                "native-jsonl-snapshot",
            ).read();

        try {
            this.#refresh();
        } catch {
            // A fresh snapshot is authoritative even after a rewrite or malformed append. Preserve its exact
            // JSON/header/tree errors rather than replacing them with a cache-integrity error.
            return fresh();
        }

        if (this.#cachedEntries === undefined) {
            return fresh();
        }

        // Compare every byte, not size/mtime. If the append-only assumption fails, parse the entire file afresh,
        // just as the old snapshot did, including valid rewrites and malformed non-current branches.
        const fd = openSync(this.#path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const hash = createHash("sha256");
        let offset = 0;

        try {
            const stat = fstatSync(fd);

            if (stat.size < this.#offset) {
                return fresh();
            }

            while (offset < this.#offset) {
                const chunk = Buffer.alloc(Math.min(this.#offset - offset, 1024 * 1024));
                const bytes = readSync(fd, chunk, 0, chunk.length, offset);

                if (bytes === 0) {
                    return fresh();
                }

                hash.update(chunk.subarray(0, bytes));
                offset += bytes;
            }
        } finally {
            closeSync(fd);
        }

        if (hash.digest("hex") !== this.#prefixHash.copy().digest("hex")) {
            return fresh();
        }

        return [...this.#cachedEntries];
    }

    #refresh(): void {
        if (realpathSync(this.#path) !== this.#path) {
            throw new Error("Native session path changed");
        }

        const fd = openSync(this.#path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const chunks: Buffer[] = [this.#pending];

        try {
            const stat = fstatSync(fd);

            if (!stat.isFile() || stat.size < this.#offset) {
                throw new Error("Native session file was replaced or truncated");
            }

            while (this.#offset < stat.size) {
                const chunk = Buffer.alloc(Math.min(stat.size - this.#offset, 1024 * 1024));
                const read = readSync(fd, chunk, 0, chunk.length, this.#offset);

                if (read === 0) {
                    break;
                }

                this.#prefixHash.update(chunk.subarray(0, read));
                chunks.push(chunk.subarray(0, read));
                this.#offset += read;
            }
        } finally {
            closeSync(fd);
        }

        const buffer = Buffer.concat(chunks);
        const end = buffer.lastIndexOf(0x0a) + 1;

        this.#pending = buffer.subarray(end);

        if (this.#pending.length > NATIVE_LINE_LIMIT) {
            throw new Error("Native session line exceeds the import bound");
        }

        for (const line of buffer.subarray(0, end).toString("utf8").split("\n")) {
            if (line === "") {
                continue;
            }

            if (Buffer.byteLength(line) > NATIVE_LINE_LIMIT) {
                throw new Error("Native session line exceeds the import bound");
            }

            const entry = parseWithWork(this.#source, line) as KernelEntry;

            if (!this.#header) {
                if (
                    entry.type !== "session" ||
                    entry.version !== 3 ||
                    entry.id !== this.#sessionId ||
                    entry.cwd !== this.#workspace
                ) {
                    throw new Error("Native session header mismatch");
                }

                this.#header = true;
                this.#undelivered.push(entry);
                this.#cachedEntries?.push(entry);
                continue;
            }

            if (
                entry.type === "session" ||
                typeof entry.id !== "string" ||
                this.#ids.has(entry.id) ||
                (entry.parentId !== null &&
                    (typeof entry.parentId !== "string" || !this.#ids.has(entry.parentId)))
            ) {
                throw new Error("Native session tree is incomplete or inconsistent");
            }

            this.#ids.add(entry.id);
            this.#undelivered.push(entry);
            this.#cachedEntries?.push(entry);
        }

        if (this.#offset > NATIVE_TAIL_CACHE_LIMIT) {
            this.#cachedEntries = undefined;
        }
    }
}

export { readNativeEntries };
