import type { ConversationId } from "@earendil-works/pi-durable";
import type { User } from "./config.ts";
import type { PocketApp } from "./app.ts";
import type { RotomExecutions } from "./rotom-executions.ts";
import { HttpError } from "./errors.ts";
import { verifyRotomKernel } from "./rotom-kernel.ts";
import { RESUME_PREFIX } from "./entry-format.ts";
const RESUME_TEXT = `${RESUME_PREFIX} The server restarted while you were working, and your last step may have been cut off. Check what was already done, then continue the task from where it stopped. Do not repeat finished steps.`;

import type { KernelBinding } from "./rotom-journal.ts";
import type { McpSignIns } from "./mcp-sign-in.ts";
import type { SubmissionOwner } from "./team-kernel-submission.ts";
export type LifecycleOwner = SubmissionOwner & {
    app: PocketApp;
    executions: RotomExecutions;
    active: Set<{ id: ConversationId; binding: KernelBinding; promise: Promise<unknown> }>;
    ready: Set<ConversationId>;
    closing: { value: boolean };
    remoteStorage: boolean;
    mcp: McpSignIns;
    id: (value: string) => ConversationId;
    submit: (
        id: ConversationId,
        user: User,
        requestId: string,
        text: string,
        wait?: boolean,
    ) => Promise<unknown>;
    resumeDrain?: Promise<void>;
    resumeInterruptedImpl: () => Promise<void>;
    check: (binding: KernelBinding, id: ConversationId) => Promise<User>;
};

export function createLifecycleDomain(owner: LifecycleOwner) {
    return {
        async abort(id: ConversationId, user: User): Promise<void> {
            const current = owner.app.config.userById(user.id);

            if (!current) {
                throw new HttpError(403, "Membership ended.");
            }

            owner.app.requireSee(current, id);
            await owner.app.requireDriver(id, current, "rotom");
            await owner.executions.abort(String(id));
        },

        async revoke(): Promise<void> {
            for (const { id, binding } of owner.active) {
                try {
                    await owner.check(binding, id);
                } catch {
                    await owner.executions.abort(String(id));
                }
            }

            // A warm process nobody used yet goes once its member may no longer drive the session.
            for (const { segmentId, sessionId, binding } of owner.executions.unusedWarm()) {
                try {
                    await owner.check(binding, owner.id(sessionId));
                } catch {
                    await owner.executions.retireUnused(segmentId);
                }
            }
        },

        /**
         * Start this session's native process before `user` sends, as focusing the message box asks: only for the member
         * whose account the session runs on now (another member's send hands over first), on the pinned kernel, while
         * idle, after the checks a send makes. Whether a process is ready; a refusal is an answer, not an error.
         */
        async warm(id: ConversationId, user: User): Promise<{ warmed: boolean }> {
            const current = owner.app.config.userById(user.id);

            if (!current) {
                throw new HttpError(403, "Membership ended.");
            }

            owner.app.requireSteer(current);
            owner.app.requireSee(current, id);
            await owner.app.requireDriver(id, current, "rotom");

            if (owner.closing.value || !owner.ready.has(id) || owner.isRunning(id)) {
                return { warmed: false };
            }

            const { binding } = await owner.executions.journal.session(String(id));

            if (
                binding.memberId !== current.id ||
                binding.kernelVersion !== verifyRotomKernel().version
            ) {
                return { warmed: false };
            }

            return { warmed: await owner.executions.warm(String(id)) };
        },

        /**
         * Continue only a planned, cleanly settled stop, once, under the original member's usual checks.
         * Unknown outcomes and legacy interrupted classifications stay untouched, even with a persisted resume plan.
         * The derived request id prevents a second startup from sending the same continuation again.
         */
        resumeInterrupted(): Promise<void> {
            if (!owner.remoteStorage) {
                return owner.resumeInterruptedImpl();
            }

            owner.resumeDrain ??= owner.resumeInterruptedImpl().finally(() => {
                owner.resumeDrain = undefined;
            });

            return owner.resumeDrain;
        },

        async resumeInterruptedImpl(): Promise<void> {
            const journal = owner.executions.journal;

            for (const plan of await journal.resumes("pending")) {
                if (owner.remoteStorage && owner.closing.value) {
                    return;
                }

                const id = owner.id(plan.sessionId);
                const attempt = await journal.receipt(plan.attemptId);

                if (attempt.status !== "settled") {
                    continue;
                }

                const { binding } = await journal.session(plan.sessionId);
                const user = owner.app.config.userById(binding.memberId);

                // Someone acted since (a new message, a handoff, a fork seed): their choice stands.
                if (
                    (await journal.latest(plan.sessionId))?.id !== attempt.id ||
                    !user ||
                    !(await journal.canResume(attempt.id))
                ) {
                    await journal.markResume(plan.attemptId, "skipped");
                    continue;
                }

                try {
                    await owner.app.accounts.forUser(user);
                    await owner.submit(id, user, `#resume-${attempt.id}`, RESUME_TEXT, false);
                    await journal.markResume(plan.attemptId, "started");
                } catch (error) {
                    if (owner.remoteStorage && owner.closing.value) {
                        return;
                    }

                    await journal.markResume(plan.attemptId, "skipped");
                    owner.app.notice(
                        "warning",
                        `A rotom run cut off by a server restart did not continue by itself: ${error}`,
                    );
                }

                owner.app.roomChanged(id);
            }
        },

        async close(): Promise<void> {
            owner.closing.value = true;
            owner.mcp.close();

            const failures: unknown[] = [];

            const failed = (error: unknown) => {
                if (!owner.remoteStorage) {
                    throw error; // Preserve the D8a path when the worker is disabled.
                }

                failures.push(error);
            };

            // A failed storage owner cannot save a continuation. Still abort/drain every native owner.
            try {
                for (const id of new Set([...owner.active].map((run) => run.id))) {
                    await owner.executions.journal.planPendingResume(String(id));
                }
            } catch (error) {
                failed(error);
            }

            for (const id of new Set([...owner.active].map((run) => run.id))) {
                try {
                    await owner.executions.abort(String(id));
                } catch (error) {
                    failed(error);
                }
            }

            await Promise.allSettled([...owner.active].map((run) => run.promise));

            try {
                if (owner.resumeDrain) {
                    await owner.resumeDrain;
                }
            } catch (error) {
                failed(error);
            }

            try {
                await owner.executions.close();
            } catch (error) {
                failed(error);
            }

            if (failures.length > 0) {
                throw new AggregateError(
                    failures,
                    "Native shutdown attempted; storage or closure failures retain writer leases",
                );
            }
        },
    };
}

export type LifecycleDomain = ReturnType<typeof createLifecycleDomain>;
