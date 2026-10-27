import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import {
    clampThinkingLevel,
    getSupportedThinkingLevels,
    type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { User } from "./config.ts";
import type { Attachment } from "./commands.ts";
import type { KernelReceipt } from "./rotom-journal.ts";
import { HttpError } from "./errors.ts";
import { sendPhase } from "./send-trace.ts";
import { attachmentImages, attachmentText } from "./attachments.ts";
import {
    isTeamPrompt,
    nativePromptIdentity,
    nativePromptOperation,
    nativeCommandName,
    nativeCommandArgs,
    normalizeNativePrompt,
} from "./rotom-executions.ts";
import { nativeSessionManager } from "./rotom-kernel.ts";
import { nativeTreeNodes } from "./native-tree.ts";
import { touchSession } from "./titles.ts";
import { NativeCommandResultsDoc } from "./team-kernel-docs.ts";

import type { SubmissionOwner } from "./team-kernel-submission.ts";

export async function submitInternalOperation(
    owner: SubmissionOwner,
    id: ConversationId,
    user: User,
    requestId: string,
    text: string,
    wait: boolean,
    attachments: Attachment[],
) {
    const key = owner.request(id, user, requestId);

    owner.app.requireSteer(user);

    if (
        typeof requestId !== "string" ||
        !requestId ||
        `${user.id}:${requestId}`.length > 128 ||
        typeof text !== "string"
    ) {
        throw new HttpError(400, "A stable requestId and text are required.");
    }

    sendPhase(String(id), key, "admitted");
    const prompt = normalizeNativePrompt(attachmentText(text, attachments));

    if (!isTeamPrompt(prompt)) {
        throw new HttpError(400, "Enter ordinary text or a native slash command.");
    }

    await owner.requireSupportedCommand(id, user, prompt, requestId);
    const command = nativeCommandName(prompt);
    const args = nativeCommandArgs(prompt);

    if (command === "goal" && !args) {
        return { status: "handled" as const, interaction: { type: "native-goal" } };
    }

    const mcp = await owner.mcpCommand(id, user, prompt, requestId);

    if (mcp) {
        return mcp;
    }

    if (command === "qoder-credits" || command === "qoder-models") {
        await owner.requireDynamicAdapter(id, user, command, requestId);
        await owner.requireAccountIdle(user);
        const result = await owner.app.accounts.nativeQoder(
            user,
            command === "qoder-models" ? "models" : "credits",
        );

        return { status: "handled" as const, nativeResult: result };
    }

    if (command === "context") {
        if (args && args !== "usage" && args !== "injections") {
            throw new HttpError(
                400,
                "Use /context [usage|injections]. Context configuration belongs to the owner-managed shared profile.",
            );
        }

        await owner.requireDynamicAdapter(id, user, command, requestId);
    }

    if (command === "settings") {
        return { status: "handled" as const, interaction: { type: "native-settings" } };
    }

    if (command === "compact") {
        return owner.compact(id, user, requestId, args);
    }

    if (command === "model" || command === "thinking") {
        if (!args) {
            if (command === "model") {
                return { status: "handled" as const, interaction: { type: "model" } };
            }

            await owner.app.accounts.forUser(user);
            const current = await owner.currentChoice(id, user);
            const ref = current ?? owner.app.commands.defaultModel(user).model;

            if (!ref) {
                throw new HttpError(409, "Connect your own account and choose a model first.");
            }

            const model = owner.app.accounts.kernelModel(user, ref);

            return {
                status: "handled" as const,
                interaction: {
                    type: "native-thinking",
                    levels: model.reasoning ? getSupportedThinkingLevels(model) : ["off"],
                    thinkingLevel: clampThinkingLevel(
                        model,
                        (current?.thinkingLevel ?? "off") as ModelThinkingLevel,
                    ),
                },
            };
        }

        const separator = args.indexOf("/");

        if (command === "model" && separator <= 0) {
            return {
                status: "handled" as const,
                interaction: { type: "model", query: args },
            };
        }

        const result = await owner.chooseModel(
            id,
            user,
            command === "model"
                ? {
                      model: {
                          provider: args.slice(0, separator),
                          modelId: args.slice(separator + 1),
                      },
                  }
                : { thinkingLevel: args.toLowerCase() },
            requestId,
        );

        return result.receipt ?? { status: "handled" as const };
    }

    if ((command === "fork" || command === "tree") && !args) {
        const source = await owner.executions.journal.session(String(id));

        if (command === "tree" && source.binding.memberId !== user.id) {
            const receipt = await owner.handoff(
                id,
                user,
                `tree-handoff-${createHash("sha256").update(requestId).digest("hex").slice(0, 40)}`,
                source.segmentId,
            );

            if (receipt.status !== "settled") {
                return receipt;
            }
        }

        const { segmentId } = await owner.executions.journal.session(String(id));
        const entries = await owner.executions.journal.segmentEntries(segmentId);

        if (command === "tree") {
            return {
                status: "handled" as const,
                interaction: {
                    type: "native-tree",
                    title: "Session Tree",
                    ...nativeTreeNodes(entries),
                },
            };
        }

        const native = await nativeSessionManager();
        const options = entries.flatMap((entry) => {
            const message = entry.message as { role?: string; content?: unknown } | undefined;

            if (entry.type !== "message" || message?.role !== "user") {
                return [];
            }

            const selectedText = native.contentText(message.content, "") as string;

            if (!selectedText) {
                return [];
            }

            return [
                {
                    entryId: entry.id,
                    label: `user: ${selectedText.slice(0, 160)}`,
                    text: `/fork ${entry.id}`,
                },
            ];
        });

        return {
            status: "handled" as const,
            interaction: {
                type: "native-command",
                title: "Fork before a user message",
                command,
                options,
            },
        };
    }

    if (command === "clone" || command === "fork") {
        const { segmentId } = await owner.executions.journal.session(String(id));
        const target = await owner.fork(
            id,
            user,
            requestId,
            segmentId,
            command === "fork" ? args : undefined,
            command === "clone",
        );

        let editorText: string | undefined;

        if (command === "fork" && target.receipt?.status === "settled") {
            const selected = (await owner.executions.journal.segmentEntries(segmentId)).find(
                (entry) => entry.id === args,
            );
            const native = await nativeSessionManager();

            editorText = native.contentText(
                (selected!.message as { content: unknown }).content,
                "",
            );
        }

        return target.receipt
            ? {
                  ...target.receipt,
                  conversationId: target.id,
                  receipt: target.receipt,
                  editorText,
              }
            : { status: "unknown" as const, conversationId: target.id, receipt: null };
    }

    const images = await attachmentImages(attachments, true);
    const identity = nativePromptIdentity(prompt, images);
    const previous = await owner.executions.journal.existing(
        String(id),
        key,
        identity,
        nativePromptOperation(prompt),
    );

    if (previous) {
        const saved = (
            await owner.app.harness.snapshot(NativeCommandResultsDoc, id, BACKGROUND_CONTEXT)
        )?.items[key];

        return {
            ...(await owner.receipt(previous)),
            ...(saved === undefined ? {} : { nativeResult: saved }),
        };
    }

    if (owner.isRunning(id)) {
        throw new HttpError(409, "Pi is working. Wait for it to finish or Stop it first.");
    }

    const journal = owner.executions.journal;
    const source = await journal.session(String(id));

    if (images.length > 0) {
        await owner.app.accounts.forUser(user);
        const ref =
            source.binding.memberId === user.id
                ? owner.ref(source.binding)
                : owner.app.commands.defaultModel(user).model;

        if (!ref) {
            throw new HttpError(409, "Connect your own account and choose a model first.");
        }

        if (!owner.app.accounts.kernelModel(user, ref).input.includes("image")) {
            throw new HttpError(
                400,
                "This model does not accept images. Choose an image-capable model.",
            );
        }
    }

    const current = await owner.upgradeKernel(id, user, source);

    if (current.binding.memberId !== user.id) {
        const takeover = await owner.handoff(id, user, `${requestId}:takeover`, current.segmentId);

        if (takeover.status !== "settled") {
            throw new HttpError(
                409,
                `Taking over with your own account ended ${takeover.status}; the message was not sent.`,
            );
        }
    }

    const binding = (await journal.session(String(id))).binding;

    if (binding.memberId !== user.id) {
        throw new HttpError(409, "Another member took over first; refresh and send again.");
    }

    let nativeResult: unknown;
    let expanded!: (receipt: KernelReceipt) => void;
    const promptExpansion = new Promise<KernelReceipt>((resolve) => {
        expanded = resolve;
    });
    let reserved!: (receipt: KernelReceipt) => void;
    let wasReserved = false;
    const admitted = new Promise<KernelReceipt>((resolve) => {
        reserved = (receipt) => {
            wasReserved = true;
            resolve(receipt);
        };
    });

    const nameAcceptedPrompt = async () => {
        if (!requestId.startsWith("#resume-")) {
            try {
                await touchSession(owner.app, id, text);
            } catch (error) {
                owner.app.notice("warning", `The session name could not be saved: ${error}`, id);
            }
        }
    };

    const run = owner.track(
        id,
        binding,
        owner.executions.run(
            String(id),
            key,
            prompt,
            {
                ...owner.hooks(id, async (receipt: KernelReceipt) => {
                    if (nativeCommandName(text) === undefined) {
                        await nameAcceptedPrompt();
                    }

                    reserved(receipt);
                }),
                onCommandAdmitted: async (command) => {
                    owner.admitNativeCommand(command);

                    if (command.source === "skill" || command.source === "prompt") {
                        await nameAcceptedPrompt();
                        expanded((await journal.request(String(id), key))!);
                    }
                },
                onNativeResult: async (result) => {
                    nativeResult = result;

                    if (
                        result &&
                        typeof result === "object" &&
                        ("navigation" in result || "context" in result)
                    ) {
                        await owner.app.harness.commit(async (tx) => {
                            (await tx.doc(NativeCommandResultsDoc, id)).items[key] =
                                result as JsonValue;
                        }, BACKGROUND_CONTEXT);
                    }
                },
            },
            images,
        ),
    );

    if (wait) {
        const receipt = await Promise.race([
            run,
            promptExpansion.then(async (receipt) => await owner.receipt(receipt)),
        ]);

        return { ...receipt, ...(nativeResult === undefined ? {} : { nativeResult }) };
    }

    run.catch((error: unknown) => {
        if (wasReserved) {
            owner.app.notice("warning", `Native run ended without a proven outcome: ${error}`);
        }
    });

    return Promise.race([run, admitted.then(async (receipt) => await owner.receipt(receipt))]);
}
