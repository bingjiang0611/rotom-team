import { randomUUID } from "node:crypto";
import { clampThinkingLevel, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { User } from "./config.ts";
import { HttpError } from "./errors.ts";
import type { NativeCommandCatalog } from "./team-kernel-docs.ts";
import { THINKING_LEVELS } from "./commands.ts";
import { KernelRequestConflict, type KernelBinding } from "./rotom-journal.ts";
import { RpcFailure } from "./rotom-rpc.ts";
import type { SubmissionOwner } from "./team-kernel-submission.ts";

export type ModelOwner = SubmissionOwner & {
    commands: Map<ConversationId, NativeCommandCatalog>;
    live: Map<ConversationId, unknown>;
};

export function createModelDomain(owner: ModelOwner) {
    return {
        async chooseModel(id: ConversationId, user: User, body: unknown, requestId?: string) {
            const request = body as {
                model?: { provider?: unknown; modelId?: unknown };
                thinkingLevel?: unknown;
            } | null;

            if (
                !request ||
                typeof request !== "object" ||
                Object.keys(request).length === 0 ||
                Object.keys(request).some((key) => key !== "model" && key !== "thinkingLevel") ||
                (request.model !== undefined &&
                    (typeof request.model?.provider !== "string" ||
                        typeof request.model.modelId !== "string")) ||
                (request.thinkingLevel !== undefined &&
                    !THINKING_LEVELS.has(String(request.thinkingLevel)))
            ) {
                throw new HttpError(
                    400,
                    "A rotom session changes only its model {provider, modelId} and thinkingLevel; its folder is fixed.",
                );
            }

            owner.app.requireSteer(user);
            owner.app.requireSee(user, id);

            const prior = requestId
                ? await owner.executions.journal.request(
                      String(id),
                      owner.request(id, user, requestId),
                  )
                : undefined;

            if (prior?.operation === "command" && request.model === undefined) {
                // An idle thinking change ran as the native /thinking command in the same session.
                try {
                    await owner.executions.journal.existing(
                        String(id),
                        prior.requestId,
                        `/thinking ${String(request.thinkingLevel)}`,
                        "command",
                    );
                } catch (error) {
                    if (error instanceof KernelRequestConflict) {
                        throw new HttpError(409, "Model command request identity changed.");
                    }

                    throw error;
                }

                return { receipt: await owner.receipt(prior) };
            }

            if (prior) {
                const model = request.model;
                const matches =
                    (prior.operation === "handoff" ||
                        (prior.operation === "command" && model !== undefined)) &&
                    (!model ||
                        ((model.provider === prior.binding.provider ||
                            model.provider === prior.binding.accountGeneration) &&
                            model.modelId === prior.binding.model)) &&
                    (request.thinkingLevel === undefined ||
                        request.thinkingLevel === prior.binding.thinkingLevel);

                if (!matches) {
                    throw new HttpError(409, "Model command request identity changed.");
                }

                return { receipt: await owner.receipt(prior) };
            }

            if (owner.isRunning(id) && request.model === undefined) {
                await owner.app.requireDriver(id, user, "rotom");
                const { binding } = await owner.executions.journal.session(String(id));

                if (binding.memberId !== user.id) {
                    throw new HttpError(
                        409,
                        "Only the paying member can change thinking during this run.",
                    );
                }

                try {
                    const level = await owner.executions.setThinkingLevel(
                        String(id),
                        String(request.thinkingLevel),
                    );

                    owner.app.accounts.choose(user, {
                        ...owner.ref(binding),
                        thinkingLevel: level,
                    });
                    owner.app.roomChanged(id);

                    return { receipt: null };
                } catch (error: unknown) {
                    if (error instanceof RpcFailure) {
                        throw new HttpError(
                            409,
                            `Thinking change outcome is ${error.outcome}: ${error.message}`,
                        );
                    }

                    throw error;
                }
            }

            if (
                owner.isRunning(id) ||
                (await owner.executions.journal.pendingConversation(String(id)))
            ) {
                throw new HttpError(
                    409,
                    "Pi is working or has an unknown operation. Reconcile it before switching the model.",
                );
            }

            await owner.app.accounts.forUser(user);
            const previous = await owner.currentChoice(id, user);
            let ref = request.model
                ? {
                      provider: String(request.model.provider),
                      modelId: String(request.model.modelId),
                  }
                : (previous ?? owner.app.commands.defaultModel(user).model);

            if (request.model) {
                const matches = owner.app.accounts.available(user).filter((model) => {
                    const native = owner.app.accounts.kernelModel(user, {
                        provider: model.provider,
                        modelId: model.id,
                    });

                    return (
                        model.id === request.model!.modelId &&
                        (model.provider === request.model!.provider ||
                            native.provider === request.model!.provider)
                    );
                });

                if (matches.length !== 1) {
                    throw new HttpError(400, "Choose one available model on your own account.");
                }

                ref = { provider: matches[0]!.provider, modelId: matches[0]!.id };
            }

            if (!ref) {
                throw new HttpError(409, "Connect your own account and choose a model first.");
            }

            const model = owner.app.accounts.kernelModel(user, ref);
            const chosen = {
                model: ref,
                thinkingLevel: clampThinkingLevel(
                    model,
                    String(
                        request.thinkingLevel ?? previous?.thinkingLevel ?? "off",
                    ) as ModelThinkingLevel,
                ),
            };
            const observed = await owner.executions.journal.session(String(id));

            if (
                requestId === undefined &&
                observed.binding.memberId === user.id &&
                observed.binding.accountGeneration === chosen.model?.provider &&
                observed.binding.model === chosen.model.modelId &&
                (await owner.executions.thinkingLevel(String(id))) ===
                    (chosen.thinkingLevel ?? "off")
            ) {
                owner.app.accounts.choose(user, { ...ref, thinkingLevel: chosen.thinkingLevel });

                return { receipt: null };
            }

            if (owner.isRunning(id)) {
                throw new HttpError(
                    409,
                    "Pi is working. Stop it or wait before switching the model.",
                );
            }

            const { binding, segmentId } = await owner.upgradeKernel(id, user, observed);

            // Thinking alone is mutable native session state: keep the session (and its identity seen
            // by project hooks) and its retained process instead of seeding a new one.
            if (
                request.model === undefined &&
                binding.memberId === user.id &&
                binding.accountGeneration === ref.provider
            ) {
                const thinking = await owner.track(
                    id,
                    binding,
                    owner.executions.run(
                        String(id),
                        owner.request(id, user, requestId ?? `thinking-${randomUUID()}`),
                        `/thinking ${String(request.thinkingLevel)}`,
                        owner.hooks(id),
                    ),
                );

                if (thinking.status === "handled") {
                    owner.app.accounts.choose(user, {
                        ...ref,
                        thinkingLevel: await owner.executions.thinkingLevel(String(id)),
                    });
                    owner.app.roomChanged(id);
                }

                return { receipt: thinking };
            }

            // The paying member's model lives in its own HOME's native session: switch there, keeping the
            // session id. Another member still takes over through a handoff.
            if (binding.memberId === user.id) {
                const next: KernelBinding = {
                    ...binding,
                    accountGeneration: ref.provider,
                    provider: model.provider,
                    model: model.id,
                    thinkingLevel: chosen.thinkingLevel,
                };
                const switched = await owner.track(
                    id,
                    next,
                    owner.executions.setModel(
                        String(id),
                        owner.request(id, user, requestId ?? `model-${randomUUID()}`),
                        { expectedHead: segmentId, binding: next },
                        owner.hooks(id),
                    ),
                );

                if (switched.status === "handled") {
                    owner.app.accounts.choose(user, {
                        ...ref,
                        thinkingLevel: await owner.executions.thinkingLevel(String(id)),
                    });
                    owner.app.roomChanged(id);
                }

                return { receipt: switched };
            }

            const receipt = await owner.handoff(
                id,
                user,
                requestId ?? `model-${randomUUID()}`,
                segmentId,
                chosen,
            );

            if (receipt.status === "settled") {
                owner.app.accounts.choose(user, { ...ref, thinkingLevel: chosen.thinkingLevel });
            }

            return { receipt };
        },
    };
}

export type ModelDomain = ReturnType<typeof createModelDomain>;
