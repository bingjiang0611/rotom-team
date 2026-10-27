/** Native command adapters and Goal-owned completion on the already admitted process. */
import type { ImageContent } from "@earendil-works/pi-ai";
import type {
    AsyncRotomJournal,
    KernelBinding,
    KernelReceipt,
    KernelRebind,
} from "../rotom-journal.ts";
import { RpcFailure, type RotomRpc, type RpcRecord } from "../rotom-rpc.ts";
import { nativeBuiltinCommands } from "../rotom-kernel.ts";
import type { ActiveAttempt, RunHooks, Running } from "./contracts.ts";
import {
    nativeCommandName,
    nativeCommandArgs,
    currentBranchGoalState,
    goalIsActive,
} from "./native-prompt.ts";

export async function dispatchNative({
    journal,
    receipt,
    binding,
    kernel,
    operation,
    prompt,
    running,
    hooks,
    images,
    rebind,
    builtins,
    getExtensionError,
}: {
    journal: AsyncRotomJournal;
    receipt: KernelReceipt;
    binding: Readonly<KernelBinding>;
    kernel: RotomRpc;
    operation: ActiveAttempt["operation"];
    prompt: string;
    running: Running;
    hooks: RunHooks;
    images: ImageContent[];
    rebind: KernelRebind | undefined;
    builtins: Awaited<ReturnType<typeof nativeBuiltinCommands>>;
    getExtensionError: () => RpcRecord | undefined;
}): Promise<"settled" | "handled"> {
    if (operation === "discover") {
        await kernel.barrier();

        if (getExtensionError()) {
            throw new RpcFailure(
                "unknown",
                "Native startup discovery failed after extension execution",
            );
        }

        return "handled";
    } else if (operation === "compact") {
        await kernel.compact(prompt);

        return "settled";
    } else if (nativeCommandName(prompt) === "context") {
        const requested = nativeCommandArgs(prompt).toLowerCase();
        const view = requested === "" || requested === "usage" ? "usage" : requested;

        if (view !== "usage" && view !== "injections") {
            throw new RpcFailure("rejected", "Use /context [usage|injections]");
        }

        await hooks.onNativeResult?.({ context: await kernel.context(view) });

        return "handled";
    } else if (nativeCommandName(prompt) === "tree") {
        const [entryId, option, ...extra] = nativeCommandArgs(prompt).split(/\s+/);

        if (extra.length || (option !== undefined && option !== "--summarize")) {
            throw new RpcFailure("rejected", "Use /tree <entryId> [--summarize]");
        }

        if (
            !(await journal.segmentEntries(receipt.segmentId)).some((entry) => entry.id === entryId)
        ) {
            throw new RpcFailure("rejected", "Select an entry from the current native segment.");
        }

        const navigation = await kernel.navigateTree(entryId!, option === "--summarize");

        await hooks.onNativeResult?.({ navigation });

        return "handled";
    } else if (nativeCommandName(prompt) === "reload") {
        await kernel.command("/team-kernel-reload");

        return "handled";
    } else if (nativeCommandName(prompt) === "name") {
        const name = nativeCommandArgs(prompt);

        if (!name) {
            throw new RpcFailure("rejected", "Native /name requires a session name");
        }

        await kernel.setSessionName(name);

        return "handled";
    } else if (nativeCommandName(prompt) === "copy") {
        const result = (await kernel.request({ type: "get_last_assistant_text" })) as {
            text?: string;
        };

        await hooks.onNativeResult?.({ clipboard: result.text ?? "" });

        return "handled";
    } else if (nativeCommandName(prompt) === "session") {
        const [state, stats] = await Promise.all([
            kernel.request({ type: "get_state" }),
            kernel.request({ type: "get_session_stats" }),
        ]);

        await hooks.onNativeResult?.({ state, stats });

        return "handled";
    } else if (rebind && nativeCommandName(prompt) === "model") {
        // Records the native model_change; Team's selected level is reapplied after native clamping.
        await kernel.setModel(binding.provider, binding.model);

        if (binding.thinkingLevel) {
            await kernel.setThinkingLevel(binding.thinkingLevel);
        }

        return "handled";
    } else if (nativeCommandName(prompt) === "thinking") {
        // Idle reasoning changes stay in this native session and process.
        const level = nativeCommandArgs(prompt);

        if (!/^[a-z]+$/.test(level)) {
            throw new RpcFailure("rejected", "Use /thinking <level>");
        }

        await kernel.setThinkingLevel(level);

        return "handled";
    } else if (builtins.some((command) => command.name === nativeCommandName(prompt))) {
        throw new RpcFailure("rejected", "Native builtin requires the Team command adapter");
    } else {
        running.prompting = true;

        if (running.timing) {
            running.timing.dispatchedAt = performance.now();
        }

        return await kernel.prompt(prompt, undefined, images);
    }
}

export async function finishNativeGoal({
    journal,
    receipt,
    operation,
    running,
    kernel,
    hooks,
    getExtensionError,
}: {
    journal: AsyncRotomJournal;
    receipt: KernelReceipt;
    operation: ActiveAttempt["operation"];
    running: Running;
    kernel: RotomRpc;
    hooks: RunHooks;
    getExtensionError: () => RpcRecord | undefined;
}): Promise<void> {
    if (["prompt", "command"].includes(operation)) {
        // A handled native command may own an active Goal even though it did not start an agent turn.
        running.prompting = true;
        let revision = kernel.activityRevision;

        await kernel.barrier();
        let goalState = currentBranchGoalState(await running.snapshot!());

        hooks.onNativeGoalState?.(goalState);

        if (getExtensionError()) {
            throw new Error(
                `Native extension command failed: ${String(getExtensionError()!.error ?? "unknown error")}`,
            );
        }

        // Goal owns the same native process and gate while active. Waiting/recovery has
        // no agent turn to settle, so wake on native activity instead of polling/relaunching.
        while (goalIsActive(goalState)) {
            await journal.setPhase(receipt.id, "execution");

            if (kernel.activityRevision === revision) {
                await kernel.waitForActivity(revision);
            }

            revision = kernel.activityRevision;

            if (running.aborted) {
                throw new RpcFailure("unknown", "Goal workflow stopped before terminal state");
            }

            if (!running.aborted) {
                await journal.setPhase(receipt.id, "finalization");
            }

            await kernel.barrier();

            if (getExtensionError()) {
                throw new RpcFailure("unknown", "Native extension failed during the Goal workflow");
            }

            goalState = currentBranchGoalState(await running.snapshot!());
            hooks.onNativeGoalState?.(goalState);
        }
    }
}
