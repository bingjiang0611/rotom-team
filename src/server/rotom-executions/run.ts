import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sendPhase } from "../send-trace.ts";
import { prepareRetainedModel } from "./model-preflight.ts";
import { TeamResourcePolicyError } from "../rotom-resource-policy.ts";
import { teamResourceRevision } from "../rotom-resources.ts";
import { nativeBuiltinCommands, verifyRotomKernel } from "../rotom-kernel.ts";
import {
    isKnownNativeCommand,
    isTeamPrompt,
    nativeCommandArgs,
    nativeCommandName,
    nativePromptIdentity,
    timePromptEvent,
} from "./contracts.ts";
import { readNativeEntries, NativeTail, readNativeSnapshot } from "./native-tail.ts";
import { runNativeOperation } from "./operations.ts";
import { RpcFailure, type RpcRecord, type RotomRpc } from "../rotom-rpc.ts";
import type { ImageContent } from "@earendil-works/pi-ai";
import type {
    ActiveAttempt,
    KernelLaunchContext,
    Owned,
    PersistentKernel,
    RunHooks,
    Running,
} from "./contracts.ts";
import { KernelRequestConflict } from "../rotom-journal.ts";
import type {
    AsyncRotomJournal,
    KernelBinding,
    KernelEntry,
    KernelReceipt,
    KernelRebind,
    KernelFailure,
} from "../rotom-journal.ts";

export type Launch = (
    binding: Readonly<KernelBinding>,
    sessionId: string,
    sessionFile: string | undefined,
    prepared: KernelLaunchContext | undefined,
    gateState: PersistentKernel["gateState"],
    name: string,
    revision: string,
    owned: Owned,
    hooks?: { beforeStart?: () => void; started?: (kernel: RotomRpc) => void },
) => Promise<PersistentKernel>;
export interface RunContext {
    journal: AsyncRotomJournal;
    data: string;
    authorize: (
        binding: Readonly<KernelBinding>,
        operation: "admission" | "inference" | "refresh" | "fork",
        sessionId: string,
    ) => Promise<unknown>;
    prepare?: (binding: Readonly<KernelBinding>, sessionId: string) => KernelLaunchContext;
    retire: (segmentId: string) => Promise<void>;
    used: (segmentId: string) => void;
    warming: (segmentId: string) => { done: Promise<boolean> } | undefined;
    kernel: (segmentId: string) => PersistentKernel | undefined;
    setKernel: (segmentId: string, value: PersistentKernel) => void;
    deleteKernel: (segmentId: string) => void;
    notStopped: (running: Running) => void;
    launch: Launch;
}

