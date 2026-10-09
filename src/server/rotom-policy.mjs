/** Team-owned policy extension for the pinned product; observer-hook exceptions are not dispatch authorization. */
import { readFileSync } from "node:fs";
import { lazyStream } from "../../runtime/rotom/node_modules/@bingjiang0611/rotom/runtime/pi/node_modules/@earendil-works/pi-ai/dist/index.js";

export default function (pi) {
    const config = JSON.parse(readFileSync(process.env.ROTOM_TEAM_KERNEL_GATE, "utf8"));
    let ready = false;

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

        // Consume no response body into model context; denied/unavailable never dispatches or retries inference.
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

                        await authorize("inference", model.provider, model.id, options.signal);

                        // The pinned fork exposes these native request controls. Avoid SDK redispatch and Codex WS/SSE fallback.
                        return native[method](model, context, {
                            ...options,
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
