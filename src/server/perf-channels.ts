/**
 * Content-free performance signals, as Node diagnostics channels. Publishing costs one check while nobody subscribes.
 * The daily performance journal (`perf-journal.ts`) and the controlled benchmarks (`test/perf/`) subscribe. A message
 * carries names, counts, sizes, and durations only: never text, paths, ids, or anything a user wrote.
 */
import { channel } from "node:diagnostics_channel";

/** One event written to one browser tab. `bytes` is null where the transport does not size each event (long polling). */
export type PushSignal = { event: string; bytes: number | null; transport: "stream" | "poll" };

/**
 * One native kernel run, from its admission to its receipt; `outcome` is `<operation>:<status>`, or `error` when it threw.
 * A run that sent a prompt to the native process also says where its time went: `process` (a new native process, or
 * the session's running one), `dispatchMs` (admission to the prompt's dispatch), `firstOutputMs` (dispatch to the
 * model's first streamed output; null when none came), and `toolMs` (time with at least one tool running, so parallel
 * tools count once) over `tools` tool executions.
 */
export type KernelRunSignal = {
    ms: number;
    outcome: string;
    prompt?: {
        process: "started" | "reused";
        dispatchMs: number;
        firstOutputMs: number | null;
        toolMs: number;
        tools: number;
    };
};

/** What a browser tab waited for, from the person's action to the first paint that shows its result (`web/perf.js`). */
export const WEB_TIMINGS = [
    "open.home",
    "open.session",
    "switch",
    "send.shown",
    "reply.first",
] as const;

/** One wait in a browser tab: its duration, or why it was not measured (the tab was hidden, so it did not paint). */
export type WebTimingSignal = {
    name: (typeof WEB_TIMINGS)[number];
    transport: "stream" | "poll";
} & ({ ms: number } | { unavailable: "hidden" });

/** At most this many timings per report; the tab sends more in another. */
export const WEB_TIMING_BATCH = 20;

/** The longest wait a tab may report: longer is a stale measurement, not a wait. */
const WEB_TIMING_MAX_MS = 10 * 60_000;

/**
 * Read a tab's report. The tab is not trusted: every field is checked against the closed set it may hold, so nothing
 * else (text, ids) can reach the journal. Null for anything else.
 */
export function parseWebTimings(body: unknown): WebTimingSignal[] | null {
    const timings = (body as { timings?: unknown } | null)?.timings;

    if (!Array.isArray(timings) || timings.length === 0 || timings.length > WEB_TIMING_BATCH) {
        return null;
    }

    const parsed: WebTimingSignal[] = [];

    for (const item of timings as Record<string, unknown>[]) {
        const keys = Object.keys(item ?? {})
            .sort()
            .join(",");
        const name = WEB_TIMINGS.find((each) => each === item?.name);
        const transport = item?.transport;

        if (name === undefined || (transport !== "stream" && transport !== "poll")) {
            return null;
        }

        if (
            keys === "ms,name,transport" &&
            typeof item.ms === "number" &&
            Number.isFinite(item.ms) &&
            item.ms >= 0 &&
            item.ms <= WEB_TIMING_MAX_MS
        ) {
            parsed.push({ name, transport, ms: Math.round(item.ms * 10) / 10 });
        } else if (keys === "name,transport,unavailable" && item.unavailable === "hidden") {
            parsed.push({ name, transport, unavailable: "hidden" });
        } else {
            return null;
        }
    }

    return parsed;
}

export const pushChannel = channel("rotom-team:push");
export const kernelRunChannel = channel("rotom-team:kernel-run");
export const webTimingChannel = channel("rotom-team:web");
