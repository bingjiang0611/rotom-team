/**
 * The daily performance journal: how long the running server takes for what people do, written to
 * `<data>/performance/` as JSON lines. It holds route shapes, event names, counts, sizes, and durations only, never
 * text, paths, ids, tokens, or anything a user wrote. It is local: nothing reads it but `npm run perf:report`.
 *
 * The active file is `performance-0.jsonl`. A full (or crash-truncated) one is renamed to a timestamped archive and
 * gzip-compressed off the write path; archives are capped by size, oldest first. Writing fails open: a broken disk
 * stops the journal with one log line, never the server.
 */
import { randomUUID } from "node:crypto";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { appendFile, mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { cpus, release } from "node:os";
import { basename, join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { APP_ROOT } from "./config.ts";
import {
    kernelRunChannel,
    type KernelRunSignal,
    pushChannel,
    type PushSignal,
} from "./perf-channels.ts";

export type PerformanceObservation =
    | { kind: "startup"; openMs: number; kernel: boolean }
    | {
          kind: "http";
          method: string;
          route: string;
          status: number;
          ms: number;
          /** Bytes the socket wrote for this answer, headers included; null when the socket was gone. */
          wireBytes: number | null;
      }
    | { kind: "kernel-run"; ms: number; outcome: string }
    | {
          kind: "push";
          intervalMs: number;
          /** Per event name: how many went out, and the bytes of those whose transport sized them. */
          events: Record<string, { count: number; sized: number; bytes: number }>;
      }
    | {
          kind: "process";
          intervalMs: number;
          eventLoopDelayMs: { p50: number; p99: number; max: number };
          /** Share of the interval the event loop was busy, 0 to 1. */
          eventLoopUtilization: number;
          cpuUserMs: number;
          cpuSystemMs: number;
          rssBytes: number;
          heapUsedBytes: number;
      }
    | { kind: "health"; droppedRecords: number; closed: true };

export interface PerformanceEnvironment {
    version: string;
    /** The release directory's commit, as deployments name it; null for a checkout. */
    release: string | null;
    platform: string;
    osRelease: string;
    arch: string;
    cpu: string;
    node: string;
}

export interface PerformanceRecord extends PerformanceEnvironment {
    schema: 1;
    session: string;
    recordedAt: string;
    observation: PerformanceObservation;
}

export function performanceEnvironment(): PerformanceEnvironment {
    const folder = basename(APP_ROOT);
    const { version } = JSON.parse(readFileSync(join(APP_ROOT, "package.json"), "utf8")) as {
        version: string;
    };

    return {
        version,
        release: /^[0-9a-f]{40}$/.test(folder) ? folder : null,
        platform: process.platform,
        osRelease: release(),
        arch: process.arch,
        cpu: `${cpus()[0]?.model ?? "unknown"} (${cpus().length} cores)`,
        node: process.versions.node,
    };
}

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

const WORD = /^[a-z][a-z-]{0,31}$/;

/**
 * A request path as a route shape, with nothing anyone typed in it: `/api/c/12/changes/diff?path=…` becomes
 * `/api/c/:n/changes/diff`. Only lowercase route words survive; ids, names, and file paths become placeholders, and
 * the web app's files are one `asset` route.
 */
export function routeShape(url: string): string {
    const parts = (url.split("?")[0] ?? "").split("/").filter((part) => part !== "");
    const word = (part: string | undefined) =>
        part === undefined ? [] : [WORD.test(part) ? part : /^\d+$/.test(part) ? ":n" : ":x"];

    if (parts[0] === "api") {
        if (parts[1] === "c") {
            const action = parts[3] === undefined ? [] : word(parts[3]);
            // The few fixed words after an action; anything else there is data (an entry id, a file name).
            const detail =
                parts[4] === undefined
                    ? []
                    : ["diff", "revert", "stop"].includes(parts[4])
                      ? [parts[4]]
                      : [":x"];

            return ["", "api", "c", ...word(parts[2]), ...action, ...detail].join("/");
        }

        return ["", "api", ...word(parts[1]), ...word(parts[2])].join("/");
    }

    if (parts.length === 0 || parts[0] === "s") {
        return "/app";
    }

    if (["a", "join", "login", "share", "vendor"].includes(parts[0]!)) {
        return `/${parts[0]}`;
    }

    return "/asset";
}

/** Requests held open for live events: their duration is how long a tab stayed, not how slow the server was. */
const HELD = new Set(["/api/events", "/api/poll"]);

type RequestStart = {
    request: IncomingMessage;
    response: ServerResponse;
    socket: Socket;
    server: Server;
};

/**
 * Start journaling the server `server` serves: request durations, pushed events, native runs, and the process's
 * event loop, CPU, and memory each minute. Call `stop` on shutdown: it takes a last sample and closes the journal.
 */
export async function startPerformanceJournal(options: {
    directory: string;
    server: Server;
    openMs: number;
    kernel: boolean;
    log: (line: string) => void;
    sampleMs?: number;
}): Promise<{ journal: PerformanceJournal; stop(): Promise<void> }> {
    const journal = new PerformanceJournal({
        directory: options.directory,
        environment: performanceEnvironment(),
        onError: () => options.log("The performance journal stopped: it could not write."),
    });

    await journal.open();
    journal.record({ kind: "startup", openMs: round(options.openMs), kernel: options.kernel });

    const started = new WeakMap<ServerResponse, { at: number; bytes: number }>();

    const onStart = (message: unknown) => {
        const { response, socket, server } = message as RequestStart;

        if (server === options.server) {
            started.set(response, { at: performance.now(), bytes: socket.bytesWritten });
        }
    };

    const onFinish = (message: unknown) => {
        const { request, response, socket, server } = message as RequestStart;
        const start = started.get(response);

        if (server !== options.server || start === undefined) {
            return;
        }

        const route = routeShape(request.url ?? "/");

        if (HELD.has(route)) {
            return;
        }

        journal.record({
            kind: "http",
            method: request.method ?? "GET",
            route,
            status: response.statusCode,
            ms: round(performance.now() - start.at),
            wireBytes: socket.destroyed ? null : socket.bytesWritten - start.bytes,
        });
    };

    let pushes: Record<string, { count: number; sized: number; bytes: number }> = {};

    const onPush = (message: unknown) => {
        const { event, bytes } = message as PushSignal;
        const tally = (pushes[event] ??= { count: 0, sized: 0, bytes: 0 });

        tally.count++;

        if (bytes !== null) {
            tally.sized++;
            tally.bytes += bytes;
        }
    };

    const onRun = (message: unknown) => {
        const { ms, outcome } = message as KernelRunSignal;

        journal.record({ kind: "kernel-run", ms: round(ms), outcome });
    };

    subscribe("http.server.request.start", onStart);
    subscribe("http.server.response.finish", onFinish);
    pushChannel.subscribe(onPush);
    kernelRunChannel.subscribe(onRun);

    const delay = monitorEventLoopDelay({ resolution: 20 });

    delay.enable();
    let lastAt = performance.now();
    let lastCpu = process.cpuUsage();
    let lastLoop = performance.eventLoopUtilization();

    const sample = () => {
        const now = performance.now();
        const cpu = process.cpuUsage(lastCpu);
        const loop = performance.eventLoopUtilization(lastLoop);
        const memory = process.memoryUsage();
        const intervalMs = round(now - lastAt);

        journal.record({
            kind: "process",
            intervalMs,
            eventLoopDelayMs: {
                p50: round(delay.percentile(50) / 1e6),
                p99: round(delay.percentile(99) / 1e6),
                max: round(delay.max / 1e6),
            },
            eventLoopUtilization: Math.round(loop.utilization * 1000) / 1000,
            cpuUserMs: round(cpu.user / 1000),
            cpuSystemMs: round(cpu.system / 1000),
            rssBytes: memory.rss,
            heapUsedBytes: memory.heapUsed,
        });

        if (Object.keys(pushes).length > 0) {
            journal.record({ kind: "push", intervalMs, events: pushes });
            pushes = {};
        }

        delay.reset();
        lastAt = now;
        lastCpu = process.cpuUsage();
        lastLoop = performance.eventLoopUtilization();
    };

    const timer = setInterval(sample, options.sampleMs ?? 60_000);

    timer.unref();

    return {
        journal,
        async stop() {
            clearInterval(timer);
            sample();
            delay.disable();
            unsubscribe("http.server.request.start", onStart);
            unsubscribe("http.server.response.finish", onFinish);
            pushChannel.unsubscribe(onPush);
            kernelRunChannel.unsubscribe(onRun);
            await journal.close();
        },
    };
}

const round = (ms: number) => Math.round(ms * 10) / 10;
