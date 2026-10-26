/** Historical goal storage/read support; Team never executes Durable goal checks. */
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import { type Goal, type GoalCheck, GoalDoc } from "./docs.ts";
import { HttpError } from "./errors.ts";
import { ARCHIVE_COPY } from "./constants/copy.ts";

const context = BACKGROUND_CONTEXT;

export const GOALS_EXTENSION = "pocket-goals";
export const GOAL_PREFIX = "[goal] ";

export class Goals {
    readonly #app: PocketApp;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    async get(id: ConversationId): Promise<Goal | undefined> {
        return (await this.#app.harness.snapshot(GoalDoc, id, context))?.goal;
    }

    async set(id: ConversationId, _by: string, _command: string): Promise<Goal> {
        this.#app.requireArchiveWriteAllowed(id);

        throw new HttpError(409, ARCHIVE_COPY.executionRetired);
    }

    async clear(id: ConversationId): Promise<boolean> {
        this.#app.requireArchiveWriteAllowed(id);

        throw new HttpError(409, ARCHIVE_COPY.executionRetired);
    }

    mayContinue(_id: ConversationId): boolean {
        return false;
    }

    async run(
        id: ConversationId,
        _command: string,
        _context: Context,
    ): Promise<Omit<GoalCheck, "at">> {
        this.#app.requireArchiveWriteAllowed(id);

        throw new HttpError(409, ARCHIVE_COPY.executionRetired);
    }

    async record(
        id: ConversationId,
        _answer: TaskId,
        _command: string,
        _check: Omit<GoalCheck, "at">,
    ): Promise<Goal | undefined> {
        this.#app.requireArchiveWriteAllowed(id);

        throw new HttpError(409, ARCHIVE_COPY.executionRetired);
    }
}
