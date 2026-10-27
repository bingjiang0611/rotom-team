import type { ConversationId, ModelRef } from "@earendil-works/pi-durable";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { JsonValue } from "@earendil-works/chord";
import type { User } from "./config.ts";
import type { KernelReceipt } from "./rotom-journal.ts";
import type { RpcRecord } from "./rotom-rpc.ts";
import type { RotomExecutions } from "./rotom-executions.ts";
import type { RunHooks } from "./rotom-executions/contracts.ts";
import type { NativeCommandCatalog, NativeLive, NativeConfigurations } from "./team-kernel-docs.ts";
import type { Attachment } from "./commands.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { join } from "node:path";
import { HttpError } from "./errors.ts";
import { teamResourceRevision } from "./rotom-resources.ts";
import { SessionsDoc } from "./docs.ts";
import { NativeCommandCatalogDoc, DIALOG_METHODS, type NativeDialog } from "./team-kernel-docs.ts";
import { sendPhase } from "./send-trace.ts";
import { decodeNativeControl } from "./rotom-control.ts";
import { applyUpdate } from "./team-kernel/projection.ts";
import type { SubmissionDomain, SubmissionOwner } from "./team-kernel-submission.ts";
import type { ModelDomain } from "./team-kernel-model.ts";
export type RuntimeOwner = SubmissionOwner & {
    executions: RotomExecutions;
    live: Map<ConversationId, NativeLive>;
    commands: Map<ConversationId, NativeCommandCatalog>;
    nativeGoals: Map<ConversationId, unknown>;
    ready: Set<ConversationId>;
    configurations: Map<ConversationId, NativeConfigurations>;
    operations: Map<string, { operation: string; identity: string; promise: Promise<unknown> }>;
    submission: SubmissionDomain;
    model: ModelDomain;
    forkIdentity: (id: ConversationId, key: string, operation: string) => Promise<void>;
    observe: (id: ConversationId, event: RpcRecord) => void;
    mirror: (id: ConversationId) => Promise<void>;
};

