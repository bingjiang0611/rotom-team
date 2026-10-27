import {
    kernelRunChannel,
    seedPhases,
    scopedParseObject,
    type KernelRunSignal,
} from "./perf-channels.ts";
import type { ImageContent } from "@earendil-works/pi-ai";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
    RotomJournal,
    createAsyncRotomJournal,
    type AsyncRotomJournal,
    KernelRequestConflict,
    type KernelBinding,
    type KernelEntry,
    type KernelReceipt,
    type KernelRebind,
} from "./rotom-journal.ts";
import { verifyRotomKernel, nativeSessionManager } from "./rotom-kernel.ts";
import { publicNativeHistory } from "./rotom-history.ts";
import { readNativeEntries } from "./rotom-executions/native-tail.ts";
import { type RotomRpc } from "./rotom-rpc.ts";
import { executeRun, type RunContext } from "./rotom-executions/run.ts";
import { launchRotom, type LaunchContext } from "./rotom-executions/launch.ts";
import { seedNative, type SeedContext } from "./rotom-executions/seed-context.ts";
import {
    createExecutionLifecycle,
    type ExecutionLifecycleContext,
} from "./rotom-executions/lifecycle.ts";
import { createExecutionSession } from "./rotom-executions/session.ts";

import {
    goalIsActive,
    currentBranchGoalState,
    SEED_WORKER_MIN_BYTES,
    nativeCommandName,
    normalizeNativePrompt,
    nativeCommandArgs,
    isKnownNativeCommand,
    isTeamPrompt,
    nativePromptOperation,
    nativePromptIdentity,
    timePromptEvent,
    promptPhases,
} from "./rotom-executions/contracts.ts";
import type {
    QoderRequestAuth,
    KernelRequestAuth,
    KernelLaunchContext,
    RunHooks,
    Running,
    PromptTiming,
    ActiveAttempt,
    Owned,
    PersistentKernel,
} from "./rotom-executions/contracts.ts";
export type {
    QoderRequestAuth,
    KernelRequestAuth,
    KernelLaunchContext,
    RunHooks,
    Running,
    PromptTiming,
    ActiveAttempt,
    Owned,
    PersistentKernel,
};
export {
    goalIsActive,
    currentBranchGoalState,
    SEED_WORKER_MIN_BYTES,
    nativeCommandName,
    normalizeNativePrompt,
    nativeCommandArgs,
    isKnownNativeCommand,
    isTeamPrompt,
    nativePromptOperation,
    nativePromptIdentity,
    timePromptEvent,
};

