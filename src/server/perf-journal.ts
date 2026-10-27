/**
 * The daily performance journal: how long the running server takes for what people do, written to
 * `<data>/performance/` as JSON lines. It holds route shapes, event names, counts, sizes, and durations only, never
 * text, paths, raw ids, tokens, or anything a user wrote. A process-local opaque tag can join send phases.
 * It is local: nothing reads it but `npm run perf:report`.
 *
 * The active file is `performance-0.jsonl`. A full (or crash-truncated) one is renamed to a timestamped archive and
 * gzip-compressed off the write path; archives are capped by size, oldest first. Writing fails open: a broken disk
 * stops the journal with one log line, never the server.
 */
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { readFileSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Http2SecureServer, IncomingHttpHeaders, ServerHttp2Stream } from "node:http2";
import type { Socket } from "node:net";
import { cpus, release } from "node:os";
import { basename, join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { APP_ROOT } from "./config.ts";
import { PerformanceJournal } from "./perf-journal-store.ts";
export { PerformanceJournal } from "./perf-journal-store.ts";
export type { JournalOptions } from "./perf-journal-store.ts";
import { sendPhaseChannel, type SendPhaseSignal } from "./send-trace.ts";
import {
    kernelRunChannel,
    type KernelRunSignal,
    pushChannel,
    type PushSignal,
    transportChannel,
    type TransportSignal,
    webTimingChannel,
    type WebTimingSignal,
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
    | ({ kind: "kernel-run" } & KernelRunSignal)
    | ({ kind: "web" } & WebTimingSignal)
    | ({ kind: "send-phase" } & SendPhaseSignal)
    | ({ kind: "transport" } & TransportSignal)
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

/**
 * Requests held open for live events: their duration is how long a tab stayed, not how slow the server was. A tab's
 * timing report is recorded as the `web` waits it carries instead.
 */
const HELD = new Set(["/api/events", "/api/poll", "/api/perf", "/api/perf-transport"]);

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
    server: Server | Http2SecureServer;
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

    // HTTP/2 has separate diagnostics. Connection byte deltas cannot be assigned to an individual multiplexed
    // stream: leave them unavailable, never zero or the connection's unrelated traffic. Keep the same record schema.
    const h2Started = new WeakMap<
        ServerHttp2Stream,
        { at: number; route: string; method: string }
    >();

    const onH2Start = (message: unknown) => {
        const { stream, headers } = message as {
            stream: ServerHttp2Stream;
            headers: IncomingHttpHeaders;
        };
        const socket = stream.session?.socket as (Socket & { server?: unknown }) | undefined;

        if (socket?.server === options.server) {
            const route = routeShape(String(headers[":path"] ?? "/"));

            if (!HELD.has(route)) {
                h2Started.set(stream, {
                    at: performance.now(),
                    route,
                    method: String(headers[":method"] ?? "GET"),
                });
            }
        }
    };

    const onH2Finish = (message: unknown) => {
        const { stream } = message as { stream: ServerHttp2Stream };
        const start = h2Started.get(stream);
        const status = stream.sentHeaders?.[":status"];

        if (start !== undefined && typeof status === "number") {
            h2Started.delete(stream);
            journal.record({
                kind: "http",
                method: start.method,
                route: start.route,
                status,
                ms: round(performance.now() - start.at),
                wireBytes: null,
            });
        }
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
        const { ms, outcome, prompt } = message as KernelRunSignal;

        journal.record({
            kind: "kernel-run",
            ms: round(ms),
            outcome,
            ...(prompt
                ? {
                      prompt: {
                          process: prompt.process,
                          dispatchMs: round(prompt.dispatchMs),
                          firstOutputMs:
                              prompt.firstOutputMs === null ? null : round(prompt.firstOutputMs),
                          toolMs: round(prompt.toolMs),
                          tools: prompt.tools,
                      },
                  }
                : {}),
        });
    };

    // Already checked against its closed set where the tab's report arrived (`parseWebTimings`).
    const onWeb = (message: unknown) =>
        journal.record({ kind: "web", ...(message as WebTimingSignal) });

    const onSend = (message: unknown) => {
        const signal = message as SendPhaseSignal;

        journal.record({ ...signal, kind: "send-phase", atMs: round(signal.atMs) });
    };

    const onTransport = (message: unknown) =>
        journal.record({ kind: "transport", ...(message as TransportSignal) });

    subscribe("http.server.request.start", onStart);
    subscribe("http.server.response.finish", onFinish);
    subscribe("http2.server.stream.start", onH2Start);
    subscribe("http2.server.stream.finish", onH2Finish);
    pushChannel.subscribe(onPush);
    kernelRunChannel.subscribe(onRun);
    webTimingChannel.subscribe(onWeb);
    sendPhaseChannel.subscribe(onSend);
    transportChannel.subscribe(onTransport);

    // The histogram records the time between its timer's ticks, so every sample includes the sampling interval: an idle
    // loop reads about 20 ms. The journal records the delay beyond it.
    const resolutionMs = 20;
    const delay = monitorEventLoopDelay({ resolution: resolutionMs });
    const beyondResolution = (ns: number) => round(Math.max(0, ns / 1e6 - resolutionMs));

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
                p50: beyondResolution(delay.percentile(50)),
                p99: beyondResolution(delay.percentile(99)),
                max: beyondResolution(delay.max),
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
            unsubscribe("http2.server.stream.start", onH2Start);
            unsubscribe("http2.server.stream.finish", onH2Finish);
            pushChannel.unsubscribe(onPush);
            kernelRunChannel.unsubscribe(onRun);
            webTimingChannel.unsubscribe(onWeb);
            sendPhaseChannel.unsubscribe(onSend);
            transportChannel.unsubscribe(onTransport);
            await journal.close();
        },
    };
}

const round = (ms: number) => Math.round(ms * 10) / 10;