export function createRuntimeDomain(owner: RuntimeOwner) {
    return {
        operation<T>(
            id: ConversationId,
            user: User,
            requestId: string,
            operation: string,
            payload: unknown,
            action: () => Promise<T>,
        ): Promise<T> {
            const key = owner.request(id, user, requestId, true, operation);

            if (operation === "submit") {
                sendPhase(String(id), key, "entered");
            }

            const scope = JSON.stringify([id, key]);
            const identity = JSON.stringify(payload);
            const existing = owner.operations.get(scope);

            if (existing) {
                if (existing.operation !== operation || existing.identity !== identity) {
                    throw new HttpError(
                        409,
                        "Request identity is already being allocated to another operation.",
                    );
                }

                return existing.promise as Promise<T>;
            }

            // Claim identity synchronously, before any authorization/document await. Distinct requests are never queued.
            const promise = Promise.resolve()
                .then(async () => {
                    await owner.forkIdentity(id, key, operation);

                    const result = await action();

                    if (operation === "submit") {
                        sendPhase(String(id), key, "returned");
                    }

                    return result;
                })
                .finally(() => owner.operations.delete(scope));

            owner.operations.set(scope, { operation, identity, promise });

            return promise;
        },

        /** `wait: false` answers once the intent is durably reserved; the run continues and shows in the room. */
        submit(
            id: ConversationId,
            user: User,
            requestId: string,
            text: string,
            wait = true,
            attachments: Attachment[] = [],
        ) {
            return owner.submission.submit(id, user, requestId, text, wait, attachments);
        },

        async queue(
            id: ConversationId,
            user: User,
            text: string,
            mode: "steer" | "followUp",
            attachments: Attachment[] = [],
        ) {
            return owner.submission.queue(id, user, text, mode, attachments);
        },

        compact(id: ConversationId, user: User, requestId: string, instructions: string) {
            return owner.submission.compact(id, user, requestId, instructions);
        },

        handoff(
            id: ConversationId,
            user: User,
            requestId: string,
            expectedHead: string,
            selected?: { model: ModelRef; thinkingLevel: ModelThinkingLevel },
        ) {
            return owner.submission.handoff(id, user, requestId, expectedHead, selected);
        },

        fork(
            id: ConversationId,
            user: User,
            requestId: string,
            expectedHead: string,
            entryId?: string,
            clone?: boolean,
        ) {
            return owner.submission.fork(id, user, requestId, expectedHead, entryId, clone);
        },

        configure(id: ConversationId, user: User, requestId: string, expectedHead: string) {
            return owner.submission.configure(id, user, requestId, expectedHead);
        },

        async chooseModel(id: ConversationId, user: User, body: unknown, requestId?: string) {
            return owner.model.chooseModel(id, user, body, requestId);
        },

        hooks(
            id: ConversationId,
            onReserved?: (receipt: KernelReceipt) => void | Promise<void>,
        ): RunHooks {
            return {
                ...(onReserved ? { onReserved } : {}),
                onCommandAdmitted: (command) => owner.admitNativeCommand(command),
                sessionName: () => owner.app.sessionMeta(id)?.title,
                onSessionName: async (name) => {
                    await owner.app.harness.commit(async (tx) => {
                        const meta = (await tx.doc(SessionsDoc)).items[String(id)];

                        if (meta) {
                            meta.title = name;
                            meta.updatedAt = Date.now();
                        }
                    }, BACKGROUND_CONTEXT);
                    owner.app.roomChanged(id);
                },
                onEvent: (event) => owner.observe(id, event),
                onCommands: async (commands) => {
                    const session = await owner.executions.journal.session(String(id));

                    owner.commands.set(id, {
                        memberId: session.binding.memberId,
                        segmentId: session.segmentId,
                        binding: JSON.stringify(session.binding),
                        capturedAt: Date.now(),
                        resourceRevision: teamResourceRevision(
                            join(owner.app.dataDir, "team-agent"),
                            owner.app.cwdOf(id),
                        ),
                        commands: commands
                            .filter(
                                (command) =>
                                    typeof command.name === "string" &&
                                    !command.name.startsWith("team-kernel-"),
                            )
                            .map((command) => ({
                                name: command.name as string,
                                description:
                                    typeof command.description === "string"
                                        ? command.description
                                        : "",
                                ...(typeof command.argumentHint === "string"
                                    ? { argumentHint: command.argumentHint }
                                    : {}),
                                ...(command.sourceInfo
                                    ? { sourceInfo: command.sourceInfo as JsonValue }
                                    : {}),
                                ...(typeof command.source === "string"
                                    ? { source: command.source }
                                    : {}),
                            })),
                    });
                    await owner.app.harness.commit(async (tx) => {
                        (await tx.doc(NativeCommandCatalogDoc, id)).catalog =
                            owner.commands.get(id)!;
                    }, BACKGROUND_CONTEXT);
                    owner.app.roomChanged(id);
                },
                onNativeGoalState: (state) => {
                    owner.nativeGoals.set(id, state);
                    owner.app.roomChanged(id);
                },
                onNativeResult: (result) => {
                    const nativeResult = result as { path?: unknown } | undefined;
                    const path =
                        nativeResult && typeof nativeResult.path === "string"
                            ? nativeResult.path
                            : "";

                    owner.app.notice(
                        "info",
                        path === "" ? "Native command completed." : `Native command wrote ${path}`,
                        id,
                    );
                },
                // A failed mirror is already a notice, and the run's end mirrors again.
                onProgress: () => void owner.mirror(id).catch(() => undefined),
            };
        },

        /** Fold one kernel event into the provisional live view of the conversation. */
        observe(id: ConversationId, event: RpcRecord): void {
            const live = owner.live.get(id) ?? { tools: [] };
            const message = event.message as { role?: unknown } | undefined;

            owner.live.set(id, live);

            switch (event.type) {
                case "message_start":
                    if (message?.role !== "assistant") {
                        return;
                    }

                    live.generation = { message: { ...message, content: [] }, ended: false };
                    break;

                case "message_update":
                    if (!live.generation || !applyUpdate(live.generation.message, event)) {
                        return;
                    }

                    break;

                case "message_end":
                    if (message?.role !== "assistant" || !live.generation) {
                        return;
                    }

                    // Shown until its persisted copy is mirrored, so the message never blinks out.
                    live.generation.ended = true;
                    break;

                case "tool_execution_start":
                    live.tools.push({
                        callId: String(event.toolCallId),
                        name: String(event.toolName),
                        status: "running",
                    });
                    break;

                case "tool_execution_update": {
                    const slot = live.tools.find(
                        (each: { callId: string }) => each.callId === String(event.toolCallId),
                    );
                    const content = (event.partialResult as { content?: unknown } | undefined)
                        ?.content;

                    if (!slot || !Array.isArray(content)) {
                        return;
                    }

                    slot.output = content
                        .flatMap((part: { type?: unknown; text?: unknown }) =>
                            part.type === "text" && typeof part.text === "string"
                                ? [part.text]
                                : [],
                        )
                        .join("\n");
                    break;
                }

                case "tool_execution_end":
                    live.tools = live.tools.filter(
                        (each: { callId: string }) => each.callId !== String(event.toolCallId),
                    );
                    break;

                case "auto_retry_start":
                    live.retry = {
                        at: Date.now() + Number(event.delayMs ?? 0),
                        error: String(event.errorMessage ?? "Retrying"),
                    };
                    break;

                case "auto_retry_end":
                    delete live.retry;
                    break;

                case "compaction_start":
                    live.compacting = String(event.reason ?? "threshold");
                    break;

                case "compaction_end":
                    delete live.compacting;
                    break;

                case "extension_error":
                    owner.app.notice(
                        "warning",
                        `Native extension error (${String(event.extensionPath ?? "unknown")}): ${String(event.error ?? "unknown error")}`,
                        id,
                    );
                    break;

                case "extension_ui_request": {
                    const control = decodeNativeControl(event);

                    if (control) {
                        if (control.kind !== "team-kernel-children-v1") {
                            return;
                        }

                        live.subagents = control.pending;
                        break;
                    }

                    const method = String(event.method);
                    const text = (value: unknown) =>
                        typeof value === "string" ? value.slice(0, 16_000) : undefined;

                    // Native notifications are notices; statuses/widgets are keyed live replace/clear slots.
                    // Dialogs remain interactive live state for the paying member.
                    if (method === "notify") {
                        const message = text(event.message);

                        if (message) {
                            const level = ["warning", "error"].includes(String(event.notifyType))
                                ? (String(event.notifyType) as "warning" | "error")
                                : "info";

                            owner.app.notice(level, message, id);
                        }

                        return;
                    }

                    if (method === "setStatus") {
                        const key = String(event.statusKey);
                        const message = text(event.statusText);

                        live.statuses ??= Object.create(null) as Record<string, string>;

                        if (message === undefined) {
                            delete live.statuses[key];
                        } else {
                            live.statuses[key] = message;
                        }

                        break;
                    }

                    if (method === "setWidget") {
                        const lines = Array.isArray(event.widgetLines)
                            ? event.widgetLines.filter(
                                  (line): line is string => typeof line === "string",
                              )
                            : [];

                        const key = String(event.widgetKey);

                        live.widgets ??= Object.create(null) as NonNullable<NativeLive["widgets"]>;

                        if (event.widgetLines === undefined) {
                            delete live.widgets[key];
                        } else {
                            live.widgets[key] = {
                                lines,
                                placement: String(event.widgetPlacement ?? "aboveEditor"),
                            };
                        }

                        break;
                    }

                    if (!DIALOG_METHODS.has(method)) {
                        return;
                    }

                    live.dialogs = [
                        ...(live.dialogs ?? []),
                        {
                            id: String(event.id),
                            method: event.method as NativeDialog["method"],
                            title: text(event.title) ?? "",
                            ...(text(event.message) !== undefined && {
                                message: text(event.message),
                            }),
                            ...(Array.isArray(event.options) && {
                                options: event.options
                                    .slice(0, 64)
                                    .map((each: unknown) => String(each)),
                            }),
                            ...(text(event.placeholder) !== undefined && {
                                placeholder: text(event.placeholder),
                            }),
                            ...(text(event.prefill) !== undefined && {
                                prefill: text(event.prefill),
                            }),
                        },
                    ];
                    owner.app.kernelChanged();
                    break;
                }

                default:
                    return;
            }

            owner.app.roomChanged(id);
        },
    };
}

export type RuntimeDomain = ReturnType<typeof createRuntimeDomain>;
