import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { User } from "./config.ts";
import type { ConfigurationSnapshot } from "./team-profiles.ts";
import type { PocketApp } from "./app.ts";
import type { RotomExecutions } from "./rotom-executions.ts";
import type { KernelBinding, KernelReceipt, RotomJournal } from "./rotom-journal.ts";
import { HttpError } from "./errors.ts";
import { KernelRequestConflict } from "./rotom-journal.ts";
import { verifyRotomKernel } from "./rotom-kernel.ts";
import type { ModelRef, ConversationId } from "@earendil-works/pi-durable";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
    NativeCommandResultsDoc,
    NativeConfigurationsDoc,
    NativeForksDoc,
    type NativeConfigurations,
    type NativeCommandCatalog,
    type NativeLive,
} from "./team-kernel-docs.ts";
import type { SubmissionOwner } from "./team-kernel-submission.ts";

export type HistoryOwner = SubmissionOwner & {
    app: PocketApp;
    executions: RotomExecutions;
    operations: Map<string, { operation: string; identity: string; promise: Promise<unknown> }>;
    configurations: Map<ConversationId, NativeConfigurations>;
    commands: Map<ConversationId, NativeCommandCatalog>;
    live: Map<ConversationId, NativeLive>;
    historicalGoals: Map<string, { rowid: number; version: string; value: unknown }>;
    nativeGoals: Map<ConversationId, unknown>;
    active: Set<{ id: ConversationId; binding: KernelBinding; promise: Promise<KernelReceipt> }>;
    ready: Set<ConversationId>;
    remoteStorage: boolean;
    id: (value: string) => ConversationId;
    check: (
        binding: KernelBinding,
        id: ConversationId,
        staged?: ConfigurationSnapshot,
    ) => Promise<User>;
    submit: (
        id: ConversationId,
        user: User,
        requestId: string,
        text: string,
        wait?: boolean,
        attachments?: import("./commands.ts").Attachment[],
    ) => Promise<unknown>;
    forkIdentity: (id: ConversationId, key: string, operation: string) => Promise<void>;
    mirror: (id: ConversationId) => Promise<void>;
};

