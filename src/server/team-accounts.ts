/** Personal provider runtimes. The aggregate contains routes, never another person's credentials. */
import { createHash, randomUUID } from "node:crypto";
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import * as ai from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import { FileCredentials } from "./credential-store.ts";
import type { ModelRef } from "@earendil-works/pi-durable";
import { createQoderProvider } from "../../vendor/qoder/provider.mjs";
import { createRefreshGuard } from "../../vendor/qoder/refresh-guard.mjs";
import type { ConfigStore, ModelChoice, User } from "./config.ts";
import { HttpError } from "./errors.ts";

const noAmbient: ai.AuthContext = { env: async () => undefined, fileExists: async () => false };

/** The small snapshot API Pocket's model picker needs on top of pi-ai Models. */
export type Runtime = ai.MutableModels & {
    registerNativeProvider(provider: ai.Provider): void;
    getAvailableSnapshot(): readonly ai.Model<ai.Api>[];
    hasConfiguredAuth(provider: string): boolean;
    getProviderAuthStatus(provider: string): {
        configured: boolean;
        source?: string;
        label?: string;
    };
};

export function createRuntime(credentials?: ai.CredentialStore): Runtime {
    const models = createModels({ credentials, authContext: noAmbient });
    let available: readonly ai.Model<ai.Api>[] = [];
    const getAvailable = models.getAvailable.bind(models);

    return Object.assign(models, {
        registerNativeProvider: (provider: ai.Provider) => models.setProvider(provider),
        async getAvailable(provider?: string, options?: ai.AuthOperationOptions) {
            const result = await getAvailable(provider, options);

            available =
                provider === undefined
                    ? result
                    : [...available.filter((m) => m.provider !== provider), ...result];

            return result;
        },
        getAvailableSnapshot: () => available,
        hasConfiguredAuth: (provider: string) => available.some((m) => m.provider === provider),
        getProviderAuthStatus: (provider: string) => ({
            configured: available.some((m) => m.provider === provider),
        }),
    });
}

type Profile = { generations: Record<string, string>; model?: ModelChoice };
type Account = { runtime: Runtime; profile: Profile; folder: string; aliases: Set<string> };

/** A cross-account projection is deliberately lossy: only public text/tool calls cross. Original entries stay intact. */
export function accountContext(
    context: ai.TranscriptContext,
    alias: string,
    provider: string,
): ai.TranscriptContext {
    return {
        ...context,
        messages: context.messages.map((message) => {
            if (message.role !== "assistant") {
                return message;
            }

            if (message.provider === alias) {
                return { ...message, provider };
            }

            return {
                role: message.role,
                api: message.api,
                provider: message.provider,
                model: message.model,
                usage: message.usage,
                stopReason: message.stopReason,
                timestamp: message.timestamp,
                // Keep a foreign identity so native adapters also normalize provider-specific tool ids.
                content: message.content.flatMap<ai.TextContent | ai.ToolCall>((part) => {
                    if (part.type === "text") {
                        return [{ type: "text" as const, text: part.text }];
                    }

                    if (part.type === "toolCall") {
                        return [
                            {
                                type: "toolCall" as const,
                                id: part.id,
                                name: part.name,
                                arguments: part.arguments,
                            },
                        ];
                    }

                    return [];
                }),
            };
        }),
    };
}

function routedStream(
    source: ai.AssistantMessageEventStream,
    alias: string,
): ai.AssistantMessageEventStream {
    const output = ai.createAssistantMessageEventStream();

    void (async () => {
        for await (const event of source) {
            // Do not mutate the provider's live partial message, which it continues appending to.
            const copy = structuredClone(event);

            if ("partial" in copy) {
                copy.partial.provider = alias;
            }

            if (copy.type === "done") {
                copy.message.provider = alias;
            }

            if (copy.type === "error") {
                copy.error.provider = alias;
            }

            output.push(copy);
        }

        output.end();
    })();

    return output;
}

export class TeamAccounts {
    readonly models = createRuntime();
    readonly #accounts = new Map<string, Account>();
    readonly #changing = new Set<string>();
    readonly #mutations = new Map<string, Promise<unknown>>();
    async exclusive<T>(user: User, action: () => Promise<T>): Promise<T> {
        const previous = this.#mutations.get(user.id) ?? Promise.resolve();
        const current = previous.catch(() => {}).then(action);

        this.#mutations.set(user.id, current);

        try {
            return await current;
        } finally {
            if (this.#mutations.get(user.id) === current) {
                this.#mutations.delete(user.id);
            }
        }
    }
    readonly #opening = new Map<string, Promise<Account>>();
    readonly #config: ConfigStore;
    readonly #folder: string;
    readonly #configure?: (models: Runtime, user: User) => void;
    readonly #authorize: (provider: string, sessionId: string | undefined) => Promise<void>;

