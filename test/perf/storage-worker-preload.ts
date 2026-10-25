/** Use with --import for worker-enabled benchmarks. No product dependency on test instrumentation. */
import { isMainThread, workerData } from "node:worker_threads";

if (!isMainThread && workerData?.storageWorker === true) {
    const { snapshot, since, nativeTimingSnapshot, nativeTimingSince } =
        await import("./counters.ts");
    const { storageWorkChannel } = await import("../../src/server/perf-channels.ts");
    let previous: Record<string, number> = {};
    let timingBefore: Record<string, number> = {};

    storageWorkChannel.subscribe((message) => {
        const signal = message as {
            counters?: Record<string, number>;
            timings?: Record<string, number>;
        };

        signal.counters = since(previous);
        signal.timings = nativeTimingSince(timingBefore);
        previous = snapshot();
        timingBefore = nativeTimingSnapshot();
    });
}
