/** Personal provider runtimes. The aggregate contains routes, never another person's credentials. */
import { createHash, randomUUID } from "node:crypto";
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import * as ai from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { chatGPTProvider } from "./openai-chatgpt.ts";
// Pinned Pi 1.0.2 private storage seam; clean-install validation covers this exact path.
import { FileModelsStore } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/models-store.js";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import { FileCredentials } from "./credential-store.ts";
import type { ModelRef } from "@earendil-works/pi-durable";
import { createQoderProvider } from "../../vendor/qoder/provider.mjs";
import { createRefreshGuard } from "../../vendor/qoder/refresh-guard.mjs";
import type { ConfigStore, ModelChoice, User } from "./config.ts";
import { HttpError } from "./errors.ts";
import type { KernelRequestAuth, QoderRequestAuth } from "./rotom-executions.ts";

export function protectImportedRefresh(
    provider: ai.Provider,
    claimRefresh?: (refresh: string) => Promise<void>,
): ai.Provider {
    const oauth = provider.auth?.oauth;

    if (!oauth) {
        return provider;
    }

    return {
        ...provider,
        auth: {
            ...provider.auth,
            oauth: {
                ...oauth,
                async refresh(credential, signal) {
                    if (credential.rotomTeamReadOnlyImport === true) {
                        throw new Error(
                            "Imported login is read-only: sign in independently before refreshing. The original rotom login was not modified.",
                        );
                    }

                    signal.throwIfAborted();
                    await claimRefresh?.(credential.refresh);
                    signal.throwIfAborted();

                    return oauth.refresh(credential, signal);
                },
            },
        },
    };
}

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
        catalogError?: "unavailable";
    };
};

export function createRuntime(
    credentials?: ai.CredentialStore,
    modelsStore?: ai.ModelsStore,
): Runtime {
    const models = createModels({ credentials, modelsStore, authContext: noAmbient });
    const authStatus = new Map<string, ai.AuthCheck>();
    const catalogErrors = new Set<string>();
    const refresh = models.refresh.bind(models);
    let available: readonly ai.Model<ai.Api>[] = [];
    const getAvailable = models.getAvailable.bind(models);

    return Object.assign(models, {
        registerNativeProvider: (provider: ai.Provider) => models.setProvider(provider),
        async refresh(options?: ai.ModelsRefreshOptions) {
            const result = await refresh(options);

            for (const provider of options?.providers ??
                models.getProviders().map((provider) => provider.id)) {
                if (result.errors.has(provider)) {
                    catalogErrors.add(provider);
                } else {
                    catalogErrors.delete(provider);
                }
            }

            return result;
        },
        async getAvailable(provider?: string, options?: ai.AuthOperationOptions) {
            const result = await getAvailable(provider, options);

            for (const entry of models
                .getProviders()
                .filter((entry) => provider === undefined || entry.id === provider)) {
                const status = await models.checkAuth(entry.id, options);

                if (status) {
                    authStatus.set(entry.id, status);
                } else {
                    authStatus.delete(entry.id);
                }
            }

            available =
                provider === undefined
                    ? result
                    : [...available.filter((m) => m.provider !== provider), ...result];

            return result;
        },
        getAvailableSnapshot: () => available,
        hasConfiguredAuth: (provider: string) => authStatus.has(provider),
        getProviderAuthStatus: (provider: string) => ({
            configured: authStatus.has(provider),
            source: authStatus.get(provider)?.source,
            catalogError: catalogErrors.has(provider) ? ("unavailable" as const) : undefined,
        }),
    });
}

