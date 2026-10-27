import { seedPhases } from "../perf-channels.ts";
import { materializeSeed } from "./seed.ts";
import { prepareSeed, persistSeed } from "./seed-files.ts";
import { publicNativeHistory } from "../rotom-history.ts";
import { nativeSessionManager } from "../rotom-kernel.ts";
import { SEED_WORKER_MIN_BYTES } from "./contracts.ts";
import type {
    AsyncRotomJournal,
    KernelBinding,
    KernelEntry,
    KernelReceipt,
} from "../rotom-journal.ts";
import type { Running } from "./contracts.ts";
export interface SeedContext {
    journal: AsyncRotomJournal;
    authorize: (
        binding: Readonly<KernelBinding>,
        operation: "admission" | "inference" | "refresh" | "fork",
        sessionId: string,
    ) => Promise<unknown>;
    notStopped: (running: Running) => void;
}

export async function seedNative(
    ctx: SeedContext,
    receipt: KernelReceipt,
    messages: ReturnType<typeof publicNativeHistory>,
    SessionManager: Awaited<ReturnType<typeof nativeSessionManager>>["SessionManager"],
    running: Running,
    authorize = () => ctx.authorize(receipt.binding, "admission", receipt.sessionId),
): Promise<KernelReceipt> {
    let materializing = false;
    let mark = seedPhases();

    try {
        await authorize();
        mark("authorize");

        if (running.aborted) {
            throw new Error("Seed stopped before materialization");
        }

        let entries: KernelEntry[] = [];

        if (messages.length) {
            materializing = true;
            const bytes = Buffer.byteLength(JSON.stringify(messages), "utf8");

            mark("select");

            const attach = async (path: string, sessionId: string) => {
                const attached = seedPhases();

                ctx.notStopped(running);
                await ctx.journal.attach(receipt.id, path, sessionId);
                attached("attach");
            };

            if (bytes < SEED_WORKER_MIN_BYTES) {
                const { session, folder } = prepareSeed(receipt.binding, SessionManager);

                await attach(session.getSessionFile(), session.getSessionId());
                ctx.notStopped(running);
                entries = persistSeed(session, folder, receipt.binding.workspace, messages);
            } else {
                // The worker waits for the same durable attach before it can append.
                const seed = materializeSeed(receipt.binding, messages, attach);

                running.seed = seed;

                try {
                    // The result settles only after worker exit, including errors and stop.
                    entries = await seed.result;
                } finally {
                    running.seed = undefined;
                }
            }

            mark = seedPhases();
        }

        await authorize();
        mark("reauthorize");

        if (running.aborted) {
            throw new Error("Seed stopped before commit");
        }

        const finished = await ctx.journal.finish(receipt.id, "settled", entries);

        mark("finish");

        return finished;
    } catch {
        return await ctx.journal.fail(receipt.id, materializing ? "unknown" : "rejected");
    }
}
