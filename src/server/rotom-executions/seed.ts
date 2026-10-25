/** One operation-owned materializer. No queue, replay, detached work or second database writer. */
import { Worker } from "node:worker_threads";
import type { KernelBinding, KernelEntry } from "../rotom-journal.ts";
import type { publicNativeHistory } from "../rotom-history.ts";
import { seedPhaseChannel, type SeedPhaseSignal } from "../perf-channels.ts";

type Reply =
    | { type: "attach"; path: string; sessionId: string }
    | { type: "phase"; signal: SeedPhaseSignal }
    | { type: "complete"; entries: KernelEntry[] };

export function materializeSeed(
    binding: Pick<KernelBinding, "home" | "workspace">,
    messages: ReturnType<typeof publicNativeHistory>,
    attach: (path: string, sessionId: string) => Promise<void>,
) {
    const worker = new Worker(new URL("./seed-worker.ts", import.meta.url), {
        workerData: {
            home: binding.home,
            workspace: binding.workspace,
            measure: seedPhaseChannel.hasSubscribers,
        },
    });
    let failure: unknown;
    let stopped = false;
    let termination: Promise<number> | undefined;
    let entries: KernelEntry[] | undefined;

    const stop = () => {
        stopped = true;
        failure ??= new Error("Seed materialization stopped");
        termination ??= worker.terminate();

        return termination;
    };

    const result = new Promise<KernelEntry[]>((resolve, reject) => {
        let messageQueue = Promise.resolve();

        worker.on("message", (reply: Reply) => {
            messageQueue = messageQueue
                .then(async () => {
                    if (stopped) {
                        return;
                    }

                    if (reply.type === "attach") {
                        await attach(reply.path, reply.sessionId);

                        if (!stopped) {
                            worker.postMessage({ messages });
                        }
                    } else if (reply.type === "phase") {
                        seedPhaseChannel.publish(reply.signal);
                    } else if (reply.type === "complete") {
                        entries = reply.entries;
                    }
                })
                .catch((error) => {
                    failure = error;
                    void stop();
                });

            // Keep rejection handling on the chain so a failed durable attach cannot look like an ACK.
            void messageQueue;
        });
        worker.once("error", (error) => {
            failure = error;
        });
        // A result is not closure. Await the final exit and all queued message work even after readback or an error.
        worker.once("exit", async (code) => {
            await messageQueue;

            if (failure === undefined && code === 0 && entries !== undefined) {
                resolve(entries);
            } else {
                reject(failure ?? new Error("Seed worker exited without a complete readback"));
            }
        });
    });

    return { result, stop };
}
