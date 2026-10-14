/** Team-owned policy extension for the pinned product; observer-hook exceptions are not dispatch authorization. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chatGPTPayload } from "./openai-chatgpt-payload.ts";
import { qoderRequestProvider } from "./rotom-qoder.mjs";
import { bindSessionAccount } from "../../runtime/rotom/node_modules/@bingjiang0611/rotom/extensions/qoder/session-policy.mjs";
import { CREDIT_ENTRY } from "../../runtime/rotom/node_modules/@bingjiang0611/rotom/extensions/qoder/credits.mjs";
import {
    contentText,
    lazyStream,
} from "../../runtime/rotom/node_modules/@bingjiang0611/rotom/runtime/pi/node_modules/@earendil-works/pi-ai/dist/index.js";

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
            ...(config.modelDefinition.api === "qoder"
                ? {
                      // Qoder is a custom API. Never allow its startup registration to
                      // dispatch before the session_start wrapper below installs the gate.
                      streamSimple: (model) =>
                          lazyStream(model, async () => {
                              throw new Error("team_kernel_gate_unavailable");
                          }),
                  }
                : {}),
        });
    }

    const authorize = async (operation, provider, model, signal, usage) => {
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
            body: JSON.stringify({ operation, provider, model, ...(usage ? { usage } : {}) }),
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

    // Background subagents outlive the tool call that starts them. Report how many still owe this kernel a result, so
    // the team keeps the run, and with it this gate, open until each result is back. Children run this policy too.
    const children = new Set();
    let ui;

    const report = () =>
        ui?.notify(
            JSON.stringify({ kind: "team-kernel-children-v1", pending: children.size }),
            "info",
        );

    pi.events.on("subagent:async-started", (data) => {
        children.add(String(data?.id));
        report();
    });
    // pi-subagents announces completion once it has handed the result to this session.
    pi.events.on("subagent:async-complete", (data) => {
        children.delete(String(data?.id));
        report();
    });

    // A subagent's entries stay in its own session, out of the team journal: it tells the gate what each response spent.
    if (process.env.ROTOM_TEAM_SUBAGENT === "1") {
        pi.on("message_end", async (event) => {
            const message = event.message;

            if (message?.role === "assistant" && message.usage) {
                await authorize("usage", message.provider, message.model, undefined, message.usage);
            }
        });
    }

    pi.registerCommand("team-kernel-stop-children", {
        description: "Private: stop this run's background subagents (no model request)",
        handler: async () => {
            for (const id of children) {
                // pi-subagents' cross-extension RPC; it signals the child before it replies.
                pi.events.emit("subagents:rpc:v1:request", {
                    version: 1,
                    requestId: randomUUID(),
                    method: "stop",
                    params: { id },
                });
            }
        },
    });

    pi.registerCommand("team-kernel-tree", {
        description: "Private Team branch navigation",
        handler: async (args, ctx) => {
            const { nonce, entryId, summarize } = JSON.parse(args);

            await ctx.waitForIdle();
            const oldLeafId = ctx.sessionManager.getLeafId();
            const target = ctx.sessionManager.getEntry(entryId);
            const before = new Set(ctx.sessionManager.getEntries().map((entry) => entry.id));
            const result = await ctx.navigateTree(entryId, { summarize });

            if (!result.cancelled && entryId !== oldLeafId) {
                // Pinned RPC returns only cancelled. Reuse native's text extraction, not a fabricated RPC field.
                if (target.type === "message" && target.message.role === "user") {
                    result.editorText = contentText(target.message.content, "");
                } else if (target.type === "custom_message") {
                    result.editorText = contentText(target.content, "");
                }

                const summary = ctx.sessionManager
                    .getEntries()
                    .findLast((entry) => entry.type === "branch_summary" && !before.has(entry.id));

                if (summary) {
                    result.summaryEntry = summary;
                }

                // Persist the new leaf even when navigation did not need a generated summary.
                pi.appendEntry("team-kernel-branch", { targetId: entryId });
            }

            ctx.ui.notify(JSON.stringify({ kind: "team-kernel-tree-v1", nonce, result }), "info");
        },
    });
    pi.registerCommand("team-kernel-reload", {
        description: "Private Team resource reload",
        handler: async (_args, ctx) => {
            await ctx.reload();
        },
    });
    pi.registerCommand("team-kernel-barrier", {
        description: "Private: wait for native follow-up work before Team snapshots state",
        handler: async (args, ctx) => {
            await ctx.waitForIdle();
            ui?.notify(
                JSON.stringify({
                    kind: "team-kernel-barrier-v1",
                    nonce: String(args ?? ""),
                    ok: true,
                }),
                "info",
            );
        },
    });

    pi.on("session_start", async (_event, ctx) => {
        ui = ctx.ui;
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
                                "qoder",
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

                        if (model.api === "qoder") {
                            const provider = await qoderRequestProvider(
                                auth?.qoder,
                                options.signal,
                                (data) => {
                                    const selected = Object.fromEntries(
                                        [
                                            "modelId",
                                            "requestId",
                                            "status",
                                            "outcome",
                                            "credits",
                                            "billable",
                                            "originalCredits",
                                        ]
                                            .filter((key) => data[key] !== undefined)
                                            .map((key) => [key, data[key]]),
                                    );

                                    pi.appendEntry(CREDIT_ENTRY, {
                                        version: 1,
                                        sessionId: ctx.sessionManager.getSessionId(),
                                        ...selected,
                                    });
                                },
                            );

                            bindSessionAccount(
                                ctx.sessionManager,
                                (type, data) => pi.appendEntry(type, data),
                                auth.qoder.credential.fingerprint,
                            );

                            return provider[method](model, context, {
                                ...options,
                                apiKey: undefined,
                            });
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
                ...(config.modelDefinition && id === config.provider
                    ? {
                          // Legacy registration can retain a built-in OAuth definition.
                          // Replace it, rather than letting prompt preflight seek a native grant.
                          auth: {
                              apiKey: {
                                  name: "Team request broker",
                                  resolve: async () => ({
                                      auth: { apiKey: "team-request-auth" },
                                      source: "Team parent credential store",
                                  }),
                              },
                          },
                          getModels: () => [config.modelDefinition],
                          getAllModels: () => [config.modelDefinition],
                          filterModels: (models) =>
                              models.filter((model) => model.id === config.model),
                          filterAllModels: (models) =>
                              models.filter((model) => model.id === config.model),
                      }
                    : oauth
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
