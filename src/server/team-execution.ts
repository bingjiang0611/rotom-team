/** Admission is serialized per conversation; an admitted run never changes payer while it is busy. */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
    CompactionTask,
    defineDoc,
    defineExtension,
    hook,
    LiveDoc,
    ProviderDoc,
    type ConversationId,
    type ModelRef,
} from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { HttpError } from "./errors.ts";
import { ARCHIVE_COPY } from "./constants/copy.ts";

const context = BACKGROUND_CONTEXT;

export const TeamRunDoc = defineDoc<{
    owner?: string;
    provider?: string;
    modelId?: string;
    startedAt?: number;
}>({
    kind: "rotom-team.execution",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({}),
});

export class TeamExecution {
    readonly #app: PocketApp;
    readonly #locks = new Map<ConversationId, Promise<unknown>>();
    readonly #owners = new Map<ConversationId, string>();
    readonly #sessions = new Map<string, ConversationId>();
    noteSession(id: ConversationId, value: { sessionId: string } | null): void {
        if (value) {
            this.#sessions.set(value.sessionId, id);
        }
    }
    owner(id: ConversationId): string | undefined {
        return this.#owners.get(id);
    }
    noteOwner(id: ConversationId, value: { owner?: string } | null): void {
        if (value?.owner) {
            this.#owners.set(id, value.owner);
        } else {
            this.#owners.delete(id);
        }
    }
    async recover(ids: readonly ConversationId[]): Promise<void> {
        for (const id of ids) {
            this.noteOwner(id, (await this.#app.harness.snapshot(TeamRunDoc, id, context)) ?? null);
            this.noteSession(
                id,
                (await this.#app.harness.snapshot(ProviderDoc, id, context)) ?? null,
            );
        }
    }
    async accountIdle(user: User): Promise<void> {
        await this.#app.kernel?.requireAccountIdle(user);
        // Its warm processes no request used yet would run on the account about to change.
        await this.#app.kernel?.executions.retireUnusedOf(user.id);

        for (const [id, owner] of this.#owners) {
            if (owner === user.id) {
                await this.idle(id);
            }
        }
    }
    constructor(app: PocketApp) {
        this.#app = app;
    }

    async exclusive<T>(id: ConversationId, action: () => Promise<T>): Promise<T> {
        const previous = this.#locks.get(id) ?? Promise.resolve();
        const current = previous.catch(() => {}).then(action);

        this.#locks.set(id, current);

        try {
            return await current;
        } finally {
            if (this.#locks.get(id) === current) {
                this.#locks.delete(id);
            }
        }
    }

    async idle(id: ConversationId): Promise<void> {
        const app = this.#app;

        for (const each of app.conversationsOf(app.rootOf(id))) {
            const live = await app.harness.snapshot(LiveDoc, each, context);

            if (app.isBusy(each) || (live?.compactions?.length ?? 0) > 0) {
                throw new HttpError(
                    409,
                    "This execution is still active. Wait, stop it, or fork before changing accounts or models.",
                );
            }
        }
    }

    async admit(id: ConversationId, user: User): Promise<ModelRef> {
        const app = this.#app;

        await app.kernel?.requireAccountIdle(user);

        if (app.sessionMeta(app.rootOf(id))?.backend === "rotom") {
            throw new HttpError(409, "Native sessions cannot enter Durable execution.");
        }

        app.requireArchiveWriteAllowed(id);

        throw new HttpError(409, ARCHIVE_COPY.executionRetired);
    }

    // Durable observer hooks report and swallow errors. Authorization therefore lives at provider dispatch, not in a hook.
    async authorize(_provider: string, sessionId: string | undefined): Promise<void> {
        const app = this.#app;
        const id = sessionId === undefined ? undefined : this.#sessions.get(sessionId);

        if (id === undefined) {
            throw new Error("Unknown durable execution identity.");
        }

        if (app.sessionMeta(app.rootOf(id))?.backend === "rotom") {
            throw new Error("Native sessions cannot dispatch through Durable.");
        }

        app.requireArchiveWriteAllowed(id);

        throw new Error(ARCHIVE_COPY.executionRetired);
    }

    extension() {
        return defineExtension({
            name: "rotom-team-identity",
            hooks: [
                hook(CompactionTask, {
                    // Hook exceptions are swallowed upstream; explicitly refuse this retired lossy operation.
                    beforeCompact: async () => ({ decline: true }),
                }),
            ],
        });
    }
}
