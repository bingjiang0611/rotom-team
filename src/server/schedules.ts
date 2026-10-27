/** Historical schedule definition and read projection; Team never executes Durable schedules. */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, Task } from "@earendil-works/pi-durable";
import { defineTask } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import { type Schedule, ScheduleDoc } from "./docs.ts";
import { HttpError } from "./errors.ts";
import { ARCHIVE_COPY } from "./constants/copy.ts";

const context = BACKGROUND_CONTEXT;

export const SCHEDULED_PREFIX = "[scheduled] ";
export const SCHEDULES_EXTENSION = "pocket-schedules";

type ScheduleInput = { scheduleId: string };
type ScheduleState = { phase: "wait" } | { phase: "send" };

export type ScheduleRequest = {
    when: string;
    text?: string;
    zone?: string;
    by?: { id: string; name: string };
    requestedBy?: string;
    key?: string;
};

export class Schedules {
    readonly #app: PocketApp;
    /** Historical task identity and checkpoints; both execution phases refuse explicitly. */
    readonly task: Task<ScheduleInput, ScheduleState, null, object>;

    constructor(app: PocketApp) {
        this.#app = app;
        this.task = defineTask<ScheduleInput, ScheduleState, null>({
            name: "pocket.schedule",
            version: 1,
            initial: () => ({ phase: "wait" }),
            phases: {
                wait: async (_task, _runtime, _context) => {
                    throw new Error(ARCHIVE_COPY.executionRetired);
                },
                send: async (_task, _runtime, _context) => {
                    throw new Error(ARCHIVE_COPY.executionRetired);
                },
            },
            abort: (_task, runtime, context) =>
                runtime.commit(
                    () => ({ status: "terminal", outcome: { status: "aborted" } }),
                    context,
                ),
        });
    }

    get running(): boolean {
        return false;
    }

    async add(conversationId: ConversationId, _request: ScheduleRequest): Promise<Schedule> {
        this.#app.requireArchiveWriteAllowed(conversationId);

        throw new HttpError(409, ARCHIVE_COPY.executionRetired);
    }

    async cancel(
        conversationId: ConversationId,
        _scheduleId: string,
    ): Promise<Schedule | undefined> {
        this.#app.requireArchiveWriteAllowed(conversationId);

        throw new HttpError(409, ARCHIVE_COPY.executionRetired);
    }

    async list(conversationId: ConversationId): Promise<Schedule[]> {
        const items = Object.values(
            (await this.#app.harness.snapshot(ScheduleDoc, conversationId, context))?.items ?? {},
        );

        return items.sort((a, b) => a.next - b.next);
    }
}