type Profile = { generations: Record<string, string>; model?: ModelChoice };
type Account = {
    runtime: Runtime;
    credentials: FileCredentials;
    modelsStore: FileModelsStore;
    profile: Profile;
    folder: string;
    aliases: Set<string>;
};

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
            join(folder, "models-store.json"),
            join(folder, "oauth-refresh"),
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
        const credentials = new FileCredentials(join(folder, "auth.json"));
        const modelsStore = new FileModelsStore(join(folder, "models-store.json"));
        const runtime = createRuntime(credentials, modelsStore);

        const refreshFolder = join(folder, "oauth-refresh");

        mkdirSync(refreshFolder, { recursive: true, mode: 0o700 });
        const claimRefresh = createRefreshGuard(realpathSync(refreshFolder));

        runtime.setProvider(protectImportedRefresh(chatGPTProvider(), claimRefresh));
        runtime.setProvider(
            protectImportedRefresh(
                { ...openaiCodexProvider(), name: "ChatGPT / Codex" },
                claimRefresh,
            ),
        );
        runtime.setProvider(
            protectImportedRefresh(
                await createQoderProvider({
                    piAI: ai,
                    clampMaxTokens: clampMaxTokensToContext,
                    authMode: "browser",
                    oauthOptions: { claimRefresh: createRefreshGuard(realpathSync(folder)) },
                }),
            ),
        );
        this.#configure?.(runtime, user);
        const account = {
            runtime,
            credentials,
            modelsStore,
            profile,
            folder,
            aliases: new Set<string>(),
        };

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

    /** Native Qoder account commands stay in the credential-owning parent, not the broker HOME. */
    async nativeQoder(user: User, action: "models" | "credits"): Promise<unknown> {
        const account = await this.forUser(user);

        if (user.role === "viewer" || this.#changing.has(user.id)) {
            throw new HttpError(403, "This personal account is unavailable for commands.");
        }

        const generation = account.profile.generations.qoder;
        const provider = account.runtime.getProvider("qoder") as
            | (ai.Provider & {
                  getCatalogStatus(): unknown;
                  getQuotaUsage(options: { apiKey: string; signal: AbortSignal }): Promise<{
                      observedAt: number;
                      pools: Record<
                          string,
                          {
                              unit: string;
                              total: number | null;
                              used: number | null;
                              remaining: number | null;
                          } | null
                      >;
                  }>;
              })
            | undefined;

        if (!provider || !account.runtime.hasConfiguredAuth("qoder")) {
            throw new HttpError(409, "Sign in to your own Qoder account first.");
        }

        if (action === "models") {
            await this.refresh(user, undefined, true);

            if (account.runtime.getProviderAuthStatus("qoder").catalogError) {
                throw new HttpError(
                    409,
                    "Personal Qoder catalog refresh is unavailable; it was not retried.",
                );
            }
        }

        const check = () => {
            if (
                this.#config.userById(user.id)?.role === "viewer" ||
                !this.#config.userById(user.id) ||
                this.#changing.has(user.id) ||
                account.profile.generations.qoder !== generation
            ) {
                throw new HttpError(409, "Personal account changed during the native command.");
            }
        };

        check();

        if (action === "models") {
            return { catalog: provider.getCatalogStatus() };
        }

        const signal = AbortSignal.timeout(15_000);
        const auth = await account.runtime.getAuth("qoder", { signal });

        check();

        if (!auth?.auth.apiKey) {
            throw new HttpError(409, "Personal Qoder request authorization is unavailable.");
        }

        const credits = await provider.getQuotaUsage({ apiKey: auth.auth.apiKey, signal });

        check();

        const poolLines = Object.entries(credits.pools).map(([name, pool]) => {
            if (!pool) {
                return `${name}: not reported`;
            }

            return `${name}: remaining ${pool.remaining ?? "?"} / ${pool.total ?? "?"} ${pool.unit} (used ${pool.used ?? "?"})`;
        });
        const title = "Qoder Credit snapshot";

        return {
            credits,
            title,
            text: [
                `${title} (${new Date(credits.observedAt).toISOString()})`,
                ...poolLines,
                "Account snapshot only; shared/concurrent use may change it. Not per-request debit or USD cost.",
            ].join("\n"),
        };
    }

    async refresh(user: User, rotateProvider?: string, forceQoder = false): Promise<void> {
        const account = this.#accounts.get(user.id)!;

        if (rotateProvider === "qoder") {
            account.runtime.setProvider(
                protectImportedRefresh(
                    await createQoderProvider({
                        piAI: ai,
                        clampMaxTokens: clampMaxTokensToContext,
                        authMode: "browser",
                        oauthOptions: {
                            claimRefresh: createRefreshGuard(realpathSync(account.folder)),
                        },
                    }),
                ),
            );
        }

        // OAuth model choices are account-specific. Catalog failure never exposes the static API-key directory.
        await account.runtime.refresh({
            providers: forceQoder ? ["qoder"] : ["openai", "qoder"],
            force: forceQoder,
        });
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

    kernelModel(user: User, ref: ModelRef): ai.Model<ai.Api> {
        this.assertModel(user, ref);
        const account = this.#accounts.get(user.id)!;
        const provider = account.runtime
            .getProviders()
            .find(
                (p) =>
                    ref.provider === `team:${user.id}:${account.profile.generations[p.id]}:${p.id}`,
            );

        if (!provider) {
            throw new HttpError(
                403,
                "Kernel execution requires your current personal account route.",
            );
        }

        const model = account.runtime.getModel(provider.id, ref.modelId);

        if (
            !model ||
            (!["openai-completions", "openai-responses", "openai-codex-responses"].includes(
                model.api,
            ) &&
                !(provider.id === "qoder" && model.provider === "qoder" && model.api === "qoder"))
        ) {
            throw new HttpError(
                409,
                "This provider route is not enabled for the rotom backend yet.",
            );
        }

        return model;
    }

    async kernelAuth(user: User, ref: ModelRef, signal?: AbortSignal): Promise<KernelRequestAuth> {
        let model = this.kernelModel(user, ref);
        const account = this.#accounts.get(user.id)!;

        if (model.api === "qoder") {
            const refreshed = await account.runtime.refresh({ providers: ["qoder"], signal });

            if (refreshed.errors.has("qoder")) {
                throw new HttpError(409, "Qoder account catalog is unavailable.");
            }

            model = this.kernelModel(user, ref);
        }

        const auth = await account.runtime.getAuth(model, { signal });

        // Login/role changes during refresh invalidate admission. The original store remains the sole refresh writer.
        this.kernelModel(user, ref);

        if (!auth || (auth.env && Object.keys(auth.env).length)) {
            throw new HttpError(409, "No supported personal request credential.");
        }

        if (model.api === "qoder") {
            // getAuth above validates/refreshes the sole stored grant. Its sealed request envelope
            // is process-local: export only access fields, never the grant or its refresh capability.
            const credential = await account.credentials.read("qoder", { signal });
            const stored = await account.modelsStore.read("qoder", { signal });
            const catalog = stored as
                (ai.ModelsStoreEntry & QoderRequestAuth["catalog"]) | undefined;

            this.kernelModel(user, ref);

            if (
                credential?.type !== "oauth" ||
                credential.qoderAuthVersion !== 1 ||
                !catalog ||
                catalog.scope !== credential.fingerprint
            ) {
                throw new HttpError(409, "Qoder request identity is unavailable.");
            }

            return {
                qoder: {
                    credential: {
                        accessToken: credential.access,
                        expiresAt: credential.expires,
                        fingerprint: credential.fingerprint as string,
                        uid: credential.uid as string | number,
                        org: credential.org as string | number,
                        machineId: credential.machineId as string,
                    },
                    catalog: {
                        scope: catalog.scope,
                        checkedAt: catalog.checkedAt,
                        metadata: catalog.metadata,
                    },
                },
            };
        }

        return auth.auth;
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
        // A removed personal selection must be explicitly replaced, not silently charged to another connected provider.
        const model = last
            ? all.find((m) => m.provider === last.provider && m.id === last.modelId)
            : all[0];

        return (
            model && {
                provider: model.provider,
                modelId: model.id,
                thinkingLevel: ai
                    .getSupportedThinkingLevels(model)
                    .includes((last?.thinkingLevel ?? "off") as ai.ModelThinkingLevel)
                    ? (last?.thinkingLevel ?? "off")
                    : ai.getSupportedThinkingLevels(model)[0],
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
