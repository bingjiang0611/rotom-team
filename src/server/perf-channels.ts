/**
 * Content-free performance signals, as Node diagnostics channels. Publishing costs one check while nobody subscribes.
 * The daily performance journal (`perf-journal.ts`) and the controlled benchmarks (`test/perf/`) subscribe. A message
 * carries names, counts, sizes, and durations only: never text, paths, ids, or anything a user wrote.
 */
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

export type RoomPartSignal = { part: "live" | "inbox" | "kernel"; ms: number };
export const roomPartChannel = channel("rotom-team:room-part");

export const pushChannel = channel("rotom-team:push");
export const kernelRunChannel = channel("rotom-team:kernel-run");
export const nativeStartChannel = channel("rotom-team:native-start");
export const viewProjectionChannel = channel("rotom-team:view-projection");
