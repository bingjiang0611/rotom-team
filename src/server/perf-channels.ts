/**
 * Content-free performance signals, as Node diagnostics channels. Publishing costs one check while nobody subscribes.
 * The daily performance journal (`perf-journal.ts`) and the controlled benchmarks (`test/perf/`) subscribe. A message
 * carries names, counts, sizes, and durations only: never text, paths, ids, or anything a user wrote.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";

/** One event written to one browser tab. `bytes` is null where the transport does not size each event (long polling). */
export type PushSignal = { event: string; bytes: number | null; transport: "stream" | "poll" };

/** One native kernel run, from its admission to its receipt; `outcome` is `<operation>:<status>`, or `error` when it threw. */
export type KernelRunSignal = { ms: number; outcome: string };

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
