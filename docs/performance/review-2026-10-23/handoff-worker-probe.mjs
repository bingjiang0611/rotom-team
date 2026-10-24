// Benchmark preload only. Observe the real seed worker without adding runtime protocol or retry branches.
import threads from "node:worker_threads";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { seedPhaseChannel } from "../../../src/server/perf-channels.ts";

const seedUrl = new URL("../../../src/server/rotom-executions/seed-worker.ts", import.meta.url);
const signal = (phase, start, thread) => ({ phase, ms: performance.now() - start, thread });

if (threads.isMainThread) {
    const OriginalWorker = threads.Worker;

    threads.Worker = class extends OriginalWorker {
        constructor(url, options) {
            const started = performance.now();

            super(url, options);

            if (!(url instanceof URL) || url.href !== seedUrl.href) {
                return;
            }

            let received;

            this.on("message", (message) => {
                if (message.type === "attach") {
                    seedPhaseChannel.publish(signal("worker-ready", started, "main"));
                } else if (message.type === "complete") {
                    received = performance.now();
                }
            });
            this.once("exit", () => {
                seedPhaseChannel.publish(signal("worker-lifetime", started, "main"));

                if (received !== undefined) {
                    seedPhaseChannel.publish(signal("result-to-exit", received, "main"));
                }
            });
            const post = this.postMessage.bind(this);

            this.postMessage = (message, ...args) => {
                const before = performance.now();
                const result = post(message, ...args);

                if (message.messages) {
                    seedPhaseChannel.publish(signal("clone-to-worker", before, "main"));
                }

                return result;
            };
        }
    };
    syncBuiltinESMExports();
} else if (process.argv[1] === fileURLToPath(seedUrl)) {
    const post = threads.parentPort.postMessage.bind(threads.parentPort);

    threads.parentPort.postMessage = (message, ...args) => {
        const before = performance.now();
        const result = post(message, ...args);

        if (message.type === "complete") {
            post({ type: "phase", signal: signal("clone-from-worker", before, "worker") });
        }

        return result;
    };
}
