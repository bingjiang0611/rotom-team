/**
 * Model providers: which ones Pi knows, whether each is signed in, and sign-ins run from the app. A sign-in asks its
 * questions (an API key, a code, a choice) through the tabs of the person who started it. Credentials belong to
 * that member's private store, never the host Pi account.
 */
import { randomUUID } from "node:crypto";
import type { AuthPrompt } from "@earendil-works/pi-ai";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { describe, HttpError } from "./errors.ts";
import { modelList } from "./models.ts";

interface AuthFlow {
    id: string;
    userId: string;
    prompts: Map<string, { resolve: (value: string) => void; reject: (error: Error) => void }>;
    abort: AbortController;
    openaiCallback: boolean;
}

export class Providers {
    readonly #app: PocketApp;
    readonly #flows = new Map<string, AuthFlow>();

    constructor(app: PocketApp) {
        this.#app = app;
    }

    async list(user: User) {
        const { runtime: models } = await this.#app.accounts.forUser(user);

        return models.getProviders().map((provider) => {
            const status = models.getProviderAuthStatus(provider.id);
            const auth = (
                provider as {
                    auth?: { apiKey?: unknown; oauth?: { name?: string; loginLabel?: string } };
                }
            ).auth;

            return {
                id: provider.id,
                name: provider.name,
                configured: status.configured,
                source: status.source ?? null,
                label: status.label ?? null,
                catalogError: status.catalogError ?? null,
                apiKey: auth?.apiKey !== undefined,
                oauth:
                    auth?.oauth === undefined
                        ? null
                        : (auth.oauth.loginLabel ?? auth.oauth.name ?? "Subscription"),
                models: status.configured
                    ? models
                          .getAvailableSnapshot()
                          .filter((model) => model.provider === provider.id).length
                    : models.getModels(provider.id).length,
            };
        });
    }

    async startLogin(user: User, providerId: string, type: "api_key" | "oauth"): Promise<string> {
        return this.#app.accounts.exclusive(user, () => this.#startLogin(user, providerId, type));
    }

    async #startLogin(user: User, providerId: string, type: "api_key" | "oauth"): Promise<string> {
        const app = this.#app;

        app.requireSteer(user);
        const { runtime } = await app.accounts.forUser(user);

        if (!runtime.getProvider(providerId)) {
            throw new HttpError(404, "No such provider");
        }

        if (this.#flows.size && [...this.#flows.values()].some((flow) => flow.userId === user.id)) {
            throw new HttpError(409, "Finish or cancel your current login first.");
        }

        await app.execution.accountIdle(user);
        // Both SDK sign-ins may bind the same host callback port. Claim synchronously after admission.
        const openaiCallback = type === "oauth" && ["openai", "openai-codex"].includes(providerId);

