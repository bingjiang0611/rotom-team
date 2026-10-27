/** Non-replayable team-owned execution journal around the real rotom loop. Not a model-provider adapter. */
import { kernelRunChannel, scopedParseObject, type KernelRunSignal } from "./perf-channels.ts";
import { assertTeamResourceSources, TeamResourcePolicyError } from "./rotom-resource-policy.ts";
import { RpcFailure, type RpcRecord, type RotomRpc } from "./rotom-rpc.ts";
import { nativeBuiltinCommands } from "./rotom-kernel.ts";
import type { ImageContent } from "@earendil-works/pi-ai";
import { join } from "node:path";
import {
    RotomJournal,
    createAsyncRotomJournal,
    thinkingFromEntries,
    type AsyncRotomJournal,
    type KernelBinding,
    type KernelEntry,
    type KernelReceipt,
    type KernelRebind,
} from "./rotom-journal.ts";
import { NativeProcesses } from "./rotom-executions/processes.ts";
import { execute } from "./rotom-executions/execute.ts";
import { handoff, fork, importHistory } from "./rotom-executions/history.ts";
import {
    promptPhases,
    nativePromptOperation,
    normalizeNativePrompt,
    nativeCommandName,
    nativeCommandArgs,
    isKnownNativeCommand,
    currentBranchGoalState,
    goalIsActive,
} from "./rotom-executions/native-prompt.ts";
import type { Running, RunHooks, Authorize, Prepare } from "./rotom-executions/contracts.ts";
export type {
    QoderRequestAuth,
    KernelRequestAuth,
    KernelLaunchContext,
    RunHooks,
} from "./rotom-executions/contracts.ts";
export {
    nativeCommandName,
    normalizeNativePrompt,
    nativeCommandArgs,
    isKnownNativeCommand,
    isTeamPrompt,
    nativePromptOperation,
    nativePromptIdentity,
    currentBranchGoalState,
} from "./rotom-executions/native-prompt.ts";

export class RotomExecutions {
    readonly journal: AsyncRotomJournal;
    readonly #running = new Map<string, Set<Running>>();
    readonly #processes: NativeProcesses;
    #active = 0;