export async function executeRun(
    ctx: RunContext,
    sessionId: string,
    requestId: string,
    prompt: string,
    operation: "prompt" | "compact" | "discover" | "command",
    running: Running,
    hooks: RunHooks = {},
    images: ImageContent[] = [],
    rebind?: KernelRebind,
): Promise<KernelReceipt> {
    const identity = nativePromptIdentity(prompt, images);
    const admitted = await ctx.journal.session(sessionId);
    const binding = Object.freeze(rebind?.binding ?? admitted.binding);

    // Old receipts are returned, never fed to a new subprocess. Even unknown is a durable result of admission.
    await ctx.authorize(binding, "admission", sessionId);
    const previous = await ctx.journal.existing(sessionId, requestId, identity, operation);

    if (previous) {
        return previous;
    }

    ctx.notStopped(running);

    if (["prompt", "command"].includes(operation) && !isTeamPrompt(prompt)) {
        throw new Error(
            "Kernel execution requires ordinary prompt text; product commands are not team submissions",
        );
    }

    // Authorization awaited user/account state. A concurrent completed handoff must not
    // reserve the new payer while launching this previously admitted binding.
    if (
        (await ctx.journal.session(sessionId)).segmentId !== admitted.segmentId ||
        (rebind && rebind.expectedHead !== admitted.segmentId)
    ) {
        throw new KernelRequestConflict("Conversation head changed during admission");
    }

    if (verifyRotomKernel().version !== binding.kernelVersion) {
        throw new Error("Kernel version differs from the immutable session binding");
    }

    const prepared = ctx.prepare?.(binding, sessionId);

    if (
        rebind &&
        (binding.accountGeneration !== admitted.binding.accountGeneration ||
            binding.provider !== admitted.binding.provider ||
            !prepared ||
            ctx.kernel(admitted.segmentId)?.modelApi !== prepared.modelDefinition.api)
    ) {
        // Account/provider changes retain the stronger process boundary. Journal reservation also
        // checks member, HOME, workspace, kernel and configuration identity.
        await ctx.retire(admitted.segmentId);
    }

    const receipt = await ctx.journal.reserve(
        sessionId,
        requestId,
        identity,
        operation,
        rebind,
        admitted.segmentId,
        admitted.binding,
    );

    running.attemptId = receipt.id;

    if (operation === "prompt" || operation === "command") {
        sendPhase(sessionId, requestId, "reserved");
    }

    await hooks.onReserved?.(receipt);
    // Admission is asynchronous: an earlier request may have created the native file while it was pending.
    const session = await ctx.journal.session(sessionId);

    const revision = teamResourceRevision(join(ctx.data, "team-agent"), binding.workspace);

    // One process per session: a warm start on its way is waited for, not started twice.
    const warming = ctx.warming(admitted.segmentId);

    if (warming) {
        await warming.done;
    }

    let persistent = ctx.kernel(admitted.segmentId);
    const reusing = persistent !== undefined;

    if (running.timing) {
        running.timing.process = persistent ? "reused" : "started";
    }

    let kernel: RotomRpc | undefined = persistent?.kernel;
    let gate: ReturnType<typeof createServer> | undefined = persistent?.gate;
    let gateFile: string | undefined = persistent?.gateFile;
    let contextFile: string | undefined = persistent?.contextFile;
    let closed = false;
    let failureStatus: "unknown" | "rejected" = "unknown";
    let progressFailure: unknown;
    let progressQueue = Promise.resolve();
    let hookQueue = Promise.resolve();
    let detachHook: (() => void) | undefined;
    let detachProgress: (() => void) | undefined;

    const observeHook = (result: void | Promise<unknown>) => {
        hookQueue = Promise.all([hookQueue, result])
            .then(() => undefined)
            .catch((error) => {
                progressFailure = error;
            });
    };

    const activeAttempt: ActiveAttempt = {
        receipt,
        operation,
        running,
        inferenceAdmitted: false,
        usageWrites: Promise.resolve(),
    };

    const gateState = persistent?.gateState ?? { active: activeAttempt };

    gateState.active = activeAttempt;

    let state: PersistentKernel["state"] | undefined = persistent?.state;

    try {
        if (persistent) {
            // Started before (by an earlier request, or warmed for this member): no longer waiting unused.
            ctx.used(admitted.segmentId);
        } else {
            const owned: Owned = {};

            try {
                persistent = await ctx.launch(
                    binding,
                    sessionId,
                    session.sessionFile,
                    prepared,
                    gateState,
                    receipt.id,
                    revision,
                    owned,
                    {
                        beforeStart: () => ctx.notStopped(running),
                        started: (started) => (running.kernel = started),
                    },
                );
            } finally {
                ({ kernel, gate, gateFile, contextFile } = owned);
            }

            state = persistent.state;
            ctx.setKernel(admitted.segmentId, persistent);
        }

        if (!persistent || !state || !kernel) {
            throw new Error("Native process did not initialize");
        }

        const nativeState = state;

        running.kernel = kernel;
        await ctx.journal.attach(receipt.id, state.sessionFile, state.sessionId, kernel.pid);
        // Recheck after startup/catalog work, immediately before sending the user request.
        await ctx.authorize(binding, "admission", sessionId);

        const tail = new NativeTail(state.sessionFile, state.sessionId, binding.workspace);

        running.snapshot = () => readNativeSnapshot(kernel!, state!, binding.workspace, tail);

        let extensionError: RpcRecord | undefined;
        const detachExtensionErrors = kernel.onEvent((event) => {
            if (event.type === "extension_error") {
                extensionError = event;
            }
        });

        const timing = running.timing;

        if (timing) {
            // Detached when the run ends (`#track`), even when it throws: the process may serve the next run.
            timing.detach = kernel.onEvent((event) => timePromptEvent(timing, event));
        }

        if (hooks.onEvent) {
            detachHook = kernel.onEvent((event) => observeHook(hooks.onEvent!(event)));
            // Someone watches this run, so its dialogs (ask_user_question, permissions) can reach a person.
            kernel.forwardDialogs();
        }

        // Message-level durability: each persisted message is journaled as it lands, so a restart loses at most
        // the message in flight. The final snapshot below remains the authority for the outcome.
        detachProgress = kernel.onEvent((event) => {
            if (event.type === "thinking_level_changed") {
                nativeState.thinkingLevel = String(event.level);
                observeHook(hooks.onProgress?.());
            }

            if (
                event.type !== "message_end" ||
                !["prompt", "command"].includes(operation) ||
                progressFailure !== undefined ||
                !existsSync(nativeState.sessionFile)
            ) {
                return;
            }

            // Admit the whole write now, before a later tool event can enqueue a journal read.
            const writing = ctx.journal.progress(receipt.id, tail.read());

            progressQueue = Promise.all([progressQueue, writing])
                .then(async ([, count]) => {
                    if (count > 0) {
                        await hooks.onProgress?.();
                    }
                })
                .catch((error) => {
                    progressFailure = error;
                });
        });

        if (running.aborted) {
            throw new RpcFailure("rejected", "Stopped before prompt dispatch");
        }

        await prepareRetainedModel({
            persistent,
            binding,
            prepared,
            revision,
            prompt,
            rebind: rebind !== undefined,
            reusing,
            extensionError: () => extensionError,
        });

        const catalog = (await kernel.request({ type: "get_commands" })) as {
            commands?: Array<Record<string, unknown> & { name?: unknown }>;
        };

        await hooks.onCommands?.(catalog.commands ?? []);

        const builtins = await nativeBuiltinCommands();

        if (operation === "command") {
            const name = nativeCommandName(prompt);
            const dynamic = catalog.commands ?? [];

            if (!isKnownNativeCommand(prompt, [...dynamic, ...builtins])) {
                throw new RpcFailure("rejected", `Unknown native command: /${name ?? ""}`);
            }

            if (!builtins.some((command) => command.name === name)) {
                const source = dynamic.find((command) => command.name === name)?.source;

                if (source === "prompt" || source === "skill") {
                    await ctx.journal.classifyPromptExpansion(receipt.id);
                    operation = "prompt";
                    activeAttempt.operation = operation;
                }

                await hooks.onCommandAdmitted?.({
                    name: name!,
                    source,
                    args: nativeCommandArgs(prompt),
                });
            }
        }

        const sessionName = hooks.sessionName?.();

        if (
            operation !== "discover" &&
            sessionName &&
            state.sessionName !== sessionName &&
            nativeCommandName(prompt) !== "name"
        ) {
            await kernel.setSessionName(sessionName);
        }

        const { disposition, operation: completedOperation } = await runNativeOperation({
            ctx,
            binding,
            receipt,
            sessionId,
            requestId,
            kernel,
            builtins,
            running,
            hooks,
            images,
            rebind,
            extensionError: () => extensionError,
            prompt,
            operation,
        });

        operation = completedOperation;

        if (nativeCommandName(prompt) === "reload") {
            persistent.needsReload = false;
        }

        // Finalization must not outrun a live thinking write or hide its unknown outcome.
        await running.thinkingChange;

        const finalState = (await kernel.request({ type: "get_state" })) as {
            sessionId?: unknown;
            sessionFile?: unknown;
            sessionName?: unknown;
            thinkingLevel: string;
            model?: { provider?: unknown; id?: unknown };
        };

        if (
            rebind &&
            (finalState.model?.provider !== binding.provider ||
                finalState.model?.id !== binding.model)
        ) {
            throw new RpcFailure("unknown", "Native model does not match the admitted binding");
        }

        if (
            finalState.sessionId !== state.sessionId ||
            finalState.sessionFile !== state.sessionFile
        ) {
            throw new RpcFailure(
                "unknown",
                "An extension changed native session identity outside the Team session adapter",
            );
        }

        state.sessionName =
            typeof finalState.sessionName === "string" ? finalState.sessionName : undefined;
        state.thinkingLevel = finalState.thinkingLevel;

        // Native delays JSONL creation until the first conversation. Preserve confirmed /name readback now,
        // then restore it through set_session_name when the next native process starts.
        if (nativeCommandName(prompt) === "name" && typeof finalState.sessionName === "string") {
            await hooks.onSessionName?.(finalState.sessionName);
        }

        if (running.aborted) {
            // Stop is sticky in the native transport. Never reuse a stopped process.
            await ctx.retire(admitted.segmentId);
        }

        detachExtensionErrors();
        detachProgress();
        detachHook?.();

        await Promise.all([progressQueue, hookQueue]);

        if (progressFailure !== undefined) {
            throw progressFailure;
        }

        let entries: KernelEntry[];

        if (disposition === "handled") {
            // An extension-handled prompt may never create JSONL; its snapshot decides whether a binding exists.
            entries =
                !session.sessionFile && !existsSync(state.sessionFile)
                    ? []
                    : readNativeEntries(state.sessionFile, state.sessionId, binding.workspace);
        } else {
            entries = tail.read();

            if (!tail.complete) {
                throw new Error("Incomplete native session tail");
            }
        }

        // Close gate admission, then drain every admitted usage ACK before settling the attempt.
        gateState.active = undefined;
        await activeAttempt.usageWrites;
        const finished = await ctx.journal.finish(receipt.id, disposition, entries);

        persistent.revision = revision;
        gateState.active = undefined;
        closed = true;

        await hooks.onProgress?.();

        return finished;
    } catch (error) {
        // Team policy may reject before native startup. After startup only an explicit native rejection is known.
        if (
            error instanceof TeamResourcePolicyError &&
            !kernel &&
            !activeAttempt.inferenceAdmitted
        ) {
            await hooks.onEvent?.({
                type: "extension_ui_request",
                id: randomUUID(),
                method: "notify",
                notifyType: "error",
                message:
                    "Team blocked member agent customization. Use the shared profile or trusted project configuration.",
            });
            await hooks.onNativeResult?.({ resourcePolicyError: error.message });
        }

        failureStatus =
            ((error instanceof TeamResourcePolicyError && !kernel) ||
                (error instanceof RpcFailure && error.outcome === "rejected") ||
                error instanceof KernelRequestConflict) &&
            !activeAttempt.inferenceAdmitted
                ? "rejected"
                : "unknown";

        if (failureStatus === "unknown") {
            const message = error instanceof RpcFailure ? error.message : "";
            let failure: KernelFailure = "native-error";

            if (/^RPC record exceeds \d+ MiB$/.test(message)) {
                failure = "rpc-record-limit";
            } else if (message === "RPC acknowledgement deadline exceeded") {
                failure = "rpc-timeout";
            } else if (message === "kernel disconnected") {
                failure = "rpc-disconnected";
            }

            await ctx.journal.recordFailure(receipt.id, failure);
        }
    } finally {
        gateState.active = undefined;
        detachHook?.();
        detachProgress?.();
        await Promise.all([progressQueue, hookQueue]);

        try {
            await activeAttempt.usageWrites;
        } catch {
            failureStatus = "unknown";
        }

        if (progressFailure !== undefined) {
            failureStatus = "unknown";
        }

        if (!closed) {
            ctx.deleteKernel(admitted.segmentId);
            gate?.closeAllConnections();
            await new Promise<void>((resolve) => gate?.close(() => resolve()) ?? resolve());

            // Keep the active lease and account reservation until child close is observed. A close failure must not release the writer lock.
            if (kernel) {
                try {
                    await kernel.close();
                } catch (error) {
                    running.closureUnknown = true;
                    await ctx.journal.fail(receipt.id, "unknown");

                    throw error;
                }
            }

            if (gateFile) {
                rmSync(gateFile, { force: true });
            }

            if (contextFile) {
                rmSync(contextFile, { force: true });
            }
        }
    }

    const attached = (await ctx.journal.session(sessionId)).sessionFile;
    const unmaterialized =
        failureStatus === "rejected" &&
        !session.sessionFile &&
        attached !== undefined &&
        !existsSync(attached);

    return await ctx.journal.fail(
        receipt.id,
        failureStatus,
        unmaterialized,
        rebind ? admitted.binding : undefined,
    );
}