export class RotomExecutions {
    readonly journal: AsyncRotomJournal;
    readonly #data: string;
    readonly #authorize: (
        binding: Readonly<KernelBinding>,
        operation: "admission" | "inference" | "refresh" | "fork",
        sessionId: string,
    ) => Promise<KernelRequestAuth | void>;
    readonly #prepare?: (
        binding: Readonly<KernelBinding>,
        sessionId: string,
    ) => KernelLaunchContext;
    readonly #running = new Map<string, Set<Running>>();
    readonly #kernels = new Map<string, PersistentKernel>();
    readonly #lifecycle: ReturnType<typeof createExecutionLifecycle>;
    readonly #session: ReturnType<typeof createExecutionSession>;
    readonly #unused = new Map<
        string,
        { sessionId: string; binding: Readonly<KernelBinding>; timer: NodeJS.Timeout }
    >();
    readonly #warming = new Map<string, { memberId: string; done: Promise<boolean> }>();
    #closing = false;
    #active = 0;
    constructor(
        data: string,
        authorize: (
            binding: Readonly<KernelBinding>,
            operation: "admission" | "inference" | "refresh" | "fork",
            sessionId: string,
        ) => Promise<KernelRequestAuth | void>,
        prepare?: (binding: Readonly<KernelBinding>, sessionId: string) => KernelLaunchContext,
        journal?: AsyncRotomJournal,
    ) {
        this.journal =
            journal ??
            createAsyncRotomJournal(scopedParseObject("journal", new RotomJournal(data)));
        this.#data = data;
        this.#authorize = authorize;
        this.#prepare = prepare;
        this.#lifecycle = createExecutionLifecycle(this.#lifecycleContext());
        this.#session = createExecutionSession({
            journal: this.journal,
            data: this.#data,
            running: this.#running,
            kernels: this.#kernels,
        });
    }

    #lifecycleContext(): ExecutionLifecycleContext {
        return {
            journal: this.journal,
            data: this.#data,
            authorize: this.#authorize,
            prepare: this.#prepare,
            running: this.#running,
            kernels: this.#kernels,
            unused: this.#unused,
            warming: this.#warming,
            isClosing: () => this.#closing,
            setClosing: () => {
                this.#closing = true;
            },
            active: () => this.#active,
            launch: (binding, sessionId, file, prepared, gate, name, revision, owned, hooks) =>
                launchRotom(
                    this.#launchContext(),
                    binding,
                    sessionId,
                    file,
                    prepared,
                    gate,
                    name,
                    revision,
                    owned,
                    hooks,
                ),
        };
    }

    async abort(sessionId: string): Promise<void> {
        return this.#session.abort(sessionId);
    }
    async thinkingLevel(
        sessionId: string,
        readEntries?: (segmentId: string) => Promise<KernelEntry[]>,
    ): Promise<string> {
        return this.#session.thinkingLevel(sessionId, readEntries);
    }
    async setThinkingLevel(sessionId: string, level: string): Promise<string> {
        return this.#session.setThinkingLevel(sessionId, level);
    }
    async queue(
        sessionId: string,
        text: string,
        mode: "steer" | "followUp",
        images: ImageContent[] = [],
        admitCommand?: RunHooks["onCommandAdmitted"],
    ): Promise<boolean> {
        return this.#session.queue(sessionId, text, mode, images, admitCommand);
    }
    async wake(sessionId: string, text: string, images: ImageContent[] = []): Promise<boolean> {
        return this.#session.wake(sessionId, text, images);
    }
    answer(
        sessionId: string,
        dialogId: string,
        response: Parameters<RotomRpc["answer"]>[1],
    ): boolean {
        return this.#session.answer(sessionId, dialogId, response);
    }

    async #track(
        sessionId: string,
        action: (running: Running) => Promise<KernelReceipt>,
    ): Promise<KernelReceipt> {
        const running: Running = {
            aborted: false,
            ...(kernelRunChannel.hasSubscribers
                ? { timing: { toolsRunning: 0, toolsSince: 0, toolMs: 0, tools: 0 } }
                : {}),
        };
        const runs = this.#running.get(sessionId) ?? new Set<Running>();

        runs.add(running);
        this.#running.set(sessionId, runs);
        this.#active++;
        const started = performance.now();
        let outcome = "error";

        try {
            const receipt = await action(running);

            outcome = `${receipt.operation}:${receipt.status}`;

            return receipt;
        } finally {
            running.timing?.detach?.();

            if (kernelRunChannel.hasSubscribers) {
                const ended = performance.now();

                kernelRunChannel.publish({
                    ms: ended - started,
                    outcome,
                    ...promptPhases(running.timing, started, ended),
                } satisfies KernelRunSignal);
            }

            if (!running.closureUnknown) {
                runs.delete(running);

                if (!runs.size) {
                    this.#running.delete(sessionId);
                }

                this.#active--;
            }
        }
    }

    #notStopped(running: Running): void {
        if (running.aborted) {
            throw new KernelRequestConflict("Stopped before native dispatch or materialization");
        }
    }

    #runContext(): RunContext {
        return {
            journal: this.journal,
            data: this.#data,
            authorize: this.#authorize,
            prepare: this.#prepare,
            retire: (id) => this.#lifecycle.retire(id),
            used: (id) => this.#lifecycle.used(id),
            warming: (id) => this.#warming.get(id),
            kernel: (id) => this.#kernels.get(id),
            setKernel: (id, value) => this.#kernels.set(id, value),
            deleteKernel: (id) => this.#kernels.delete(id),
            notStopped: (run) => this.#notStopped(run),
            launch: (binding, sessionId, file, prepared, gate, name, revision, owned, hooks) =>
                this.#lifecycle.launch(
                    binding,
                    sessionId,
                    file,
                    prepared,
                    gate,
                    name,
                    revision,
                    owned,
                    hooks,
                ),
        };
    }
    #launchContext(): LaunchContext {
        return { journal: this.journal, data: this.#data, authorize: this.#authorize };
    }
    #seedContext(): SeedContext {
        return {
            journal: this.journal,
            authorize: this.#authorize,
            notStopped: (run) => this.#notStopped(run),
        };
    }

    async handoff(
        sessionId: string,
        requestId: string,
        expectedHead: string,
        binding: KernelBinding,
    ): Promise<KernelReceipt> {
        return this.#track(sessionId, async (running) => {
            await this.#authorize(binding, "admission", sessionId);
            this.#notStopped(running);

            if (verifyRotomKernel().version !== binding.kernelVersion) {
                throw new Error("Kernel version differs from the immutable session binding");
            }

            this.#prepare?.(binding, sessionId);
            const native = await nativeSessionManager();

            this.#notStopped(running);

            const mark = seedPhases();
            const { receipt, entries } = await this.journal.handoffSeed(
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
                await this.journal.fail(receipt.id, "rejected");

                throw error;
            }

            try {
                await this.#lifecycle.retire(expectedHead);
            } catch (error) {
                running.closureUnknown = true;
                await this.journal.fail(receipt.id, "unknown");

                throw error;
            }

            return this.#seed(receipt, messages, native.SessionManager, running);
        });
    }

    async fork(
        sourceId: string,
        sessionId: string,
        requestId: string,
        expectedHead: string,
        entryId?: string,
        clone = false,
    ): Promise<KernelReceipt> {
        return this.#track(sessionId, async (running) => {
            if (sourceId === sessionId) {
                throw new KernelRequestConflict("Fork requires an independent target conversation");
            }

            const admitted = await this.journal.session(sessionId);
            const binding = admitted.binding;

            const authorize = async () => {
                await this.#authorize(binding, "fork", sourceId);
                await this.#authorize(binding, "fork", sessionId);
                this.#prepare?.(binding, sessionId);
            };

            await authorize();
            this.#notStopped(running);
            const identity = JSON.stringify({
                sourceId,
                expectedHead,
                ...(entryId ? { entryId } : {}),
                ...(clone ? { clone: true } : {}),
            });
            const existing = await this.journal.existing(sessionId, requestId, identity, "fork");

            if (existing) {
                return existing;
            }

            if (verifyRotomKernel().version !== binding.kernelVersion) {
                throw new Error("Kernel version differs from the immutable session binding");
            }

            const native = await nativeSessionManager();

            this.#notStopped(running);
            const { receipt, seed } = await this.journal.forkSeed(
                sessionId,
                requestId,
                identity,
                admitted.segmentId,
                { sessionId: sourceId, expectedHead, entryId },
                admitted.binding,
            );

            if (!seed) {
                return receipt;
            }

            const { source, entries, parentId } = seed;
            let messages: ReturnType<typeof publicNativeHistory>;

            try {
                messages = publicNativeHistory(
                    native.buildSessionProjection(entries, parentId).messages,
                );
            } catch (error) {
                await this.journal.fail(receipt.id, "rejected");

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

                    await this.journal.forkSource(sourceId, expectedHead, source.revision);
                    this.#notStopped(running);
                    const leafId = manager.getLeafId();

                    if (!leafId) {
                        throw new Error("Native clone requires a current entry");
                    }

                    materializing = true;
                    const path = manager.createBranchedSession(leafId);

                    await this.journal.attach(receipt.id, path, manager.getSessionId());
                    chmodSync(path, 0o600);
                    const clonedEntries = readNativeEntries(
                        path,
                        manager.getSessionId(),
                        binding.workspace,
                    );

                    await authorize();
                    this.#notStopped(running);

                    return await this.journal.finish(receipt.id, "settled", clonedEntries);
                } catch {
                    return await this.journal.fail(
                        receipt.id,
                        materializing ? "unknown" : "rejected",
                    );
                }
            }

            return this.#seed(receipt, messages, native.SessionManager, running, authorize);
        });
    }

    /** Import foreign history through the existing public-history seed boundary. */
    async importHistory(
        sessionId: string,
        requestId: string,
        identity: string,
        entries: KernelEntry[],
    ): Promise<KernelReceipt> {
        return this.#track(sessionId, async (running) => {
            const admitted = await this.journal.session(sessionId);
            const binding = admitted.binding;

            const authorize = () => this.#authorize(binding, "fork", sessionId);

            await authorize();
            this.#notStopped(running);
            const previous = await this.journal.existing(sessionId, requestId, identity, "fork");

            if (previous) {
                return previous;
            }

            this.#prepare?.(binding, sessionId);
            const native = await nativeSessionManager();
            const messages = publicNativeHistory(native.buildSessionProjection(entries).messages);
            const receipt = await this.journal.reserve(
                sessionId,
                requestId,
                identity,
                "fork",
                undefined,
                admitted.segmentId,
                admitted.binding,
            );

            return this.#seed(receipt, messages, native.SessionManager, running, authorize);
        });
    }

    async #seed(
        receipt: KernelReceipt,
        messages: ReturnType<typeof publicNativeHistory>,
        SessionManager: Awaited<ReturnType<typeof nativeSessionManager>>["SessionManager"],
        running: Running,
        authorize = () => this.#authorize(receipt.binding, "admission", receipt.sessionId),
    ): Promise<KernelReceipt> {
        return seedNative(
            this.#seedContext(),
            receipt,
            messages,
            SessionManager,
            running,
            authorize,
        );
    }

    run(
        sessionId: string,
        requestId: string,
        prompt: string,
        hooks: RunHooks = {},
        images: ImageContent[] = [],
    ): Promise<KernelReceipt> {
        return this.#track(sessionId, (running) =>
            this.#execute(
                sessionId,
                requestId,
                normalizeNativePrompt(prompt),
                nativePromptOperation(prompt),
                running,
                hooks,
                images,
            ),
        );
    }

    /** The paying member's idle model change: same native session, restarted on the new model. */
    setModel(
        sessionId: string,
        requestId: string,
        rebind: KernelRebind,
        hooks: RunHooks = {},
    ): Promise<KernelReceipt> {
        return this.#track(sessionId, (running) =>
            this.#execute(
                sessionId,
                requestId,
                `/model ${rebind.binding.accountGeneration}/${rebind.binding.model}`,
                "command",
                running,
                hooks,
                [],
                rebind,
            ),
        );
    }

    /** Authorized startup discovery uses a normal owned lease, but its gate denies all inference. */
    discover(sessionId: string, requestId: string, hooks: RunHooks): Promise<KernelReceipt> {
        return this.#track(sessionId, (running) =>
            this.#execute(
                sessionId,
                requestId,
                "native-command-discovery",
                "discover",
                running,
                hooks,
            ),
        );
    }

    compact(sessionId: string, requestId: string, instructions = ""): Promise<KernelReceipt> {
        return this.#track(sessionId, (running) =>
            this.#execute(sessionId, requestId, instructions, "compact", running),
        );
    }

    async #execute(
        sessionId: string,
        requestId: string,
        prompt: string,
        operation: "prompt" | "compact" | "discover" | "command",
        running: Running,
        hooks: RunHooks = {},
        images: ImageContent[] = [],
        rebind?: KernelRebind,
    ): Promise<KernelReceipt> {
        return executeRun(
            this.#runContext(),
            sessionId,
            requestId,
            prompt,
            operation,
            running,
            hooks,
            images,
            rebind,
        );
    }

    async warm(sessionId: string): Promise<boolean> {
        return this.#lifecycle.warm(sessionId);
    }
    unusedWarm() {
        return this.#lifecycle.unusedWarm();
    }
    retireUnused(segmentId: string): Promise<void> {
        return this.#lifecycle.retireUnused(segmentId);
    }
    retireUnusedOf(memberId: string): Promise<void> {
        return this.#lifecycle.retireUnusedOf(memberId);
    }
    close(): Promise<void> {
        return this.#lifecycle.close();
    }
}