    constructor(
        data: string,
        authorize: Authorize,
        prepare?: Prepare,
        journal?: AsyncRotomJournal,
    ) {
        this.journal =
            journal ??
            createAsyncRotomJournal(scopedParseObject("journal", new RotomJournal(data)));
        this.#processes = new NativeProcesses(
            data,
            this.journal,
            authorize,
            prepare,
            this.#running,
        );
    }

    async abort(sessionId: string): Promise<void> {
        await Promise.all(
            [...(this.#running.get(sessionId) ?? [])].map(async (run) => {
                run.aborted = true;

                if (run.seed) {
                    await run.seed.stop();
                }

                if (run.kernel) {
                    await run.kernel.abort();
                }
            }),
        );
    }

    async thinkingLevel(
        sessionId: string,
        readEntries?: (segmentId: string) => Promise<KernelEntry[]>,
    ): Promise<string> {
        const { segmentId } = await this.journal.session(sessionId);
        const live = this.#processes.kernels.get(segmentId)?.state.thinkingLevel;

        if (live !== undefined) {
            return live;
        }

        if (readEntries) {
            const snapshot = await this.journal.thinkingSnapshot(sessionId);

            if (snapshot.value !== undefined) {
                return snapshot.value;
            }

            const value = thinkingFromEntries(
                await readEntries(snapshot.segmentId),
                snapshot.fallback,
            );

            await this.journal.rememberThinking(snapshot, value);

            return value;
        }

        return this.journal.thinkingLevel(sessionId);
    }

    /** Change only native reasoning, under the current prompt's durable command fence. */
    async setThinkingLevel(sessionId: string, level: string): Promise<string> {
        const run = [...(this.#running.get(sessionId) ?? [])].find((run) => run.prompting);

        if (!run?.kernel || !run.snapshot || run.aborted || !run.attemptId) {
            throw new RpcFailure(
                "rejected",
                "Thinking can only change during an active, reconciled prompt",
            );
        }

        const kernel = run.kernel;
        const snapshot = run.snapshot;
        const attemptId = run.attemptId;
        const admission = this.journal.beginCommandInput(
            attemptId,
            `/thinking ${level}`,
            "execution",
        );
        const change = admission.then(async (inputId) => {
            if (run.aborted) {
                throw new RpcFailure(
                    "unknown",
                    "Thinking change interrupted by Stop; do not replay it",
                );
            }

            await kernel.setThinkingLevel(level);
            const state = (await kernel.request({ type: "get_state" })) as {
                thinkingLevel: string;
            };
            const { entries } = await snapshot();

            if (run.aborted) {
                throw new RpcFailure(
                    "unknown",
                    "Thinking change interrupted by Stop; do not replay it",
                );
            }

            await this.journal.progress(attemptId, entries);
            await this.journal.completeCommandInput(inputId);

            return state.thinkingLevel;
        });
        // Publish admission + mutation before yielding, and keep earlier admitted changes in the drain.
        // A rejected admission dispatched no mutation; finish still checks any persisted unknown-input fence.
        const drain = admission.then(
            () => change,
            () => undefined,
        );

        run.thinkingChange = Promise.all([run.thinkingChange, drain]).then(() => undefined);
        // The caller observes change's failure now; finalization must also observe an admitted failure later.
        void run.thinkingChange.catch(() => undefined);

        return change;
    }

    /** Add a message to the session's running prompt. False when none is running. */
    async queue(
        sessionId: string,
        text: string,
        mode: "steer" | "followUp",
        images: ImageContent[] = [],
        admitCommand?: RunHooks["onCommandAdmitted"],
    ): Promise<boolean> {
        for (const run of this.#running.get(sessionId) ?? []) {
            if (run.prompting && run.kernel) {
                if (await this.journal.hasUnresolvedCommandInput(run.attemptId!)) {
                    throw new RpcFailure(
                        "rejected",
                        "A queued native command is pending or unknown; do not replay it",
                    );
                }

                const slash = text.trimStart().startsWith("/");
                const name = nativeCommandName(text);

                const queueInput = async () => {
                    const goal = currentBranchGoalState(await run.snapshot!());

                    if (goalIsActive(goal)) {
                        await run.kernel!.wake(normalizeNativePrompt(text), images, mode);
                    } else {
                        await run.kernel!.queue(normalizeNativePrompt(text), mode, images);
                    }
                };

                if (slash) {
                    const { binding } = await this.journal.session(sessionId);

                    try {
                        await assertTeamResourceSources(
                            binding.home,
                            join(this.#processes.data, "team-agent"),
                            binding.workspace,
                        );
                    } catch (error) {
                        if (error instanceof TeamResourcePolicyError) {
                            throw new RpcFailure("rejected", error.message);
                        }

                        throw error;
                    }

                    const catalog = (await run.kernel.request({ type: "get_commands" })) as {
                        commands?: Array<{ name?: unknown; source?: unknown }>;
                    };
                    const builtins = await nativeBuiltinCommands();
                    const dynamic = catalog.commands ?? [];

                    if (!isKnownNativeCommand(text, [...dynamic, ...builtins])) {
                        throw new RpcFailure("rejected", `Unknown native command: /${name ?? ""}`);
                    }

                    if (builtins.some((command) => command.name === name)) {
                        throw new RpcFailure(
                            "rejected",
                            "Native builtin commands require the Team command adapter; they cannot mutate an active run",
                        );
                    }

                    const source = dynamic.find((command) => command.name === name)?.source;

                    await admitCommand?.({ name: name!, source, args: nativeCommandArgs(text) });

                    if (source === "prompt" || source === "skill") {
                        await queueInput();

                        return true;
                    }

                    let extensionError: RpcRecord | undefined;
                    const detach = run.kernel.onEvent((event) => {
                        if (event.type === "extension_error") {
                            extensionError = event;
                        }
                    });

                    try {
                        const inputId = await this.journal.beginCommandInput(
                            run.attemptId!,
                            normalizeNativePrompt(text),
                        );

                        await run.kernel.command(normalizeNativePrompt(text));
                        await run.kernel.barrier();

                        if (extensionError) {
                            throw new RpcFailure(
                                "unknown",
                                `Native extension command failed: ${String(extensionError.error ?? "unknown error")}`,
                            );
                        }

                        await this.journal.completeCommandInput(inputId);
                    } finally {
                        detach();
                    }

                    return true;
                }

                await queueInput();

                return true;
            }
        }

        return false;
    }

    /** Wake the current workflow through native prompt admission, retaining its receipt and payer. */
    async wake(sessionId: string, text: string, images: ImageContent[] = []): Promise<boolean> {
        for (const run of this.#running.get(sessionId) ?? []) {
            if (run.prompting && run.kernel) {
                await run.kernel.wake(normalizeNativePrompt(text), images);

                return true;
            }
        }

        return false;
    }

    /** Answer an extension dialog of the session's running prompt. False when no run is waiting for it. */
    answer(
        sessionId: string,
        dialogId: string,
        response: Parameters<RotomRpc["answer"]>[1],
    ): boolean {
        return [...(this.#running.get(sessionId) ?? [])].some(
            (run) => run.kernel?.answer(dialogId, response) ?? false,
        );
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

            // Failure to prove child closure must retain the writer lease, even after the caller rejects.
            if (!running.closureUnknown) {
                runs.delete(running);

                if (!runs.size) {
                    this.#running.delete(sessionId);
                }

                this.#active--;
            }
        }
    }

    async handoff(
        sessionId: string,
        requestId: string,
        expectedHead: string,
        binding: KernelBinding,
    ): Promise<KernelReceipt> {
        return this.#track(sessionId, (running) =>
            handoff(this.#processes, running, sessionId, requestId, expectedHead, binding),
        );
    }

    async fork(
        sourceId: string,
        sessionId: string,
        requestId: string,
        expectedHead: string,
        entryId?: string,
        clone = false,
    ): Promise<KernelReceipt> {
        return this.#track(sessionId, (running) =>
            fork(
                this.#processes,
                running,
                sourceId,
                sessionId,
                requestId,
                expectedHead,
                entryId,
                clone,
            ),
        );
    }

    async importHistory(
        sessionId: string,
        requestId: string,
        identity: string,
        entries: KernelEntry[],
    ): Promise<KernelReceipt> {
        return this.#track(sessionId, (running) =>
            importHistory(this.#processes, running, sessionId, requestId, identity, entries),
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
            execute(
                this.#processes,
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
            execute(
                this.#processes,
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
            execute(
                this.#processes,
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
            execute(this.#processes, sessionId, requestId, instructions, "compact", running),
        );
    }

    async warm(sessionId: string): Promise<boolean> {
        return this.#processes.warm(sessionId);
    }

    unusedWarm(): { segmentId: string; sessionId: string; binding: Readonly<KernelBinding> }[] {
        return this.#processes.unusedWarm();
    }

    retireUnused(segmentId: string): Promise<void> {
        return this.#processes.retireUnused(segmentId);
    }

    retireUnusedOf(memberId: string): Promise<void> {
        return this.#processes.retireUnusedOf(memberId);
    }

    close(): Promise<void> {
        if (this.#active) {
            throw new Error("Kernel executions are still active; do not release the writer lock");
        }

        return this.#processes.close();
    }
}
