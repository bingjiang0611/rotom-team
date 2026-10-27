/** Public-history handoff, fork/clone/import and durable seed materialization. */
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { seedPhases } from "../perf-channels.ts";
import {
    KernelRequestConflict,
    type KernelBinding,
    type KernelEntry,
    type KernelReceipt,
} from "../rotom-journal.ts";
import { nativeSessionManager, verifyRotomKernel } from "../rotom-kernel.ts";
import { publicNativeHistory } from "../rotom-history.ts";
import { readNativeEntries } from "./native-tail.ts";
import { materializeSeed } from "./seed.ts";
import { prepareSeed, persistSeed } from "./seed-files.ts";
import type { Running } from "./contracts.ts";
import type { NativeProcesses } from "./processes.ts";
import { assertNotStopped } from "./native-prompt.ts";

/** Public-history JSON UTF-8 bytes. Avoid worker startup for small seeds; 10 MiB already causes long parent stalls. */
const SEED_WORKER_MIN_BYTES = 8 * 1024 * 1024;

export async function handoff(
    processes: NativeProcesses,
    running: Running,
    sessionId: string,
    requestId: string,
    expectedHead: string,
    binding: KernelBinding,
): Promise<KernelReceipt> {
    await processes.authorize(binding, "admission", sessionId);
    assertNotStopped(running);

    if (verifyRotomKernel().version !== binding.kernelVersion) {
        throw new Error("Kernel version differs from the immutable session binding");
    }

    processes.prepare?.(binding, sessionId);
    const native = await nativeSessionManager();

    assertNotStopped(running);

    const mark = seedPhases();
    const { receipt, entries } = await processes.journal.handoffSeed(
        sessionId,
        requestId,
        expectedHead,
        binding,
    );

    if (entries === undefined) {
        return receipt;
    }

    let messages: ReturnType<typeof publicNativeHistory>;

    try {
        messages = publicNativeHistory(native.buildSessionProjection(entries).messages);
        mark("projection");
    } catch (error) {
        await processes.journal.fail(receipt.id, "rejected");

        throw error;
    }

    // The reservation fences the source until its captured public seed commits.
    try {
        await processes.retire(expectedHead);
    } catch (error) {
        running.closureUnknown = true;
        await processes.journal.fail(receipt.id, "unknown");

        throw error;
    }

    return seed(processes, receipt, messages, native.SessionManager, running);
}

export async function fork(
    processes: NativeProcesses,
    running: Running,
    sourceId: string,
    sessionId: string,
    requestId: string,
    expectedHead: string,
    entryId?: string,
    clone = false,
): Promise<KernelReceipt> {
    if (sourceId === sessionId) {
        throw new KernelRequestConflict("Fork requires an independent target conversation");
    }

    const admitted = await processes.journal.session(sessionId);
    const binding = admitted.binding;

    const authorize = async () => {
        await processes.authorize(binding, "fork", sourceId);
        await processes.authorize(binding, "fork", sessionId);
        processes.prepare?.(binding, sessionId);
    };

    await authorize();
    assertNotStopped(running);
    const identity = JSON.stringify({
        sourceId,
        expectedHead,
        ...(entryId ? { entryId } : {}),
        ...(clone ? { clone: true } : {}),
    });
    const existing = await processes.journal.existing(sessionId, requestId, identity, "fork");

    if (existing) {
        return existing;
    }

    if (verifyRotomKernel().version !== binding.kernelVersion) {
        throw new Error("Kernel version differs from the immutable session binding");
    }

    const native = await nativeSessionManager();

    assertNotStopped(running);
    const { receipt, seed: forkSeed } = await processes.journal.forkSeed(
        sessionId,
        requestId,
        identity,
        admitted.segmentId,
        { sessionId: sourceId, expectedHead, entryId },
        admitted.binding,
    );

    if (!forkSeed) {
        return receipt;
    }

    const { source, entries, parentId } = forkSeed;
    let messages: ReturnType<typeof publicNativeHistory>;

    try {
        messages = publicNativeHistory(native.buildSessionProjection(entries, parentId).messages);
    } catch (error) {
        await processes.journal.fail(receipt.id, "rejected");

        throw error;
    }

    if (clone && source.binding.memberId === binding.memberId && source.sessionFile) {
        let materializing = false;

        try {
            const folder = join(binding.home, ".pi/agent/sessions/team-seeds");

            mkdirSync(folder, { recursive: true, mode: 0o700 });

            if (realpathSync(folder) !== folder || lstatSync(folder).mode & 0o077) {
                throw new Error("Native clone directory must be canonical and private");
            }

            const manager = native.SessionManager.open(source.sessionFile, folder);

            // Freeze the native manager first, then validate against the captured journal revision.
            // Branching uses this in-memory tree (including labels), never a later source-file read.
            await processes.journal.forkSource(sourceId, expectedHead, source.revision);
            assertNotStopped(running);
            const leafId = manager.getLeafId();

            if (!leafId) {
                throw new Error("Native clone requires a current entry");
            }

            materializing = true;
            const path = manager.createBranchedSession(leafId);

            await processes.journal.attach(receipt.id, path, manager.getSessionId());
            chmodSync(path, 0o600);
            const clonedEntries = readNativeEntries(
                path,
                manager.getSessionId(),
                binding.workspace,
            );

            await authorize();
            assertNotStopped(running);

            return await processes.journal.finish(receipt.id, "settled", clonedEntries);
        } catch {
            return await processes.journal.fail(receipt.id, materializing ? "unknown" : "rejected");
        }
    }

    return seed(processes, receipt, messages, native.SessionManager, running, authorize);
}

export async function importHistory(
    processes: NativeProcesses,
    running: Running,
    sessionId: string,
    requestId: string,
    identity: string,
    entries: KernelEntry[],
): Promise<KernelReceipt> {
    const admitted = await processes.journal.session(sessionId);
    const binding = admitted.binding;

    const authorize = () => processes.authorize(binding, "fork", sessionId);

    await authorize();
    assertNotStopped(running);
    const previous = await processes.journal.existing(sessionId, requestId, identity, "fork");

    if (previous) {
        return previous;
    }

    processes.prepare?.(binding, sessionId);
    const native = await nativeSessionManager();
    const messages = publicNativeHistory(native.buildSessionProjection(entries).messages);
    const receipt = await processes.journal.reserve(
        sessionId,
        requestId,
        identity,
        "fork",
        undefined,
        admitted.segmentId,
        admitted.binding,
    );

    return seed(processes, receipt, messages, native.SessionManager, running, authorize);
}

async function seed(
    processes: NativeProcesses,
    receipt: KernelReceipt,
    messages: ReturnType<typeof publicNativeHistory>,
    SessionManager: Awaited<ReturnType<typeof nativeSessionManager>>["SessionManager"],
    running: Running,
    authorize = () => processes.authorize(receipt.binding, "admission", receipt.sessionId),
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

                assertNotStopped(running);
                await processes.journal.attach(receipt.id, path, sessionId);
                attached("attach");
            };

            if (bytes < SEED_WORKER_MIN_BYTES) {
                const { session, folder } = prepareSeed(receipt.binding, SessionManager);

                await attach(session.getSessionFile(), session.getSessionId());
                assertNotStopped(running);
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

        const finished = await processes.journal.finish(receipt.id, "settled", entries);

        mark("finish");

        return finished;
    } catch {
        return await processes.journal.fail(receipt.id, materializing ? "unknown" : "rejected");
    }
}
