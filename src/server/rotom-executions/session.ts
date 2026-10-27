import { join } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import { thinkingFromEntries, type KernelEntry, type AsyncRotomJournal } from "../rotom-journal.ts";
import { RpcFailure, type RpcRecord, type RotomRpc } from "../rotom-rpc.ts";
import { nativeBuiltinCommands } from "../rotom-kernel.ts";
import { TeamResourcePolicyError, assertTeamResourceSources } from "../rotom-resource-policy.ts";
import {
    currentBranchGoalState,
    goalIsActive,
    isKnownNativeCommand,
    nativeCommandArgs,
    nativeCommandName,
    normalizeNativePrompt,
} from "./contracts.ts";
import type { RunHooks, Running } from "./contracts.ts";

export type ExecutionSessionContext = {
    journal: AsyncRotomJournal;
    data: string;
    running: Map<string, Set<Running>>;
    kernels: Map<string, import("./contracts.ts").PersistentKernel>;
};

export function createExecutionSession(owner: ExecutionSessionContext) {
    return {
        async abort(sessionId: string): Promise<void> {
            await Promise.all(
                [...(owner.running.get(sessionId) ?? [])].map(async (run) => {
                    run.aborted = true;

                    if (run.seed) {
                        await run.seed.stop();
                    }

                    if (run.kernel) {
                        await run.kernel.abort();
                    }
                }),
            );
        },

        async thinkingLevel(
            sessionId: string,
            readEntries?: (segmentId: string) => Promise<KernelEntry[]>,
        ): Promise<string> {
            const { segmentId } = await owner.journal.session(sessionId);
            const live = owner.kernels.get(segmentId)?.state.thinkingLevel;

            if (live !== undefined) {
                return live;
            }

            if (readEntries) {
                const snapshot = await owner.journal.thinkingSnapshot(sessionId);

                if (snapshot.value !== undefined) {
                    return snapshot.value;
                }

                const value = thinkingFromEntries(
                    await readEntries(snapshot.segmentId),
                    snapshot.fallback,
                );

                await owner.journal.rememberThinking(snapshot, value);

                return value;
            }

            return owner.journal.thinkingLevel(sessionId);
        },

        /** Change only native reasoning, under the current prompt's durable command fence. */
        async setThinkingLevel(sessionId: string, level: string): Promise<string> {
            const run = [...(owner.running.get(sessionId) ?? [])].find((run) => run.prompting);

            if (!run?.kernel || !run.snapshot || run.aborted || !run.attemptId) {
                throw new RpcFailure(
                    "rejected",
                    "Thinking can only change during an active, reconciled prompt",
                );
            }

            const kernel = run.kernel;
            const snapshot = run.snapshot;
            const attemptId = run.attemptId;
            const admission = owner.journal.beginCommandInput(
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

                await owner.journal.progress(attemptId, entries);
                await owner.journal.completeCommandInput(inputId);

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
        },

        /** Add a message to the session's running prompt. False when none is running. */
        async queue(
            sessionId: string,
            text: string,
            mode: "steer" | "followUp",
            images: ImageContent[] = [],
            admitCommand?: RunHooks["onCommandAdmitted"],
        ): Promise<boolean> {
            for (const run of owner.running.get(sessionId) ?? []) {
                if (run.prompting && run.kernel) {
                    if (await owner.journal.hasUnresolvedCommandInput(run.attemptId!)) {
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
                        const { binding } = await owner.journal.session(sessionId);

                        try {
                            await assertTeamResourceSources(
                                binding.home,
                                join(owner.data, "team-agent"),
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
                            throw new RpcFailure(
                                "rejected",
                                `Unknown native command: /${name ?? ""}`,
                            );
                        }

                        if (builtins.some((command) => command.name === name)) {
                            throw new RpcFailure(
                                "rejected",
                                "Native builtin commands require the Team command adapter; they cannot mutate an active run",
                            );
                        }

                        const source = dynamic.find((command) => command.name === name)?.source;

                        await admitCommand?.({
                            name: name!,
                            source,
                            args: nativeCommandArgs(text),
                        });

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
                            const inputId = await owner.journal.beginCommandInput(
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

                            await owner.journal.completeCommandInput(inputId);
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
        },

        /** Wake the current workflow through native prompt admission, retaining its receipt and payer. */
        async wake(sessionId: string, text: string, images: ImageContent[] = []): Promise<boolean> {
            for (const run of owner.running.get(sessionId) ?? []) {
                if (run.prompting && run.kernel) {
                    await run.kernel.wake(normalizeNativePrompt(text), images);

                    return true;
                }
            }

            return false;
        },

        /** Answer an extension dialog of the session's running prompt. False when no run is waiting for it. */
        answer(
            sessionId: string,
            dialogId: string,
            response: Parameters<RotomRpc["answer"]>[1],
        ): boolean {
            return [...(owner.running.get(sessionId) ?? [])].some(
                (run) => run.kernel?.answer(dialogId, response) ?? false,
            );
        },
    };
}