export function createHistoryDomain(owner: HistoryOwner) {
    return {
        async lookup(id: ConversationId, user: User, requestId: string, operation: string) {
            const key = owner.request(id, user, requestId, false, operation);

            if (
                !["submit", "handoff", "compact", "fork", "configuration", "discover"].includes(
                    operation,
                )
            ) {
                throw new HttpError(400, "Unknown native operation.");
            }

            await owner.forkIdentity(id, key, operation);
            let targetId: ConversationId | null = id;

            if (operation === "fork") {
                targetId =
                    (await owner.app.harness.snapshot(NativeForksDoc, id, BACKGROUND_CONTEXT))
                        ?.items[key]?.id ?? null;

                if (targetId !== null) {
                    owner.app.requireSee(user, targetId);
                }
            }

            if (operation === "configuration" && !owner.configurations.get(id)?.requests[key]) {
                targetId = null;
            }

            const receipt =
                targetId === null
                    ? undefined
                    : await owner.executions.journal.request(String(targetId), key);

            if (
                receipt &&
                (operation === "submit"
                    ? !["prompt", "command", "compact"].includes(receipt.operation)
                    : receipt.operation !== (operation === "configuration" ? "handoff" : operation))
            ) {
                throw new HttpError(409, "Request belongs to another operation.");
            }

            const preparedOnly =
                ["fork", "configuration"].includes(operation) &&
                targetId !== null &&
                !receipt &&
                !owner.operations.has(JSON.stringify([id, key]));

            const nativeResult =
                operation === "submit"
                    ? (
                          await owner.app.harness.snapshot(
                              NativeCommandResultsDoc,
                              id,
                              BACKGROUND_CONTEXT,
                          )
                      )?.items[key]
                    : undefined;

            return {
                targetId,
                receipt: receipt ? await owner.receipt(receipt) : null,
                ...(nativeResult === undefined ? {} : { nativeResult }),
                ...(preparedOnly ? { preparedOnly: true } : {}),
            };
        },

        async configure(id: ConversationId, user: User, requestId: string, expectedHead: string) {
            const key = owner.request(id, user, requestId, true, "configuration");

            if (typeof expectedHead !== "string" || !expectedHead || expectedHead.length > 128) {
                throw new HttpError(400, "The observed segmentId is required.");
            }

            const app = owner.app;

            return app.execution.exclusive(id, async () => {
                const prior = owner.configurations.get(id)?.requests[key];

                if (prior) {
                    if (prior.expectedHead !== expectedHead) {
                        throw new HttpError(409, "Configuration request identity changed.");
                    }

                    const receipt = await owner.executions.journal.request(String(id), key);

                    return { receipt: receipt ? await owner.receipt(receipt) : null };
                }

                const journal = owner.executions.journal;
                const source = await journal.session(String(id));

                if (await journal.request(String(id), key)) {
                    throw new HttpError(409, "Request belongs to another operation.");
                }

                if (source.binding.memberId !== user.id) {
                    throw new HttpError(
                        403,
                        "Take over with your own account before activating a profile.",
                    );
                }

                if (
                    source.segmentId !== expectedHead ||
                    (await journal.pendingConversation(String(id)))
                ) {
                    throw new HttpError(
                        409,
                        "Source changed or is active/unknown; reconcile before activation.",
                    );
                }

                const current = app.config.userById(user.id);

                if (!current) {
                    throw new HttpError(403, "Membership ended.");
                }

                app.requireSee(current, id);
                await app.requireDriver(id, current, "rotom");
                const captured = app.profiles.capture(
                    current,
                    source.binding.workspace,
                    app.settings.getSkillPaths(),
                );
                const initial = app.profiles.snapshot(id);
                const snapshot =
                    owner.configurations.get(id)?.snapshots[captured.digest] ??
                    (initial?.digest === captured.digest ? initial : captured);
                const binding = {
                    ...source.binding,
                    kernelVersion: verifyRotomKernel().version,
                    configurationDigest: snapshot.digest,
                };

                await owner.check(binding, id, snapshot);
                await app.harness.commit(async (tx) => {
                    const configurations = await tx.doc(NativeConfigurationsDoc, id);

                    configurations.snapshots[snapshot.digest] ??= snapshot;
                    configurations.requests[key] = { expectedHead, binding };
                }, BACKGROUND_CONTEXT);
                owner.configurations.set(
                    id,
                    (await app.harness.snapshot(NativeConfigurationsDoc, id, BACKGROUND_CONTEXT))!,
                );
                const receipt = await owner.track(
                    id,
                    binding,
                    owner.executions.handoff(String(id), key, expectedHead, binding),
                );

                return { receipt };
            });
        },

        async compact(id: ConversationId, user: User, requestId: string, instructions: string) {
            const key = owner.request(id, user, requestId);

            if (typeof instructions !== "string") {
                throw new HttpError(400, "Compaction instructions must be text.");
            }

            const previous = await owner.executions.journal.existing(
                String(id),
                key,
                instructions,
                "compact",
            );

            if (previous) {
                return await owner.receipt(previous);
            }

            const binding = (await owner.upgradeKernel(id, user)).binding;

            if (binding.memberId !== user.id) {
                throw new HttpError(403, "Take over with your own account before compacting.");
            }

            return owner.track(
                id,
                binding,
                owner.executions.compact(String(id), key, instructions),
            );
        },

        async fork(
            id: ConversationId,
            user: User,
            requestId: string,
            expectedHead: string,
            entryId?: string,
            clone = false,
        ) {
            const key = owner.request(id, user, requestId);

            if (typeof expectedHead !== "string" || !expectedHead) {
                throw new HttpError(400, "The observed source head is required.");
            }

            const app = owner.app;

            return app.execution.exclusive(id, async () => {
                const current = app.config.userById(user.id);

                if (!current) {
                    throw new HttpError(403, "Membership ended.");
                }

                app.commands.requireForkable(id, current, "rotom");
                const prior = (await app.harness.snapshot(NativeForksDoc, id, BACKGROUND_CONTEXT))
                    ?.items[key];

                if (prior) {
                    if (
                        prior.expectedHead !== expectedHead ||
                        prior.entryId !== entryId ||
                        Boolean(prior.clone) !== clone
                    ) {
                        throw new HttpError(409, "Fork request identity changed.");
                    }

                    app.requireSee(current, prior.id);
                    const receipt = await owner.executions.journal.request(String(prior.id), key);

                    return { id: prior.id, receipt: receipt ? await owner.receipt(receipt) : null };
                }

                const journal = owner.executions.journal;

                const source = await journal.session(String(id));

                if (
                    source.segmentId !== expectedHead ||
                    (await journal.pendingConversation(String(id)))
                ) {
                    throw new HttpError(
                        409,
                        "Source changed or has an active/unknown operation; refresh and reconcile before fork.",
                    );
                }

                if (entryId) {
                    const selected = (await journal.segmentEntries(expectedHead)).find(
                        (entry) => entry.id === entryId,
                    );

                    if (
                        selected?.type !== "message" ||
                        (selected.message as { role?: unknown } | undefined)?.role !== "user"
                    ) {
                        throw new HttpError(400, "Select a user message from this native segment.");
                    }
                }

                const meta = app.sessionMeta(id)!;
                const target = await app.commands.createSession(
                    current,
                    {
                        backend: "rotom",
                        cwd: meta.cwd,
                        title: `${meta.title ?? "New session"} · ${clone ? "Copy" : "Fork"}`,
                    },
                    {
                        sourceId: id,
                        requestId: key,
                        expectedHead,
                        ...(entryId ? { entryId } : {}),
                        ...(clone ? { clone: true } : {}),
                    },
                );
                const binding = (await journal.session(String(target.id))).binding;
                const receipt = await owner.track(
                    target.id,
                    binding,
                    owner.executions.fork(
                        String(id),
                        String(target.id),
                        key,
                        expectedHead,
                        entryId,
                        clone,
                    ),
                );

                if (receipt.status === "settled") {
                    owner.ready.add(target.id);
                }

                app.kernelChanged();

                return { id: target.id, receipt };
            });
        },

        async upgradeKernel(
            id: ConversationId,
            user: User,
            source?: Awaited<ReturnType<RotomJournal["session"]>>,
        ) {
            const journal = owner.executions.journal;

            source ??= await journal.session(String(id));
            const version = verifyRotomKernel().version;

            if (source.binding.memberId !== user.id || source.binding.kernelVersion === version) {
                return source;
            }

            if (owner.isRunning(id)) {
                throw new HttpError(409, "Pi is working. Wait for it to finish or Stop it first.");
            }

            const binding = { ...source.binding, kernelVersion: version };

            await owner.check(binding, id);

            try {
                await journal.upgradeKernel(String(id), source.segmentId, version);
            } catch (error) {
                if (error instanceof KernelRequestConflict) {
                    throw new HttpError(409, `${error.message}.`);
                }

                throw error;
            }

            return journal.session(String(id));
        },

        async handoff(
            id: ConversationId,
            user: User,
            requestId: string,
            expectedHead: string,
            selected?: { model: ModelRef; thinkingLevel: ModelThinkingLevel },
        ) {
            const key = owner.request(id, user, requestId);

            if (typeof expectedHead !== "string" || !expectedHead || expectedHead.length > 128) {
                throw new HttpError(400, "The observed segmentId is required.");
            }

            const journal = owner.executions.journal;
            const previous = await journal.request(String(id), key);

            if (previous) {
                await journal.existing(
                    String(id),
                    key,
                    JSON.stringify({ expectedHead, binding: previous.binding }),
                    "handoff",
                );

                return await owner.receipt(previous);
            }

            owner.app.requireSteer(user);
            const source = await journal.session(String(id));

            if (source.segmentId !== expectedHead) {
                throw new HttpError(409, "Conversation head changed; refresh before handoff.");
            }

            if (await journal.pendingConversation(String(id))) {
                throw new HttpError(
                    409,
                    "A native operation is active or unknown; reconcile it before handoff.",
                );
            }

            await owner.app.requireDriver(id, user, "rotom");
            await owner.app.accounts.forUser(user);
            const { model: choice, thinkingLevel } =
                selected ?? owner.app.commands.defaultModel(user);

            if (!choice) {
                throw new HttpError(409, "Choose a model from your own connected account first.");
            }

            const model = owner.app.accounts.kernelModel(user, choice);
            const home = join(owner.app.dataDir, "kernel-homes", user.id);

            mkdirSync(home, { recursive: true, mode: 0o700 });
            const binding: KernelBinding = {
                ...source.binding,
                kernelVersion: verifyRotomKernel().version,
                memberId: user.id,
                home,
                accountGeneration: choice.provider,
                provider: model.provider,
                model: model.id,
                thinkingLevel,
            };

            return owner.track(
                id,
                binding,
                owner.executions.handoff(String(id), key, expectedHead, binding),
            );
        },

        async receipt(receipt: KernelReceipt) {
            const configuration = owner.configurations.get(owner.id(receipt.sessionId))?.requests[
                receipt.requestId
            ];

            if (configuration) {
                if (
                    Object.entries(receipt.binding).some(
                        ([key, value]) =>
                            configuration.binding[key as keyof KernelBinding] !== value,
                    )
                ) {
                    throw new HttpError(409, "Configuration receipt binding changed.");
                }

                await owner.executions.journal.existing(
                    receipt.sessionId,
                    receipt.requestId,
                    JSON.stringify({
                        expectedHead: configuration.expectedHead,
                        binding: receipt.binding,
                    }),
                    "handoff",
                );
            }

            return {
                id: receipt.id,
                requestId: receipt.requestId,
                status: receipt.status,
                operation: configuration ? "configuration" : receipt.operation,
                phase: receipt.phase,
                failure: receipt.failure,
            };
        },

        async track(id: ConversationId, binding: KernelBinding, promise: Promise<KernelReceipt>) {
            const run = { id, binding, promise };

            owner.nativeGoals.delete(id);
            owner.active.add(run);
            owner.app.kernelChanged();

            let finished = false;

            try {
                const receipt = await run.promise;

                if (["unknown", "rejected", "interrupted"].includes(receipt.status)) {
                    const cached = owner.commands.get(id);

                    if (cached) {
                        cached.invalidated = true;
                    }
                }

                await owner.mirror(id);
                finished =
                    receipt.operation === "prompt" &&
                    ["settled", "interrupted"].includes(receipt.status);

                return await owner.receipt(receipt);
            } finally {
                owner.active.delete(run);

                if (!owner.isRunning(id)) {
                    owner.live.delete(id);
                    owner.nativeGoals.delete(id);
                }

                if (finished) {
                    await owner.app.recordRunFinished(id);
                }

                owner.app.kernelChanged();
                owner.app.roomChanged(id);
            }
        },
    };
}

export type HistoryDomain = ReturnType<typeof createHistoryDomain>;
