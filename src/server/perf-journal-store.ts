import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import type {
    PerformanceEnvironment,
    PerformanceObservation,
    PerformanceRecord,
} from "./perf-journal.ts";

const ACTIVE_FILE = "performance-0.jsonl";
const ARCHIVE_RE = /^performance-\d{8}T\d{9}Z-[0-9a-f]{8}\.jsonl(?:\.gz)?$/;
const archiveStamp = (date: Date): string =>
    `${date.toISOString().replace(/[-:.]/g, "")}-${randomUUID().slice(0, 8)}`;

export interface JournalOptions {
    directory: string;
    environment: PerformanceEnvironment;
    maxFileBytes?: number;
    maxArchiveBytes?: number;
    maxQueueBytes?: number;
    flushMs?: number;
    onError: () => void;
}

/** A bounded queue, one active file, and byte-capped compressed archives. */
export class PerformanceJournal {
    readonly #session = randomUUID();
    readonly #options: JournalOptions;
    readonly #pending: string[] = [];
    #pendingBytes = 0;
    #size = 0;
    #writing: Promise<void> | null = null;
    #timer: NodeJS.Timeout | undefined;
    #closed = false;
    #failed = false;
    #dropped = 0;
    /** Compression and pruning run one at a time, and never hold up appends to the active file. */
    #archiving: Promise<void> = Promise.resolve();

    constructor(options: JournalOptions) {
        this.#options = options;
    }

    get #maxFileBytes(): number {
        return this.#options.maxFileBytes ?? 5 * 1024 * 1024;
    }

    get #maxArchiveBytes(): number {
        return this.#options.maxArchiveBytes ?? 64 * 1024 * 1024;
    }

    get #activeFile(): string {
        return join(this.#options.directory, ACTIVE_FILE);
    }

    get status(): { dropped: number; failed: boolean; queuedBytes: number } {
        return { dropped: this.#dropped, failed: this.#failed, queuedBytes: this.#pendingBytes };
    }

    async open(): Promise<void> {
        await mkdir(this.#options.directory, { recursive: true, mode: 0o700 });

        try {
            this.#size = (await stat(this.#activeFile)).size;

            if (this.#size > 0) {
                const file = await open(this.#activeFile, "r");
                const last = Buffer.alloc(1);

                try {
                    await file.read(last, 0, 1, this.#size - 1);
                } finally {
                    await file.close();
                }

                // A crash-truncated tail stays for the report, but a new record never joins it.
                if (last[0] !== 10 || this.#size > this.#maxFileBytes) {
                    await this.#rotate();
                }
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
            }
        }

        // Finishes archives a crash left uncompressed.
        this.#scheduleArchiving();
        this.#timer = setInterval(() => void this.flush(), this.#options.flushMs ?? 5_000);
        this.#timer.unref();
    }

    record(observation: PerformanceObservation): void {
        if (this.#closed || this.#failed) {
            return;
        }

        const record: PerformanceRecord = {
            schema: 1,
            ...this.#options.environment,
            session: this.#session,
            recordedAt: new Date().toISOString(),
            observation,
        };
        const line = `${JSON.stringify(record)}\n`;
        const bytes = Buffer.byteLength(line);

        if (
            bytes > this.#maxFileBytes ||
            this.#pendingBytes + bytes > (this.#options.maxQueueBytes ?? 256 * 1024)
        ) {
            this.#dropped++;

            return;
        }

        this.#pending.push(line);
        this.#pendingBytes += bytes;
    }

    flush(): Promise<void> {
        if (this.#writing) {
            return this.#writing;
        }

        if (this.#failed || this.#pending.length === 0) {
            return Promise.resolve();
        }

        const lines = this.#pending.splice(0);

        this.#pendingBytes = 0;
        this.#writing = (async () => {
            for (const line of lines) {
                const bytes = Buffer.byteLength(line);

                if (this.#size + bytes > this.#maxFileBytes) {
                    await this.#rotate();
                }

                await appendFile(this.#activeFile, line, { mode: 0o600 });
                this.#size += bytes;
            }
        })()
            .catch(() => this.#fail())
            .finally(() => {
                this.#writing = null;
            });

        return this.#writing;
    }

    async close(): Promise<void> {
        if (this.#closed) {
            return;
        }

        clearInterval(this.#timer);
        await this.#writing;
        // Loss evidence goes in even when the process stops before the next sample.
        this.record({ kind: "health", droppedRecords: this.#dropped, closed: true });
        this.#closed = true;
        await this.flush();
        await this.#archiving;
    }

    async #rotate(): Promise<void> {
        try {
            await rename(
                this.#activeFile,
                join(this.#options.directory, `performance-${archiveStamp(new Date())}.jsonl`),
            );
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
            }
        }

        this.#size = 0;
        this.#scheduleArchiving();
    }

    #scheduleArchiving(): void {
        this.#archiving = this.#archiving.then(() => this.#archive()).catch(() => this.#fail());
    }

    async #archive(): Promise<void> {
        const directory = this.#options.directory;
        const names = await readdir(directory);

        for (const name of names) {
            if (name.startsWith("performance-") && name.endsWith(".gz.partial")) {
                await rm(join(directory, name), { force: true });
            }
        }

        for (const name of names.filter(
            (each) => ARCHIVE_RE.test(each) && each.endsWith(".jsonl"),
        )) {
            const source = join(directory, name);
            const target = join(directory, `${name}.gz`);
            const partial = `${target}.partial`;

            await pipeline(
                createReadStream(source),
                createGzip(),
                createWriteStream(partial, { mode: 0o600 }),
            );
            await rename(partial, target);
            await rm(source, { force: true });
        }

        // The stamp sorts by time, so the oldest archives go first. Only compressed ones count: a file rotated while this
        // pass ran is still uncompressed, its own pass is queued, and counting it could prune it before it is kept.
        const archives = (await readdir(directory))
            .filter((name) => ARCHIVE_RE.test(name) && name.endsWith(".gz"))
            .sort();
        const sizes = await Promise.all(
            archives.map(async (name) => (await stat(join(directory, name))).size),
        );
        let total = sizes.reduce((sum, size) => sum + size, 0);

        for (let index = 0; index < archives.length && total > this.#maxArchiveBytes; index++) {
            await rm(join(directory, archives[index]!), { force: true });
            total -= sizes[index]!;
        }
    }

    #fail(): void {
        if (this.#failed) {
            return;
        }

        this.#failed = true;
        this.#pending.length = 0;
        this.#pendingBytes = 0;
        this.#options.onError();
    }
}
