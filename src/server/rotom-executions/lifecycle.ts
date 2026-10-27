import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { teamResourceRevision } from "../rotom-resources.ts";
import { verifyRotomKernel } from "../rotom-kernel.ts";
import type { AsyncRotomJournal, KernelBinding, RotomJournal } from "../rotom-journal.ts";
import type { KernelLaunchContext, Owned, PersistentKernel, Running } from "./contracts.ts";
import type { RotomRpc } from "../rotom-rpc.ts";
const WARM_TOTAL = 3;
const WARM_UNUSED_MS = 5 * 60_000;

export type ExecutionLifecycleContext = {
    journal: AsyncRotomJournal;
    data: string;
    authorize: (
        binding: Readonly<KernelBinding>,
        operation: "admission" | "inference" | "refresh" | "fork",
        sessionId: string,
    ) => Promise<unknown>;
    prepare?: (binding: Readonly<KernelBinding>, sessionId: string) => KernelLaunchContext;
    running: Map<string, Set<Running>>;
    kernels: Map<string, PersistentKernel>;
    unused: Map<
        string,
        { sessionId: string; binding: Readonly<KernelBinding>; timer: NodeJS.Timeout }
    >;
    warming: Map<string, { memberId: string; done: Promise<boolean> }>;
    isClosing: () => boolean;
    setClosing: () => void;
    active: () => number;
    launch: (
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
};

export function createExecutionLifecycle(owner: ExecutionLifecycleContext) {
    return {
        /**
         * Start a native process for `binding` on its session, with its own spending gate: the gate admits a request only
         * for `gateState.active`, so a process started with nothing active can spend nothing. `owned` holds each resource
         * as it is made, for the caller to close should this fail. Not entered in `kernels`: the caller does that.
         */
        async launch(
            binding: Readonly<KernelBinding>,
            sessionId: string,
            sessionFile: string | undefined,
            prepared: KernelLaunchContext | undefined,
            gateState: PersistentKernel["gateState"],
            name: string,
            revision: string,
            owned: Owned,
            hooks: { beforeStart?: () => void; started?: (kernel: RotomRpc) => void } = {},
        ): Promise<PersistentKernel> {
            return owner.launch(
                binding,
                sessionId,
                sessionFile,
                prepared,
                gateState,
                name,
                revision,
                owned,
                hooks,
            );
        },

        /**
         * Start session `sessionId`'s native process before its member sends, so the send finds it ready. Only for an idle
         * session on the pinned kernel, after the same admission checks as a send, and only one unused warm process per
         * member and `WARM_TOTAL` in all: a member's warm process for another session is retired for this one. The process
         * gets its own spending gate with nothing active, so it can spend nothing until a request is admitted. Unused, it
         * retires after `WARM_UNUSED_MS`. Resolves to whether the session has a process now; never throws.
         */
        async warm(sessionId: string): Promise<boolean> {
            try {
                const admitted = await owner.journal.session(sessionId);
                const segmentId = admitted.segmentId;
                const memberId = admitted.binding.memberId;
                const pending = owner.warming.get(segmentId);

                if (pending) {
                    return await pending.done;
                }

                if (owner.kernels.has(segmentId)) {
                    return true;
                }

                if (
                    owner.isClosing() ||
                    (owner.running.get(sessionId)?.size ?? 0) > 0 ||
                    verifyRotomKernel().version !== admitted.binding.kernelVersion
                ) {
                    return false;
                }

                for (const [other, each] of owner.unused) {
                    if (each.binding.memberId === memberId) {
                        await this.retireUnusedInternal(other);
                    }
                }

                // Checked again after that wait, with nothing awaited from here until this start is in `warming`: a send
                // that began meanwhile keeps its own start, and one that begins later waits for this one.
                if (
                    owner.isClosing() ||
                    owner.warming.has(segmentId) ||
                    owner.kernels.has(segmentId) ||
                    (owner.running.get(sessionId)?.size ?? 0) > 0 ||
                    [...owner.warming.values()].some((each) => each.memberId === memberId) ||
                    owner.unused.size + owner.warming.size >= WARM_TOTAL
                ) {
                    return false;
                }

                const done = this.warmStart(sessionId, admitted).finally(() =>
                    owner.warming.delete(segmentId),
                );

                owner.warming.set(segmentId, { memberId, done });

                return await done;
            } catch {
                return false;
            }
        },

        async warmStart(
            sessionId: string,
            admitted: ReturnType<RotomJournal["session"]>,
        ): Promise<boolean> {
            const binding = Object.freeze(admitted.binding);
            const owned: Owned = {};

            try {
                await owner.authorize(binding, "admission", sessionId);
                const prepared = owner.prepare?.(binding, sessionId);
                const revision = teamResourceRevision(
                    join(owner.data, "team-agent"),
                    binding.workspace,
                );
                const persistent = await owner.launch(
                    binding,
                    sessionId,
                    (await owner.journal.session(sessionId)).sessionFile,
                    prepared,
                    {},
                    `warm-${randomUUID()}`,
                    revision,
                    owned,
                );

                // Admission checks awaited; the session must still be where it was. A request that came meanwhile waits
                // for this start (`execute`), and takes this process.
                if (
                    owner.isClosing() ||
                    (await owner.journal.session(sessionId)).segmentId !== admitted.segmentId ||
                    owner.kernels.has(admitted.segmentId)
                ) {
                    throw new Error("The session moved on while its process started");
                }

                owner.kernels.set(admitted.segmentId, persistent);
                const timer = setTimeout(
                    () => void this.retireUnusedInternal(admitted.segmentId).catch(() => {}),
                    WARM_UNUSED_MS,
                );

                timer.unref();
                owner.unused.set(admitted.segmentId, { sessionId, binding, timer });

                return true;
            } catch {
                owned.gate?.closeAllConnections();
                await new Promise<void>(
                    (resolve) => owned.gate?.close(() => resolve()) ?? resolve(),
                );
                await owned.kernel?.close().catch(() => {});

                for (const file of [owned.gateFile, owned.contextFile]) {
                    if (file) {
                        rmSync(file, { force: true });
                    }
                }

                return false;
            }
        },

        /** A request took this segment's process: it is no longer a warm process waiting to be used. */
        used(segmentId: string): void {
            clearTimeout(owner.unused.get(segmentId)?.timer);
            owner.unused.delete(segmentId);
        },

        /** Retire this segment's warm process if no request has used it; it leaves `kernels` before it closes. */
        async retireUnusedInternal(segmentId: string): Promise<void> {
            if (!owner.unused.has(segmentId)) {
                return;
            }

            // Out of `kernels` at once, before any wait: no request may take a process that is closing.
            const persistent = owner.kernels.get(segmentId);

            this.used(segmentId);
            owner.kernels.delete(segmentId);

            if (persistent) {
                await this.closePersistent(persistent);
            }
        },

        /** The warm processes no request has used yet: their segment, session and binding. */
        unusedWarm(): { segmentId: string; sessionId: string; binding: Readonly<KernelBinding> }[] {
            return [...owner.unused].map(([segmentId, { sessionId, binding }]) => ({
                segmentId,
                sessionId,
                binding,
            }));
        },

        /** Retire this segment's warm process, should no request have used it yet. */
        retireUnused(segmentId: string): Promise<void> {
            return this.retireUnusedInternal(segmentId);
        },

        /** Retire every warm process of `memberId` no request has used: their account changed. */
        async retireUnusedOf(memberId: string): Promise<void> {
            for (const { segmentId, binding } of this.unusedWarm()) {
                if (binding.memberId === memberId) {
                    await this.retireUnusedInternal(segmentId);
                }
            }
        },

        async retire(segmentId: string): Promise<void> {
            // A warm start on its way finishes first, so what it started is retired too.
            await owner.warming.get(segmentId)?.done;
            this.used(segmentId);
            const persistent = owner.kernels.get(segmentId);

            if (!persistent) {
                return;
            }

            persistent.gateState.active = undefined;
            persistent.gate.closeAllConnections();
            await new Promise<void>((resolve) => persistent.gate.close(() => resolve()));

            await persistent.kernel.close();
            owner.kernels.delete(segmentId);
            rmSync(persistent.gateFile, { force: true });

            if (persistent.contextFile) {
                rmSync(persistent.contextFile, { force: true });
            }
        },

        /** Close a process already out of `kernels`, and its gate and files. */
        async closePersistent(persistent: PersistentKernel): Promise<void> {
            persistent.gateState.active = undefined;
            persistent.gate.closeAllConnections();
            await new Promise<void>((resolve) => persistent.gate.close(() => resolve()));
            await persistent.kernel.close();
            rmSync(persistent.gateFile, { force: true });

            if (persistent.contextFile) {
                rmSync(persistent.contextFile, { force: true });
            }
        },

        close(): Promise<void> {
            if (owner.active()) {
                throw new Error(
                    "Kernel executions are still active; do not release the writer lock",
                );
            }

            owner.setClosing();

            return (async () => {
                await Promise.all([...owner.warming.values()].map((each) => each.done));

                for (const segmentId of [...owner.kernels.keys()]) {
                    await this.retire(segmentId);
                }

                await owner.journal.close();
            })();
        },
    };
}
