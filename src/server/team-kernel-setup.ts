import { join } from "node:path";
import { mkdirSync, lstatSync, realpathSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { User } from "./config.ts";
import type { PocketApp } from "./app.ts";
import type { RotomExecutions } from "./rotom-executions.ts";
import {
    NativeSetupDoc,
    NativeConfigurationsDoc,
    type NativeConfigurations,
    type NativeLive,
} from "./team-kernel-docs.ts";
import { HttpError } from "./errors.ts";
import { accountContext } from "./team-accounts.ts";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import type { KernelBinding, KernelReceipt } from "./rotom-journal.ts";
import type { ReceiptView, SubmissionOwner } from "./team-kernel-submission.ts";
export type SetupOwner = SubmissionOwner & {
    app: PocketApp;
    executions: RotomExecutions;
    ready: Set<ConversationId>;
    configurations: Map<ConversationId, NativeConfigurations>;
    active: Set<{ id: ConversationId; binding: KernelBinding; promise: Promise<unknown> }>;
    live: Map<ConversationId, NativeLive>;
    home: (memberId: string) => string;
    ensureBound: (id: ConversationId) => Promise<void>;
    mirror: (id: ConversationId) => Promise<void>;
    receipt: (receipt: KernelReceipt) => Promise<ReceiptView>;
};

export function createSetupDomain(owner: SetupOwner) {
    return {
        home(memberId: string): string {
            if (!/^[a-zA-Z0-9_-]{1,128}$/.test(memberId)) {
                throw new Error("Invalid native member identity");
            }

            const parent = join(owner.app.dataDir, "kernel-homes");

            for (const path of [parent, join(parent, memberId)]) {
                mkdirSync(path, { recursive: true, mode: 0o700 });

                if (
                    realpathSync(path) !== path ||
                    !lstatSync(path).isDirectory() ||
                    lstatSync(path).mode & 0o077
                ) {
                    throw new Error("Native HOME must be canonical and private");
                }
            }

            return join(parent, memberId);
        },

        /** Reconcile only binding metadata. No provider request or history seed is resumed here. */
        async ensureBound(id: ConversationId): Promise<void> {
            const app = owner.app;

            if (app.sessionMeta(id)?.backend !== "rotom") {
                throw new Error("Native setup requires committed native session metadata");
            }

            const journal = owner.executions.journal;
            const exists = await journal.hasConversation(String(id));
            const setup = await app.harness.snapshot(NativeSetupDoc, id, BACKGROUND_CONTEXT);
            // Pre-setup-document deployments are recoverable only from their original immutable journal binding.
            const binding =
                setup?.binding ??
                (exists ? (await journal.segment(String(id))).binding : undefined);

            if (!binding || (!exists && setup?.bound)) {
                throw new Error(
                    "Native execution journal is missing; restore/reconcile it, never reconstruct prior execution from current settings",
                );
            }

            if (
                binding.home !== join(app.dataDir, "kernel-homes", binding.memberId) ||
                binding.workspace !== app.sessionMeta(id)?.cwd
            ) {
                throw new Error("Native setup identity does not match application metadata");
            }

            owner.home(binding.memberId);
            await journal.bind(String(id), binding);

            if (!setup?.bound) {
                await app.harness.commit(async (tx) => {
                    Object.assign(await tx.doc(NativeSetupDoc, id), { binding, bound: true });
                }, BACKGROUND_CONTEXT);
            }

            if (
                !setup?.seed ||
                (await journal.request(String(id), setup.seed.requestId))?.status === "settled"
            ) {
                owner.ready.add(id);
            }
        },

        async reconcile(ids: readonly ConversationId[]): Promise<void> {
            const native = ids.filter((id) => owner.app.sessionMeta(id)?.backend === "rotom");

            await owner.executions.journal.reconcileOrphans(new Set(native.map(String)));
            // A missing native PID proves neither tool closure nor the outcome of an external request.
            // Historical unknown attempts retain their fences; startup must not classify them as interrupted.

            for (const id of native) {
                const configurations = await owner.app.harness.snapshot(
                    NativeConfigurationsDoc,
                    id,
                    BACKGROUND_CONTEXT,
                );

                if (configurations) {
                    owner.configurations.set(id, configurations);
                }

                await owner.ensureBound(id);
                // Catch the display up with the journal: entries of runs that ended while the mirror was behind.
                await owner.mirror(id);
            }
        },

        /** Account changes wait for every run of the member; starting runs in other sessions does not. */
        async requireAccountIdle(user: User): Promise<void> {
            const pending = await owner.executions.journal.pending(user.id);

            if (pending) {
                throw new HttpError(
                    409,
                    `Your account is still running in session ${pending.sessionId}, or its outcome there is unknown. Wait for it to finish or stop it first.`,
                );
            }
        },

        isRunning(id: ConversationId): boolean {
            return [...owner.active].some((run) => run.id === id);
        },

        async needsAnswer(id: ConversationId, viewer?: User): Promise<boolean> {
            const waiting = (owner.live.get(id)?.dialogs?.length ?? 0) > 0;

            if (!waiting || viewer === undefined) {
                return waiting;
            }

            return (
                (await owner.executions.journal.session(String(id))).binding.memberId === viewer.id
            );
        },

        async snapshot(id: ConversationId, user: User) {
            owner.app.requireSee(user, id);

            if (!(await owner.executions.journal.hasConversation(String(id)))) {
                throw new HttpError(
                    409,
                    "Native initialization is incomplete; reconcile setup before execution.",
                );
            }

            if (owner.app.sessionMeta(id)?.backend !== "rotom") {
                throw new HttpError(409, "This conversation does not use rotom.");
            }

            const journal = owner.executions.journal;
            const messages = (await journal.entries(String(id))).flatMap(({ entry }) =>
                entry.type === "message" && entry.message ? [entry.message] : [],
            );
            const publicMessages = accountContext(
                { messages } as TranscriptContext,
                "",
                "",
            ).messages;
            const { binding, segmentId } = await journal.session(String(id));

            return {
                backend: "rotom",
                history: "immutable-audit",
                initializing: !owner.ready.has(id),
                segmentId,
                memberId: binding.memberId,
                provider: binding.provider,
                model: binding.model,
                configurationDigest: binding.configurationDigest,
                thinkingLevel: await owner.executions.thinkingLevel(String(id)),
                messages: publicMessages,
                receipts: await Promise.all(
                    (await journal.receipts(String(id))).map(async (receipt) => ({
                        ...(await owner.receipt(receipt)),
                        memberId: receipt.binding.memberId,
                    })),
                ),
                receiptsLimit: 100,
                usage: await journal.usage(String(id)),
                credits: await journal.credits(String(id)),
                costStatus: "unknown",
                // Do not fold provisional output into the durable transcript or the old Durable spend counter.
                streaming: owner.isRunning(id),
            };
        },
    };
}

export type SetupDomain = ReturnType<typeof createSetupDomain>;
