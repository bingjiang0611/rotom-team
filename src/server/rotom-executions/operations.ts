import { memberConfigurationChanges, memberConfigurationSnapshot } from "../rotom-resources.ts";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { sendPhase } from "../send-trace.ts";
import {
    currentBranchGoalState,
    goalIsActive,
    nativeCommandArgs,
    nativeCommandName,
} from "./contracts.ts";
import { RpcFailure, type RpcRecord, type RotomRpc } from "../rotom-rpc.ts";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { RunHooks, Running } from "./contracts.ts";
import type { nativeBuiltinCommands } from "../rotom-kernel.ts";
import type { KernelBinding, KernelReceipt } from "../rotom-journal.ts";
import type { RunContext } from "./run.ts";

export async function runNativeOperation(args: {
    ctx: RunContext;
    binding: Readonly<KernelBinding>;
    receipt: KernelReceipt;
    kernel: RotomRpc;
    sessionId: string;
    requestId: string;
    builtins: Awaited<ReturnType<typeof nativeBuiltinCommands>>;
    running: Running;
    hooks: RunHooks;
    images: ImageContent[];
    rebind?: { binding: KernelBinding };
    extensionError: () => RpcRecord | undefined;
    prompt: string;
    operation: "prompt" | "compact" | "discover" | "command";
}): Promise<{
    disposition: "settled" | "handled";
    operation: "prompt" | "compact" | "discover" | "command";
}> {
    const {
        ctx,
        binding,
        receipt,
        kernel,
        builtins,
        sessionId,
        requestId,
        running,
        hooks,
        images,
        rebind,
        extensionError,
        prompt,
    } = args;
    let { operation } = args;
    const resourceSnapshot = memberConfigurationSnapshot(
        binding.home,
        join(ctx.data, "team-agent"),
    );
    let disposition: "settled" | "handled";

    if (operation === "discover") {
        await kernel.barrier();

        if (extensionError()) {
            throw new RpcFailure(
                "unknown",
                "Native startup discovery failed after extension execution",
            );
        }

        disposition = "handled";
    } else if (operation === "compact") {
        await kernel.compact(prompt);
        disposition = "settled";
    } else if (nativeCommandName(prompt) === "context") {
        const requested = nativeCommandArgs(prompt).toLowerCase();
        const view = requested === "" || requested === "usage" ? "usage" : requested;

        if (view !== "usage" && view !== "injections") {
            throw new RpcFailure("rejected", "Use /context [usage|injections]");
        }

        await hooks.onNativeResult?.({ context: await kernel.context(view) });
        disposition = "handled";
    } else if (nativeCommandName(prompt) === "tree") {
        const [entryId, option, ...extra] = nativeCommandArgs(prompt).split(/\s+/);

        if (extra.length || (option !== undefined && option !== "--summarize")) {
            throw new RpcFailure("rejected", "Use /tree <entryId> [--summarize]");
        }

        if (
            !(await ctx.journal.segmentEntries(receipt.segmentId)).some(
                (entry) => entry.id === entryId,
            )
        ) {
            throw new RpcFailure("rejected", "Select an entry from the current native segment.");
        }

        const navigation = await kernel.navigateTree(entryId!, option === "--summarize");

        await hooks.onNativeResult?.({ navigation });
        disposition = "handled";
    } else if (nativeCommandName(prompt) === "reload") {
        await kernel.command("/team-kernel-reload");
        disposition = "handled";
    } else if (nativeCommandName(prompt) === "name") {
        const name = nativeCommandArgs(prompt);

        if (!name) {
            throw new RpcFailure("rejected", "Native /name requires a session name");
        }

        await kernel.setSessionName(name);
        disposition = "handled";
    } else if (nativeCommandName(prompt) === "copy") {
        const result = (await kernel.request({ type: "get_last_assistant_text" })) as {
            text?: string;
        };

        await hooks.onNativeResult?.({ clipboard: result.text ?? "" });
        disposition = "handled";
    } else if (nativeCommandName(prompt) === "session") {
        const [state, stats] = await Promise.all([
            kernel.request({ type: "get_state" }),
            kernel.request({ type: "get_session_stats" }),
        ]);

        await hooks.onNativeResult?.({ state, stats });
        disposition = "handled";
    } else if (rebind && nativeCommandName(prompt) === "model") {
        // Records the native model_change; Team's selected level is reapplied after native clamping.
        await kernel.setModel(binding.provider, binding.model);

        if (binding.thinkingLevel) {
            await kernel.setThinkingLevel(binding.thinkingLevel);
        }

        disposition = "handled";
    } else if (nativeCommandName(prompt) === "thinking") {
        // Idle reasoning changes stay in this native session and process.
        const level = nativeCommandArgs(prompt);

        if (!/^[a-z]+$/.test(level)) {
            throw new RpcFailure("rejected", "Use /thinking <level>");
        }

        await kernel.setThinkingLevel(level);
        disposition = "handled";
    } else if (builtins.some((command) => command.name === nativeCommandName(prompt))) {
        throw new RpcFailure("rejected", "Native builtin requires the Team command adapter");
    } else {
        running.prompting = true;

        if (running.timing) {
            running.timing.dispatchedAt = performance.now();
        }

        sendPhase(sessionId, requestId, "dispatch");
        disposition = await kernel.prompt(prompt, undefined, images);
    }

    if (!running.aborted) {
        await ctx.journal.setPhase(receipt.id, "finalization");
    }

    if (["prompt", "command"].includes(operation)) {
        // A handled native command may own an active Goal even though it did not start an agent turn.
        running.prompting = true;
        let revision = kernel.activityRevision;

        await kernel.barrier();
        let goalState = currentBranchGoalState(await running.snapshot!());

        hooks.onNativeGoalState?.(goalState);

        const failure = extensionError();

        if (failure) {
            throw new Error(
                `Native extension command failed: ${String(failure.error ?? "unknown error")}`,
            );
        }

        // Goal owns the same native process and gate while active. Waiting/recovery has
        // no agent turn to settle, so wake on native activity instead of polling/relaunching.
        while (goalIsActive(goalState)) {
            await ctx.journal.setPhase(receipt.id, "execution");

            if (kernel.activityRevision === revision) {
                await kernel.waitForActivity(revision);
            }

            revision = kernel.activityRevision;

            if (running.aborted) {
                throw new RpcFailure("unknown", "Goal workflow stopped before terminal state");
            }

            if (!running.aborted) {
                await ctx.journal.setPhase(receipt.id, "finalization");
            }

            await kernel.barrier();

            if (extensionError()) {
                throw new RpcFailure("unknown", "Native extension failed during the Goal workflow");
            }

            goalState = currentBranchGoalState(await running.snapshot!());
            hooks.onNativeGoalState?.(goalState);
        }
    }

    if (operation === "command" && nativeCommandName(prompt) !== "reload") {
        const changed = memberConfigurationChanges(
            binding.home,
            join(ctx.data, "team-agent"),
            resourceSnapshot,
        );

        if (changed.length) {
            const message =
                "Team did not accept a change to member configuration. Edit the owner-managed shared profile instead. This attempt is unknown; do not replay it.";

            await hooks.onEvent?.({
                type: "extension_ui_request",
                id: randomUUID(),
                method: "notify",
                message,
                notifyType: "warning",
            });
            await hooks.onNativeResult?.({
                configurationError: message,
                changedDerivedFiles: changed,
            });

            throw new Error(message);
        }
    }

    return { disposition, operation };
}