    constructor(
        config: ConfigStore,
        data: string,
        authorize: (provider: string, sessionId: string | undefined) => Promise<void>,
        configure?: (models: Runtime, user: User) => void,
    ) {
        this.#config = config;
        this.#folder = join(data, "people");
        this.#configure = configure;
        this.#authorize = authorize;
    }

    async open(): Promise<void> {
        for (const user of this.#config.users) {
            await this.forUser(user);
        }

        await this.models.getAvailable();
    }

    async forUser(user: User): Promise<Account> {
        if (!this.#config.userById(user.id)) {
            throw new HttpError(403, "This membership has ended.");
        }

        const found = this.#accounts.get(user.id);

        if (found) {
            return found;
        }

        let opening = this.#opening.get(user.id);

        if (!opening) {
            opening = this.#open(user);
            this.#opening.set(user.id, opening);
        }

        try {
            return await opening;
        } finally {
            this.#opening.delete(user.id);
        }
    }

    async #open(user: User): Promise<Account> {
        const folder = join(this.#folder, user.id);

        if (existsSync(this.#folder) && lstatSync(this.#folder).isSymbolicLink()) {
            throw new Error("Personal account directory must not be a symlink");
        }

        mkdirSync(folder, { recursive: true, mode: 0o700 });

        for (const path of [
            this.#folder,
            folder,
            join(folder, "auth.json"),
            join(folder, "profile.json"),
        ]) {
            if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
                throw new Error("Personal account paths must not be symlinks");
            }
        }

        chmodSync(folder, 0o700);
        const path = join(folder, "profile.json");
        const profile: Profile = existsSync(path)
            ? JSON.parse(readFileSync(path, "utf8"))
            : { generations: {} };
        const runtime = createRuntime(new FileCredentials(join(folder, "auth.json")));

        runtime.setProvider({ ...openaiProvider(), name: "ChatGPT / OpenAI" });
        runtime.setProvider(
            await createQoderProvider({
                piAI: ai,
                clampMaxTokens: clampMaxTokensToContext,
                authMode: "browser",
                oauthOptions: { claimRefresh: createRefreshGuard(folder) },
            }),
        );
        this.#configure?.(runtime, user);
        const account = { runtime, profile, folder, aliases: new Set<string>() };

        this.#accounts.set(user.id, account);
        await this.refresh(user);

        return account;
    }

    save(user: User): void {
        const account = this.#accounts.get(user.id)!;
        const path = join(account.folder, "profile.json");
        const temporary = `${path}.${randomUUID()}.tmp`;

        writeFileSync(temporary, `${JSON.stringify(account.profile, null, 2)}\n`, {
            mode: 0o600,
            flag: "wx",
        });
        renameSync(temporary, path);
    }

