/**
 * Content-free performance signals, as Node diagnostics channels. Publishing costs one check while nobody subscribes.
 * The daily performance journal (`perf-journal.ts`) and the controlled benchmarks (`test/perf/`) subscribe. A message
 * carries names, counts, sizes, and durations only: never text, paths, ids, or anything a user wrote.
 */
import { AsyncLocalStorage } from "node:async_hooks";
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
    "send.echoed",
    "send.shown",
    "send.arrived",
    "send.answered",
    "reply.arrived",
    "reply.first",
] as const;

/** One wait in a browser tab: its duration, or why it was not measured (the tab was hidden, so it did not paint). */
export type WebTimingSignal = {
    name: (typeof WEB_TIMINGS)[number];
    transport: "stream" | "poll";
} & ({ ms: number } | { unavailable: "hidden" });

/** Why one remote tab chose or left long polling. Content-free; no URL, id, path, text or network address. */
export const TRANSPORT_TRANSITIONS = [
    "stream-initial-timeout",
    "poll-hourly-reprobe",
    "poll-reprobe-visible",
    "poll-reprobe-online",
    "stream-initial-complete",
] as const;

export type TransportSignal = {
    transition: (typeof TRANSPORT_TRANSITIONS)[number];
    from: "stream" | "poll";
    to: "stream" | "poll";
};

/** Read a tab's content-free transport transition. Null for any extra or unknown field. */
export function parseTransportSignal(body: unknown): TransportSignal | null {
    const item = body as Record<string, unknown> | null;
    const keys = Object.keys(item ?? {})
        .sort()
        .join(",");
    const transition = TRANSPORT_TRANSITIONS.find((each) => each === item?.transition);
    const from = item?.from;
    const to = item?.to;

    return keys === "from,to,transition" &&
        transition !== undefined &&
        (from === "stream" || from === "poll") &&
        (to === "stream" || to === "poll") &&
        from !== to
        ? { transition, from, to }
        : null;
}

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

/** Successful cold native startup phases; content-free and published only while a benchmark subscribes. */
export type NativeStartSignal = {
    verifyMs: number;
    validateMs: number;
    resourcesMs: number;
    helperMs: number;
    rpcSpawnMs: number;
    rpcInitializeMs: number;
    rpcReadyMs: number;
    totalMs: number;
};

export type ViewProjectionSignal = {
    entryVisits?: number;
    clientEntryScans?: number;
    statsEntryScans?: number;
    fieldStringifyCalls?: number;
    fieldStringifyChars?: number;
};

export type RoomPartSignal = {
    part: "live" | "inbox" | "kernel";
    ms?: number;
};
export const roomPartChannel = channel("rotom-team:room-part");

export type ParseWork =
    | "durable-storage"
    | "journal"
    | "journal-history"
    | "journal-thinking"
    | "journal-segments"
    | "native-readback"
    | "native-rpc"
    | "native-rpc-record"
    | "native-rpc-notify"
    | "native-jsonl"
    | "native-jsonl-ingest"
    | "native-jsonl-snapshot"
    | "native-gate"
    | "native-pin"
    | "native-resolver"
    | "native-settings"
    | "http";
/** The benchmark subscribes only to enable bounded source attribution; no content is published. */
export const parseWorkChannel = channel("rotom-team:parse-work");
const parseWork = new AsyncLocalStorage<ParseWork>();

export function withParseWork<T>(scope: ParseWork, work: () => T): T {
    return parseWorkChannel.hasSubscribers ? parseWork.run(scope, work) : work();
}

export const currentParseWork = (): ParseWork | undefined => parseWork.getStore();

/** Wrap method bodies without changing production objects when no performance subscriber exists. */
export function scopedParseObject<T extends object>(scope: ParseWork, target: T): T {
    if (!parseWorkChannel.hasSubscribers) {
        return target;
    }

    const methods = new Map<PropertyKey, (...args: unknown[]) => unknown>();

    return new Proxy(target, {
        get(object, key) {
            const value = Reflect.get(object, key, object) as unknown;

            if (typeof value !== "function") {
                return value;
            }

            let wrapped = methods.get(key);

            if (!wrapped) {
                // Nested calls retain their outer method's scope (methods run on the original receiver).
                const journalScopes: Record<string, ParseWork> = {
                    entries: "journal-history",
                    thinkingLevel: "journal-thinking",
                    segmentEntries: "journal-segments",
                };
                const methodScope =
                    scope === "journal" && typeof key === "string"
                        ? (journalScopes[key] ?? scope)
                        : scope;

                wrapped = (...args: unknown[]) =>
                    withParseWork(methodScope, () => Reflect.apply(value, object, args));
                methods.set(key, wrapped);
            }

            return wrapped;
        },
    });
}

export function parseWithWork(scope: ParseWork, text: string): ReturnType<typeof JSON.parse> {
    return withParseWork(scope, () => JSON.parse(text));
}

export const pushChannel = channel("rotom-team:push");
export const kernelRunChannel = channel("rotom-team:kernel-run");
export const nativeStartChannel = channel("rotom-team:native-start");
export const viewProjectionChannel = channel("rotom-team:view-projection");
export const webTimingChannel = channel("rotom-team:web");
export const transportChannel = channel("rotom-team:web-transport");
