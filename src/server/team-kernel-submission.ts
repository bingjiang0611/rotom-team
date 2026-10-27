import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ConversationId, ModelRef } from "@earendil-works/pi-durable";
import type { User } from "./config.ts";
import type { Attachment } from "./commands.ts";
import type {
    AsyncRotomJournal,
    KernelBinding,
    KernelEntry,
    KernelReceipt,
} from "./rotom-journal.ts";
import type { RunHooks } from "./rotom-executions/contracts.ts";
import type { RotomExecutions } from "./rotom-executions.ts";
import type { PocketApp } from "./app.ts";
import { HttpError } from "./errors.ts";
import { attachmentImages, attachmentText } from "./attachments.ts";
import { isTeamPrompt, nativeCommandName, normalizeNativePrompt } from "./rotom-executions.ts";
import { RpcFailure } from "./rotom-rpc.ts";
import { KernelRequestConflict } from "./rotom-journal.ts";
import { submitInternalOperation } from "./team-kernel-submit-internal.ts";

export type ReceiptView = {
    id: string;
    requestId: string;
    status: KernelReceipt["status"];
    operation: string;
    phase?: KernelReceipt["phase"];
    failure?: unknown;
};
export type SessionRecord = Awaited<ReturnType<AsyncRotomJournal["session"]>>;
export type SubmissionOutcome = { status: string } & Record<string, unknown>;

export type SubmissionOwner = {
    app: PocketApp;
    executions: RotomExecutions;
    isRunning: (id: ConversationId) => boolean;
    requireAccountIdle: (user: User) => Promise<void>;
    nativeGoal: (
        id: ConversationId,
        readEntries?: (segmentId: string) => Promise<KernelEntry[]>,
    ) => Promise<unknown>;
    chooseModel: (
        id: ConversationId,
        user: User,
        body: unknown,
        requestId?: string,
    ) => Promise<{ receipt: ReceiptView | KernelReceipt | null }>;
    operation: <T>(
        id: ConversationId,
        user: User,
        requestId: string,
        operation: string,
        identity: unknown,
        action: () => Promise<T>,
    ) => Promise<T>;
    submitInternal: (
        id: ConversationId,
        user: User,
        requestId: string,
        text: string,
        wait: boolean,
        attachments: Attachment[],
    ) => Promise<SubmissionOutcome>;
    admitNativeCommand: (command: { name: string; source?: unknown; args?: string }) => void;
    currentChoice: (
        id: ConversationId,
        user: User,
    ) => Promise<(ModelRef & { thinkingLevel?: string }) | undefined>;
    ref: (binding: KernelBinding) => ModelRef;
    request: (
        id: ConversationId,
        user: User,
        requestId: string,
        requireReady?: boolean,
        operation?: string,
    ) => string;
    hooks: (
        id: ConversationId,
        onReserved?: (receipt: KernelReceipt) => void | Promise<void>,
    ) => RunHooks;
    mcpCommand: (
        id: ConversationId,
        user: User,
        text: string,
        requestId?: string,
    ) => Promise<{ status: string } | undefined>;
    requireDynamicAdapter: (
        id: ConversationId,
        user: User,
        name: string,
        requestId?: string,
    ) => Promise<void>;
    requireSupportedCommand: (
        id: ConversationId,
        user: User,
        text: string,
        requestId?: string,
    ) => Promise<void>;
    track: (
        id: ConversationId,
        binding: KernelBinding,
        promise: Promise<KernelReceipt>,
    ) => Promise<ReceiptView>;
    upgradeKernel: (
        id: ConversationId,
        user: User,
        observed?: SessionRecord,
    ) => Promise<SessionRecord>;
    configure: (
        id: ConversationId,
        user: User,
        requestId: string,
        expectedHead: string,
    ) => Promise<{ receipt: ReceiptView | null }>;
    compact: (
        id: ConversationId,
        user: User,
        requestId: string,
        instructions: string,
    ) => Promise<ReceiptView>;
    handoff: (
        id: ConversationId,
        user: User,
        requestId: string,
        expectedHead: string,
        selected?: { model: ModelRef; thinkingLevel: ModelThinkingLevel },
    ) => Promise<ReceiptView>;
    fork: (
        id: ConversationId,
        user: User,
        requestId: string,
        expectedHead: string,
        entryId?: string,
        clone?: boolean,
    ) => Promise<{ id: ConversationId; receipt: ReceiptView | null }>;
    receipt: (receipt: KernelReceipt) => Promise<ReceiptView>;
};

