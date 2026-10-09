/** Team-owned policy extension for the pinned product; observer-hook exceptions are not dispatch authorization. */
import { readFileSync } from "node:fs";
import { chatGPTPayload } from "./openai-chatgpt-payload.ts";
import { lazyStream } from "../../runtime/rotom/node_modules/@bingjiang0611/rotom/runtime/pi/node_modules/@earendil-works/pi-ai/dist/index.js";

export default function (pi) {
    const config = JSON.parse(readFileSync(process.env.ROTOM_TEAM_KERNEL_GATE, "utf8"));
    let ready = false;

    if (config.modelDefinition) {
        // Registration happens before CLI model selection. This sentinel is never sent to a provider.
        // Only the parent credential store resolves/refreshes auth; no OAuth grant is copied into this HOME.
        pi.registerProvider(config.provider, {
            api: config.modelDefinition.api,
            baseUrl: config.modelDefinition.baseUrl,
            apiKey: "team-request-auth",
            models: [config.modelDefinition],
        });
    }

    const authorize = async (operation, provider, model, signal) => {
        if (provider !== config.provider || (model !== undefined && model !== config.model)) {
            throw new Error("team_kernel_identity_denied");
        }

        const response = await fetch(config.url, {
            method: "POST",
            redirect: "error",
            headers: {
                Authorization: `Bearer ${config.token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ operation, provider, model }),
            signal: signal
                ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
                : AbortSignal.timeout(10000),
        });

        if (config.modelDefinition && operation === "inference" && response.status === 200) {
            // A private request credential, never a prompt/event/file. Native streams receive it only as auth options.
            const body = await response.text();

            if (Buffer.byteLength(body) > 65536) {
                throw new Error("team_kernel_auth_too_large");
            }

            return JSON.parse(body);
        }

        await response.body?.cancel();

        if (response.status !== 204) {
            throw new Error("team_kernel_dispatch_denied");
        }
    };

    pi.on("session_start", async (_event, ctx) => {
        const registry = ctx.modelRegistry;
        const ids = new Set(
            [...registry.getAll(), ...registry.getModelsOfType("image")].map(
                (model) => model.provider,
            ),
        );

        for (const id of ids) {
            const native = registry.getProvider(id);

            if (!native) {
                continue;
            }

            const wrap =
                (method) =>
                (model, context, options = {}) =>
                    lazyStream(model, async () => {
                        if (
                            ![
                                "openai-completions",
                                "openai-responses",
                                "openai-codex-responses",
                            ].includes(model.api)
                        ) {
                            throw new Error("team_kernel_api_unreviewed");
                        }

                        const auth = await authorize(
                            "inference",
                            model.provider,
                            model.id,
                            options.signal,
                        );

                        if (config.modelDefinition && !auth) {
                            throw new Error("team_kernel_auth_missing");
                        }

                        const target = auth?.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
                        const siwc =
                            target.provider === "openai" &&
                            target.baseUrl === "https://api.openai.com/v1" &&
                            auth?.apiKey &&
                            !auth.apiKey.startsWith("sk-");

                        return native[method](target, context, {
                            ...options,
                            ...(auth
                                ? {
                                      apiKey: auth.apiKey,
                                      headers: { ...options.headers, ...auth.headers },
                                  }
                                : {}),
                            ...(siwc
                                ? {
                                      onPayload: async (payload, model) =>
                                          chatGPTPayload(
                                              (await options.onPayload?.(payload, model)) ??
                                                  payload,
                                          ),
                                  }
                                : {}),
                            maxRetries: 0,
                            transport: "sse",
                        });
                    });
            const oauth = native.auth?.oauth;

            registry.registerProvider({
                ...native,
                stream: wrap("stream"),
                streamSimple: wrap("streamSimple"),
                // These execution paths have no team receipt/import contract yet; do not retain an unguarded native method.
                generateImages: undefined,
                fetchDeferred: undefined,
                cancelDeferred: undefined,
                ...(oauth
                    ? {
                          auth: {
                              ...native.auth,
                              oauth: {
                                  ...oauth,
                                  async refresh(credential, signal) {
                                      await authorize("refresh", id, undefined, signal);

                                      return oauth.refresh(credential, signal);
                                  },
                              },
                          },
                      }
                    : {}),
            });
        }

        ready = ids.has(config.provider);
    });
    pi.registerCommand("team-kernel-probe", {
        description: "Private kernel integration readiness probe (no model request)",
        handler: async (nonce, ctx) => {
            ctx.ui.notify(JSON.stringify({ kind: "team-kernel-policy-v1", nonce, ready }), "info");
        },
    });
}
