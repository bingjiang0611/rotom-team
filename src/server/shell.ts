/** Historical shell task definition retained for archive decoding; Team never executes Durable shell tasks. */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
    type ConversationId,
    defineTask,
    type Task,
    type TaskId,
} from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { ARCHIVE_COPY } from "./constants/copy.ts";
import { HttpError } from "./errors.ts";

const TASK = "pocket.shell";

export type ShellInput = { command: string; by: string; name: string; context: boolean };
type ShellState = { phase: "run" };
export class Shell {
    readonly #app: PocketApp;
    /** Historical task identity and state shape; its phase refuses instead of executing a process. */
    readonly task: Task<ShellInput, ShellState, null, object>;

    constructor(app: PocketApp) {
        this.#app = app;
        this.task = defineTask<ShellInput, ShellState, null>({
            name: TASK,
            version: 1,
            initial: () => ({ phase: "run" }),
            phases: {
                run: async (_task, _runtime, _context) => {
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

    async start(
        id: ConversationId,
        user: User,
        _request: { command?: unknown; context?: unknown; requestId?: unknown },
    ): Promise<{ taskId: number }> {
        this.#app.requireSee(user, id);
        await this.#app.requireDriver(id, user);

        throw new HttpError(409, ARCHIVE_COPY.executionRetired);
    }

    async stop(id: ConversationId, user: User, _taskId: number): Promise<void> {
        this.#app.requireSee(user, id);
        this.#app.requireArchiveWriteAllowed(id);
        this.#app.requireSteer(user);

        throw new HttpError(409, ARCHIVE_COPY.executionRetired);
    }

    async describe(taskId: TaskId): Promise<string | undefined> {
        const task = await this.#app.harness.getTask(taskId, BACKGROUND_CONTEXT);

        return task?.kind === TASK ? (task.input as ShellInput).command : undefined;
    }
}