export function createSubmissionDomain(owner: SubmissionOwner) {
    return {
        submit(
            id: ConversationId,
            user: User,
            requestId: string,
            text: string,
            wait = true,
            attachments: Attachment[] = [],
        ) {
            const command = nativeCommandName(text);
            const operation =
                command === "clone" || command === "fork"
                    ? "fork"
                    : command === "compact"
                      ? "compact"
                      : "submit";

            return owner.operation(id, user, requestId, operation, { text, attachments }, () =>
                owner.submitInternal(id, user, requestId, text, wait, attachments),
            );
        },
        async queue(
            id: ConversationId,
            user: User,
            text: string,
            mode: "steer" | "followUp",
            attachments: Attachment[] = [],
        ) {
            if (typeof text !== "string" || !isTeamPrompt(attachmentText(text, attachments))) {
                throw new HttpError(400, "Enter ordinary text or a native slash command.");
            }

            if (text.length > 100_000) {
                throw new HttpError(400, "That message is too long.");
            }

            owner.app.requireSteer(user);
            owner.app.requireSee(user, id);

            await owner.requireSupportedCommand(id, user, text);

            if (["qoder-credits", "qoder-models"].includes(nativeCommandName(text) ?? "")) {
                await owner.requireDynamicAdapter(id, user, nativeCommandName(text)!);

                throw new HttpError(
                    409,
                    "Wait for your account's runs to finish before requesting private Qoder account data.",
                );
            }

            const mcp = await owner.mcpCommand(id, user, text);

            if (mcp) {
                return mcp;
            }

            const { binding } = await owner.executions.journal.session(String(id));

            if (binding.memberId !== user.id) {
                const name = owner.app.config.userById(binding.memberId)?.name ?? "Another member";

                throw new HttpError(
                    409,
                    `${name}'s run is working on their account. Send when it ends, and it continues on yours.`,
                );
            }

            const model = owner.app.accounts.kernelModel(user, owner.ref(binding));
            const images = await attachmentImages(attachments, model.input.includes("image"));
            const goal = (
                (await owner.nativeGoal(id)) as { goal?: { waiting?: unknown } } | undefined
            )?.goal;

            try {
                if (
                    goal?.waiting &&
                    !nativeCommandName(text) &&
                    (await owner.executions.wake(
                        String(id),
                        attachmentText(text, attachments),
                        images,
                    ))
                ) {
                    return { queued: mode };
                }

                if (
                    !(await owner.executions.queue(
                        String(id),
                        normalizeNativePrompt(attachmentText(text, attachments)),
                        mode,
                        images,
                        (command) => owner.admitNativeCommand(command),
                    ))
                ) {
                    throw new HttpError(
                        409,
                        "Pi is not running a prompt now (it finished, or is compacting). Send again.",
                    );
                }
            } catch (error) {
                if (error instanceof RpcFailure) {
                    throw new HttpError(
                        409,
                        `Native command outcome is ${error.outcome}: ${error.message}`,
                    );
                }

                if (error instanceof KernelRequestConflict) {
                    throw new HttpError(409, error.message);
                }

                throw error;
            }

            return { queued: mode };
        },

        compact(id: ConversationId, user: User, requestId: string, instructions: string) {
            return owner.operation(id, user, requestId, "compact", { instructions }, () =>
                owner.compact(id, user, requestId, instructions),
            );
        },
        handoff(
            id: ConversationId,
            user: User,
            requestId: string,
            expectedHead: string,
            selected?: { model: ModelRef; thinkingLevel: ModelThinkingLevel },
        ) {
            return owner.operation(id, user, requestId, "handoff", { expectedHead, selected }, () =>
                owner.handoff(id, user, requestId, expectedHead, selected),
            );
        },
        fork(
            id: ConversationId,
            user: User,
            requestId: string,
            expectedHead: string,
            entryId?: string,
            clone = false,
        ) {
            return owner.operation(
                id,
                user,
                requestId,
                "fork",
                { expectedHead, entryId, clone },
                () => owner.fork(id, user, requestId, expectedHead, entryId, clone),
            );
        },
        configure(id: ConversationId, user: User, requestId: string, expectedHead: string) {
            return owner.operation(id, user, requestId, "configuration", { expectedHead }, () =>
                owner.configure(id, user, requestId, expectedHead),
            );
        },

        submitInternal(
            id: ConversationId,
            user: User,
            requestId: string,
            text: string,
            wait: boolean,
            attachments: Attachment[],
        ) {
            return submitInternalOperation(owner, id, user, requestId, text, wait, attachments);
        },
    };
}

export type SubmissionDomain = ReturnType<typeof createSubmissionDomain>;