    async refresh(user: User, rotateProvider?: string): Promise<void> {
        const account = this.#accounts.get(user.id)!;

        if (rotateProvider === "qoder") {
            account.runtime.setProvider(
                await createQoderProvider({
                    piAI: ai,
                    clampMaxTokens: clampMaxTokensToContext,
                    authMode: "browser",
                    oauthOptions: { claimRefresh: createRefreshGuard(account.folder) },
                }),
            );
        }

        await account.runtime.getAvailable();

        for (const alias of account.aliases) {
            this.models.deleteProvider(alias);
        }

        account.aliases.clear();

        for (const provider of account.runtime.getProviders()) {
            account.profile.generations[provider.id] ??= randomUUID();
            const generation = account.profile.generations[provider.id]!;
            const alias = `team:${user.id}:${generation}:${provider.id}`;

            const check = () => {
                if (this.#changing.has(user.id)) {
                    throw new Error("Account sign-in is in progress; wait before starting work.");
                }

                if (
                    !this.#config.userById(user.id) ||
                    this.#config.userById(user.id)?.role === "viewer" ||
                    account.profile.generations[provider.id] !== generation
                ) {
                    throw new Error(
                        "Execution account changed or membership ended; start a new execution.",
                    );
                }

                if (!account.runtime.hasConfiguredAuth(provider.id)) {
                    throw new Error("Connect your own model account first.");
                }
            };

            this.models.setProvider({
                id: alias,
                name: `${provider.name} · ${user.name}`,
                auth: {
                    apiKey: {
                        name: "Personal account route",
                        resolve: async () => {
                            const member = this.#config.userById(user.id);

                            if (
                                !member ||
                                member.role === "viewer" ||
                                this.#changing.has(user.id) ||
                                account.profile.generations[provider.id] !== generation ||
                                !account.runtime.hasConfiguredAuth(provider.id)
                            ) {
                                return undefined;
                            }

                            return {
                                auth: { apiKey: "personal-route" },
                                source: "personal account",
                            };
                        },
                    },
                },
                getModels: () =>
                    account.runtime
                        .getAvailableSnapshot()
                        .filter((m) => m.provider === provider.id)
                        .map((m) => ({ ...m, provider: alias })),
                stream: (model, context, options) =>
                    ai.lazyStream(model, async () => {
                        check();
                        await this.#authorize(alias, options?.sessionId);
                        check();
                        const native = account.runtime.getModel(provider.id, model.id)!;

                        return routedStream(
                            account.runtime.stream(
                                native,
                                accountContext(context, alias, provider.id),
                                {
                                    ...options,
                                    apiKey: undefined,
                                    sessionId: this.#session(alias, options?.sessionId),
                                },
                            ),
                            alias,
                        );
                    }),
                streamSimple: (model, context, options) =>
                    ai.lazyStream(model, async () => {
                        check();
                        await this.#authorize(alias, options?.sessionId);
                        check();
                        const native = account.runtime.getModel(provider.id, model.id)!;

                        return routedStream(
                            account.runtime.streamSimple(
                                native,
                                accountContext(context, alias, provider.id),
                                {
                                    ...options,
                                    apiKey: undefined,
                                    sessionId: this.#session(alias, options?.sessionId),
                                },
                            ),
                            alias,
                        );
                    }),
            });
            account.aliases.add(alias);
        }

        this.save(user);
        await this.models.getAvailable();
    }

    #session(alias: string, session: string | undefined): string {
        if (!session) {
            throw new Error("A personal model request requires a durable session identity.");
        }

        return createHash("sha256").update(`${alias}\n${session}`).digest("hex");
    }

    beginChange(user: User, provider: string): void {
        if (this.#changing.has(user.id)) {
            throw new HttpError(409, "An account change is already in progress.");
        }

        this.#changing.add(user.id);
        this.#accounts.get(user.id)!.profile.generations[provider] = randomUUID();

        try {
            this.save(user);
        } catch (error) {
            this.#changing.delete(user.id);

            throw error;
        }
    }

    endChange(user: User): void {
        this.#changing.delete(user.id);
    }

    owns(user: User, provider: string): boolean {
        // Non-team providers exist only when the host explicitly injects a test provider. None are registered in production.
        return (
            provider.startsWith(`team:${user.id}:`) ||
            (!provider.startsWith("team:") && this.models.getProvider(provider) !== undefined)
        );
    }

    available(user: User): readonly ai.Model<ai.Api>[] {
        return this.models.getAvailableSnapshot().filter((m) => this.owns(user, m.provider));
    }

    choice(user: User): ModelChoice | undefined {
        const last = this.#accounts.get(user.id)?.profile.model;
        const all = this.available(user);
        const model =
            all.find((m) => m.provider === last?.provider && m.id === last.modelId) ?? all[0];

        return (
            model && {
                provider: model.provider,
                modelId: model.id,
                thinkingLevel: last?.thinkingLevel ?? "off",
            }
        );
    }

    choose(user: User, ref: ModelChoice): void {
        this.assertModel(user, ref);
        this.#accounts.get(user.id)!.profile.model = ref;
        this.save(user);
    }

    assertModel(user: User, ref: ModelRef): void {
        if (!this.#config.userById(user.id) || this.#config.userById(user.id)?.role === "viewer") {
            throw new HttpError(403, "This membership cannot execute.");
        }

        if (this.#changing.has(user.id)) {
            throw new HttpError(409, "Finish your account sign-in before executing.");
        }

        if (
            !this.owns(user, ref.provider) ||
            !this.available(user).some((m) => m.provider === ref.provider && m.id === ref.modelId)
        ) {
            throw new HttpError(403, "Select a model from your own connected accounts.");
        }
    }
}
