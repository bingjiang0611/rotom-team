/** Admission is serialized per conversation; an admitted run never changes payer while it is busy. */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
    AgentDoc,
    CompactionTask,
    defineDoc,
    defineExtension,
    hook,
    LiveDoc,
    InboxDoc,
    ProviderDoc,
    type ConversationId,
    type HookApi,
    type ModelRef,
} from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { HttpError } from "./errors.ts";

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

        await app.accounts.forUser(user);
        const state = await app.agentState(id);
        const binding = await app.harness.snapshot(TeamRunDoc, id, context);

        if (app.isBusy(id)) {
            if (binding?.owner !== user.id && state?.model?.provider.startsWith("team:")) {
                throw new HttpError(
                    409,
                    "Another member is executing. Comment, wait, or fork; their quota will not be used for your input.",
                );
            }

            if (state?.model) {
                app.accounts.assertModel(user, state.model);

                return state.model;
            }
        }

        if (
            state?.model &&
            app.accounts.owns(user, state.model.provider) &&
            (binding?.owner === user.id || !state.model.provider.startsWith("team:"))
        ) {
            app.accounts.assertModel(user, state.model);

            return state.model;
        }

        await this.idle(id);
        const inbox = await app.harness.snapshot(InboxDoc, id, context);

        if (inbox?.items.some((item) => item.mode !== "write")) {
            throw new HttpError(
                409,
                "Queued inputs remain from the previous execution. Stop or withdraw them before taking over.",
            );
        }

        const own =
            state?.model && app.accounts.owns(user, state.model.provider)
                ? state.model
                : app.accounts.choice(user);

        if (!own) {
            throw new HttpError(
                409,
                "Connect your own ChatGPT or Qoder account and select a model first.",
            );
        }

        app.accounts.assertModel(user, own);
        const conversation = await app.conversation(id);
        const changed =
            state?.model?.provider !== own.provider || state?.model?.modelId !== own.modelId;

        if (changed) {
            await conversation.configure(
                {
                    model: own,
                    thinkingLevel: (app.accounts.choice(user)?.thinkingLevel as "off") ?? "off",
                },
                context,
            );
        }

        await app.harness.commit(async (tx) => {
            Object.assign(await tx.doc(TeamRunDoc, id), {
                owner: user.id,
                provider: own.provider,
                modelId: own.modelId,
                startedAt: Date.now(),
            });
        }, context);

        if (binding?.owner && binding.owner !== user.id) {
            await app.collab.activity(
                id,
                user,
                "took over with their own model account; private provider reasoning/signatures are not shared",
                false,
            );
        }

        return own;
    }

    // Durable observer hooks report and swallow errors. Authorization therefore lives at provider dispatch, not in a hook.
    async authorize(provider: string, sessionId: string | undefined): Promise<void> {
        const app = this.#app;
        const id = sessionId === undefined ? undefined : this.#sessions.get(sessionId);

        if (id === undefined) {
            throw new Error("Unknown durable execution identity.");
        }

        const agent = await app.harness.snapshot(AgentDoc, id, context);
        const run = await app.harness.snapshot(TeamRunDoc, id, context);
        const root = await app.harness.snapshot(TeamRunDoc, app.rootOf(id), context);

        if (!agent?.model || agent.model.provider !== provider || run?.owner !== root?.owner) {
            throw new Error("Execution identity changed. Create a new subagent after taking over.");
        }

        const user = run?.owner && app.config.userById(run.owner);

        if (!user || !app.canSee(user, id)) {
            throw new Error("No authorized personal execution owner.");
        }

        app.accounts.assertModel(user, agent.model);
    }

    extension() {
        const app = this.#app;

        const check = async (api: HookApi) => {
            const agent = await api.snapshot(AgentDoc, api.conversationId, context);

            if (agent?.model?.provider.startsWith("team:")) {
                const provider = await api.snapshot(ProviderDoc, api.conversationId, context);

                await this.authorize(agent.model.provider, provider?.sessionId);
            }
        };

        return defineExtension({
            name: "rotom-team-identity",
            hooks: [
                hook(CompactionTask, {
                    beforeCompact: async (request, api) => {
                        // Hook exceptions are swallowed upstream: every failure must explicitly decline this lossy boundary.
                        try {
                            await check(api);
                            const agent = await api.snapshot(AgentDoc, api.conversationId, context);

                            if (
                                agent?.model?.provider.startsWith("team:") &&
                                request.messages.some(
                                    (message) =>
                                        message.role === "assistant" &&
                                        message.provider !== agent.model!.provider,
                                )
                            ) {
                                app.notice(
                                    "warning",
                                    "Cross-account compaction is not supported yet. Start a new context with an explicit public handoff note.",
                                    api.conversationId,
                                );

                                return { decline: true };
                            }

                            return undefined;
                        } catch {
                            return { decline: true };
                        }
                    },
                }),
            ],
        });
    }
}
