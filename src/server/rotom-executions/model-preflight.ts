import type { KernelBinding } from "../rotom-journal.ts";
import { RpcFailure, type RpcRecord } from "../rotom-rpc.ts";
import { nativeCommandName, type KernelLaunchContext, type PersistentKernel } from "./contracts.ts";

/** Apply a retained model epoch, or refresh resources before the next operation can infer. */
export async function prepareRetainedModel(args: {
    persistent: PersistentKernel;
    binding: Readonly<KernelBinding>;
    prepared: KernelLaunchContext | undefined;
    revision: string;
    prompt: string;
    rebind: boolean;
    reusing: boolean;
    extensionError: () => RpcRecord | undefined;
}): Promise<void> {
    const { persistent, binding, prepared, revision, prompt, rebind, reusing, extensionError } =
        args;
    const { kernel } = persistent;

    if (rebind && reusing) {
        // The model changes now. Only full extension resource reconstruction is deferred.
        persistent.rebind(binding, prepared);
        persistent.needsReload = true;
        await kernel.command("/team-kernel-rebind");
        await kernel.barrier();

        if (extensionError()) {
            throw new RpcFailure("unknown", "Native model rebind failed");
        }
    } else if (
        nativeCommandName(prompt) !== "reload" &&
        (persistent.needsReload || persistent.revision !== revision)
    ) {
        // Explicit /reload executes once in the operation adapter, before its normal finalization barrier.
        await kernel.command("/team-kernel-reload");
        await kernel.barrier();

        if (extensionError()) {
            throw new RpcFailure("unknown", "Native resource reload failed");
        }

        persistent.needsReload = false;
    }
}
