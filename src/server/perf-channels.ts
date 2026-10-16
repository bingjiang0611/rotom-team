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

export const pushChannel = channel("rotom-team:push");
export const kernelRunChannel = channel("rotom-team:kernel-run");
