import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { User } from "./config.ts";
import type { PocketApp } from "./app.ts";
import type { RotomExecutions } from "./rotom-executions.ts";
import { NativeForksDoc, type NativeConfigurations } from "./team-kernel-docs.ts";
import { HttpError } from "./errors.ts";
import type { SubmissionOwner } from "./team-kernel-submission.ts";
export type RequestOwner = SubmissionOwner & {
    app: PocketApp;
    executions: RotomExecutions;
    ready: Set<ConversationId>;
    configurations: Map<ConversationId, NativeConfigurations>;
};

export function createRequestDomain(owner: RequestOwner) {
    return {
        request(
            id: ConversationId,
            user: User,
            requestId: string,
            requireReady = true,
            operation = "submit",
        ): string {
            const current = owner.app.config.userById(user.id);

            if (!current) {
                throw new HttpError(403, "Membership ended.");
            }

            owner.app.requireSee(current, id);

            if (requireReady && !owner.ready.has(id)) {
                throw new HttpError(
                    409,
                    "Native initialization is incomplete; reconcile setup before execution.",
                );
            }

            if (
                typeof requestId !== "string" ||
                !requestId ||
                `${user.id}:${requestId}`.length > 128
            ) {
                throw new HttpError(400, "A stable requestId is required.");
            }

            const key = `${user.id}:${requestId}`;

            if (operation !== "configuration" && owner.configurations.get(id)?.requests[key]) {
                throw new HttpError(409, "Request belongs to configuration activation.");
            }

            return key;
        },

        async forkIdentity(id: ConversationId, key: string, operation: string): Promise<void> {
            // Fork receipts live on the target, but their request identity belongs to the source.
            const plan = (await owner.app.harness.snapshot(NativeForksDoc, id, BACKGROUND_CONTEXT))
                ?.items[key];

            if (plan && operation !== "fork") {
                throw new HttpError(409, "Request belongs to a fork allocation.");
            }

            if (operation === "fork" && (await owner.executions.journal.request(String(id), key))) {
                throw new HttpError(409, "Request belongs to another operation.");
            }
        },
    };
}

export type RequestDomain = ReturnType<typeof createRequestDomain>;
