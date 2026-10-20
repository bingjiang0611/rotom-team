/** Team-owned policy extension for the pinned product; observer-hook exceptions are not dispatch authorization. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chatGPTPayload } from "./openai-chatgpt-payload.ts";
import { qoderRequestProvider } from "./rotom-qoder.mjs";
import { bindSessionAccount } from "../../runtime/rotom/node_modules/@bingjiang0611/rotom/extensions/qoder/session-policy.mjs";
import { CREDIT_ENTRY } from "../../runtime/rotom/node_modules/@bingjiang0611/rotom/extensions/qoder/credits.mjs";
import { SnapshotBuilder } from "../../runtime/rotom/node_modules/@bingjiang0611/rotom/extensions/third-party/node_modules/pi-context-view/src/capture/builder.ts";
import { registerCapture } from "../../runtime/rotom/node_modules/@bingjiang0611/rotom/extensions/third-party/node_modules/pi-context-view/src/capture/register.ts";
import {
    buildFallbackInjectionsSnapshot,
    buildInjectionsSnapshot,
} from "../../runtime/rotom/node_modules/@bingjiang0611/rotom/extensions/third-party/node_modules/pi-context-view/src/injections.ts";
import { collectPromptSources } from "../../runtime/rotom/node_modules/@bingjiang0611/rotom/extensions/third-party/node_modules/pi-context-view/src/prompt-additions.ts";
import { applyRequestSnapshot } from "../../runtime/rotom/node_modules/@bingjiang0611/rotom/extensions/third-party/node_modules/pi-context-view/src/projection.ts";
import { buildUsageSnapshot } from "../../runtime/rotom/node_modules/@bingjiang0611/rotom/extensions/third-party/node_modules/pi-context-view/src/replay.ts";
import { readAutoCompactReserveTokens } from "../../runtime/rotom/node_modules/@bingjiang0611/rotom/extensions/third-party/node_modules/pi-context-view/src/settings.ts";
import { SnapshotStore } from "../../runtime/rotom/node_modules/@bingjiang0611/rotom/extensions/third-party/node_modules/pi-context-view/src/snapshot.ts";
import {
    computeUsage,
    toReportedUsage,
} from "../../runtime/rotom/node_modules/@bingjiang0611/rotom/extensions/third-party/node_modules/pi-context-view/src/usage.ts";
import {
    contentText,
    lazyStream,
} from "../../runtime/rotom/node_modules/@bingjiang0611/rotom/runtime/pi/node_modules/@earendil-works/pi-ai/dist/index.js";

const contextSnapshots = new SnapshotStore();
const contextMessages = {
    get isCurrentRun() {
        return false;
    },
    filterMessages: (messages) => messages,
};

function contextCategory(category) {
    return {
        id: category.id,
        label: category.label,
        tokens: category.tokens,
        ...(category.children?.length ? { children: category.children.map(contextCategory) } : {}),
    };
}

function contextItem(item) {
    return {
        label: item.label,
        tokens: item.tokens,
        ...(item.change ? { change: item.change } : {}),
        ...(item.dropped ? { dropped: true } : {}),
        ...(item.moved ? { moved: true } : {}),
        ...(item.requestOnly ? { requestOnly: true } : {}),
        ...(item.children?.length ? { children: item.children.map(contextItem) } : {}),
    };
}

function contextInputs(pi, ctx) {
    return {
        entries: ctx.sessionManager.getEntries(),
        options: ctx.getSystemPromptOptions(),
        allTools: pi.getAllTools(),
        activeToolNames: pi.getActiveTools(),
        promptSources: collectPromptSources(pi.getAllTools(), pi.getCommands()),
        systemPrompt: ctx.getSystemPrompt(),
    };
}

function contextResult(pi, ctx, view) {
    const snapshot = contextSnapshots.latest();
    const common = contextInputs(pi, ctx);

    if (view === "injections") {
        const injections = snapshot
            ? buildInjectionsSnapshot({
                  ...common,
                  snapshot,
                  filterMessages: contextMessages.filterMessages,
              })
            : buildFallbackInjectionsSnapshot(common);

        return {
            type: "native-context",
            title: "Context injections",
            view,
            captured: Boolean(snapshot),
            totalTokens: injections.totalTokens,
            hiddenTools: injections.hiddenTools ?? [],
            groups: injections.groups.map((group) => ({
                source: group.source.label,
                native: group.source.native,
                totalTokens: group.totalTokens,
                items: group.items.map(contextItem),
            })),
        };
    }

    const applied = applyRequestSnapshot({
        snapshot,
        entries: common.entries,
        leafId: ctx.sessionManager.getLeafId(),
        filterMessages: contextMessages.filterMessages,
    });
    const current = buildUsageSnapshot({
        ...common,
        messages: applied.messages,
        systemChanges: applied.systemChanges,
        forcedPrompt: applied.forcedPrompt,
    });
    const usage = computeUsage({
        snapshot: current,
        messages: applied.messages,
        reported: toReportedUsage(ctx.getContextUsage()),
        modelLabel: ctx.model?.id,
        autoCompactReserveTokens: readAutoCompactReserveTokens(pi, ctx.model),
    });

    return {
        type: "native-context",
        title: "Context usage",
        view: "usage",
        captured: Boolean(snapshot),
        model: usage.modelLabel,
        reported: usage.reported,
        estimatedTokens: usage.estimatedTokens,
        autoCompactReserveTokens: usage.autoCompactReserveTokens,
        categories: usage.categories.map(contextCategory),
    };
}

export default function (pi) {
    const config = JSON.parse(readFileSync(process.env.ROTOM_TEAM_KERNEL_GATE, "utf8"));
    let ready = false;

    // The product's own context extension owns a TUI-only store. Team keeps a parallel read-only capture so the Web
    // adapter can render the same measured structures without a silent model probe or raw prompt text persistence.
    registerCapture(pi, contextMessages, new SnapshotBuilder(contextSnapshots));

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

    // A runner's close, whatever its state; the product emits it after persisting the close evidence.
    const closeWaiters = new Map();

    const closed = (id) => {
        closeWaiters.get(id)?.();
        closeWaiters.delete(id);
    };

    pi.events.on("subagent:process-terminal", (proof) => closed(String(proof?.runId)));
    pi.events.on("subagent:async-complete", (data) => closed(String(data?.id)));

    pi.registerCommand("team-kernel-stop-children", {
        description: "Private: stop this run's background subagents (no model request)",
        handler: async () => {
            const stops = [...children].map(
                (id) =>
                    new Promise((resolve) => {
                        const requestId = randomUUID();
                        const reply = `subagents:rpc:v1:reply:${requestId}`;

                        let unsubscribe = () => {};

                        const done = () => {
                            unsubscribe();
                            closeWaiters.delete(id);
                            resolve();
                        };

                        closeWaiters.set(id, done);
                        unsubscribe = pi.events.on(reply, (answer) => {
                            // A run that is not running anymore has nothing to stop or wait for.
                            if (answer?.success !== true) {
                                done();
                            }
                        });
                        // pi-subagents' cross-extension RPC: it files a stop request the runner reads.
                        pi.events.emit("subagents:rpc:v1:request", {
                            version: 1,
                            requestId,
                            method: "stop",
                            params: { id },
                        });
                    }),
            );

            // Session shutdown interrupts (pauses) a runner that has not read its stop request yet, so wait for each
            // runner to close before the kernel may close. Bounded: a runner that does not close is left to shutdown.
            let timer;

            await Promise.race([
                Promise.all(stops),
                new Promise((resolve) => {
                    timer = setTimeout(resolve, 10_000);
                }),
            ]);
            clearTimeout(timer);
        },
    });

    pi.registerCommand("team-kernel-context", {
        description: "Private Team context view adapter",
        handler: async (args, ctx) => {
            const { nonce, view } = JSON.parse(args);

            if (!nonce || !["usage", "injections"].includes(view)) {
                throw new Error("Use /context [usage|injections]");
            }

            await ctx.waitForIdle();
            ctx.ui.notify(
                JSON.stringify({
                    kind: "team-kernel-context-v1",
                    nonce,
                    result: contextResult(pi, ctx, view),
                }),
                "info",
            );
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
    pi.on("session_shutdown", () => contextSnapshots.clear());

    pi.registerCommand("team-kernel-probe", {
        description: "Private kernel integration readiness probe (no model request)",
        handler: async (nonce, ctx) => {
            ctx.ui.notify(JSON.stringify({ kind: "team-kernel-policy-v1", nonce, ready }), "info");
        },
    });
}