        if (openaiCallback && [...this.#flows.values()].some((flow) => flow.openaiCallback)) {
            throw new HttpError(
                409,
                "Another OpenAI login is in progress. Finish or cancel it first; callback port 1455 is shared.",
            );
        }

        const flow: AuthFlow = {
            id: randomUUID(),
            userId: user.id,
            prompts: new Map(),
            abort: new AbortController(),
            openaiCallback,
        };

        app.accounts.beginChange(user, providerId);
        this.#flows.set(flow.id, flow);

        const send = (data: Record<string, unknown>) => {
            for (const client of app.clients) {
                if (client.user.id === user.id) {
                    client.send("auth", { flowId: flow.id, providerId, ...data });
                }
            }
        };

        const interaction = {
            signal: flow.abort.signal,
            prompt: (prompt: AuthPrompt) =>
                new Promise<string>((resolvePrompt, rejectPrompt) => {
                    const { signal = flow.abort.signal, ...shown } = prompt;

                    // Cancellation may land between answering one prompt and creating the next.
                    flow.abort.signal.throwIfAborted();
                    signal.throwIfAborted();
                    const promptId = randomUUID();

                    flow.prompts.set(promptId, { resolve: resolvePrompt, reject: rejectPrompt });
                    signal.addEventListener("abort", () => {
                        flow.prompts.delete(promptId);
                        send({ step: "prompt-closed", promptId });
                        rejectPrompt(new Error("cancelled"));
                    });
                    send({ step: "prompt", promptId, prompt: shown });
                }),
            notify: (event: unknown) => send({ step: "event", event }),
        };

        const timeout = openaiCallback
            ? setTimeout(
                  () =>
                      flow.abort.abort(
                          new Error(
                              "OpenAI login timed out after 10 minutes. Start a new login; do not reuse the old callback URL.",
                          ),
                      ),
                  10 * 60_000,
              ).unref()
            : undefined;

        void (async () => {
            let result: { ok: boolean; error?: string };

            try {
                if (providerId === "openai" && type === "oauth") {
                    // Host/Origin cannot distinguish a local browser from an SSH-forwarded one.
                    // Ask before the SDK registers a client, binds its callback or emits an authorization URL.
                    const location = await interaction.prompt({
                        type: "select",
                        message:
                            "Where is this browser running? OpenAI returns to this browser's 127.0.0.1:1455, not automatically to the team server.",
                        options: [
                            { id: "local", label: "On the same computer as the team server" },
                            { id: "ssh", label: "On another computer — temporary SSH forwarding" },
                        ],
                        signal: flow.abort.signal,
                    });

                    if (location === "ssh") {
                        send({ step: "callback-guide" });
                        const ready = await interaction.prompt({
                            type: "select",
                            message:
                                "Prepare the SSH forward shown here before continuing. This is your confirmation, not an automatic connectivity check.",
                            options: [
                                {
                                    id: "ready",
                                    label: "My temporary forward is ready — continue to OpenAI",
                                },
                            ],
                            signal: flow.abort.signal,
                        });

                        if (ready !== "ready") {
                            throw new Error("Invalid callback readiness choice");
                        }
                    } else if (location !== "local") {
                        throw new Error("Invalid browser location choice");
                    }
                }

                flow.abort.signal.throwIfAborted();
                await runtime.login(providerId, type, interaction, { getDeviceId: () => user.id });
                result = { ok: true };
            } catch (error) {
                result = { ok: false, error: describe(flow.abort.signal.reason ?? error) };
            }

            try {
                // Reconcile even after cancellation: the old credential remains, but its old route was revoked.
                await app.accounts.refresh(user, result.ok ? providerId : undefined);
            } finally {
                app.accounts.endChange(user);
            }

            await app.models.getAvailable();
            this.#sendModels(user);
            send({ step: "done", ...result });
        })()
            .catch(() =>
                send({
                    step: "done",
                    ok: false,
                    error: "Account synchronization failed. Reconnect your account before executing.",
                }),
            )
            .finally(() => {
                clearTimeout(timeout);
                this.#flows.delete(flow.id);
            });

        return flow.id;
    }

    answerLogin(user: User, flowId: string, promptId: string, value: string | undefined): void {
        const flow = this.#flows.get(flowId);

        if (flow === undefined || flow.userId !== user.id) {
            throw new HttpError(404, "No such login");
        }

        const prompt = flow.prompts.get(promptId);

        if (prompt === undefined) {
            throw new HttpError(404, "No such prompt");
        }

        flow.prompts.delete(promptId);

        if (value === undefined) {
            prompt.reject(new Error("cancelled"));
            flow.abort.abort();
        } else {
            prompt.resolve(value);
        }
    }

    /** Stop a sign-in its person gave up on, whether or not it is asking something. */
    cancelLogin(user: User, flowId: string): void {
        const flow = this.#flows.get(flowId);

        if (flow === undefined || flow.userId !== user.id) {
            return;
        }

        for (const prompt of flow.prompts.values()) {
            prompt.reject(new Error("cancelled"));
        }

        flow.prompts.clear();
        flow.abort.abort();
    }

    async logout(user: User, providerId: string): Promise<void> {
        return this.#app.accounts.exclusive(user, () => this.#logout(user, providerId));
    }

    async #logout(user: User, providerId: string): Promise<void> {
        const app = this.#app;

        app.requireSteer(user);
        const { runtime } = await app.accounts.forUser(user);

        await app.execution.accountIdle(user);
        app.accounts.beginChange(user, providerId);

        try {
            await runtime.logout(providerId);
            await app.accounts.refresh(user);
        } finally {
            app.accounts.endChange(user);
        }

        await app.models.getAvailable();
        this.#sendModels(user);
    }

    /** Every tab gets the models available now. */
    #sendModels(user: User): void {
        const models = modelList(this.#app.models).filter((model) =>
            this.#app.accounts.owns(user, model.provider),
        );

        for (const client of this.#app.clients) {
            if (client.user.id === user.id) {
                client.send("models", models);
            }
        }
    }

    close(): void {
        for (const flow of this.#flows.values()) {
            flow.abort.abort();
        }
    }
}
