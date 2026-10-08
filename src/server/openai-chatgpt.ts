/** Official SIWC account catalog: subscription credentials must not expose the static API-key catalog. */
import { createHash } from "node:crypto";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type {
    Credential,
    Model,
    ModelThinkingLevel,
    ModelsStoreEntry,
    Provider,
    StreamOptions,
} from "@earendil-works/pi-ai";
const TTL = 10 * 60_000;
const LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

type Catalog = ModelsStoreEntry & {
    scope: string;
    models: Model<"openai-responses">[];
    checkedAt: number;
};
// A client registration can be reused; it is not an account identity. Bind the private cache to this exact grant, too.
const scopeOf = (credential?: Credential) =>
    credential?.type === "oauth" && typeof credential.clientId === "string"
        ? `${credential.clientId}:${createHash("sha256").update(credential.refresh).digest("hex")}`
        : undefined;

export function parseChatGPTCatalog(value: unknown): Model<"openai-responses">[] {
    const body = value as { models?: Record<string, unknown>[] } | null;

    if (!body || !Array.isArray(body.models) || body.models.length > 256) {
        throw new Error("Unsupported ChatGPT catalog shape.");
    }

    const seen = new Set<string>();

    return body.models
        .filter((entry) => entry.visibility === "list")
        .map((entry) => {
            if (
                typeof entry.slug !== "string" ||
                !entry.slug ||
                typeof entry.display_name !== "string" ||
                !Number.isSafeInteger(entry.context_window) ||
                Number(entry.context_window) < 4096 ||
                !Array.isArray(entry.input_modalities) ||
                !entry.input_modalities.includes("text") ||
                !Array.isArray(entry.supported_reasoning_levels)
            ) {
                throw new Error("Unsupported ChatGPT model metadata.");
            }

            if (seen.has(entry.slug)) {
                throw new Error("Duplicate ChatGPT model slug.");
            }

            seen.add(entry.slug);
            const efforts = entry.supported_reasoning_levels.map(
                (level) => (level as { effort: string }).effort,
            );
            const thinkingLevelMap = Object.fromEntries(
                LEVELS.map((level) => [
                    level,
                    efforts.includes(level === "off" ? "none" : level)
                        ? level === "off"
                            ? "none"
                            : level
                        : null,
                ]),
            );

            return {
                id: entry.slug,
                name: entry.display_name,
                provider: "openai",
                api: "openai-responses",
                baseUrl: "https://api.openai.com/v1",
                reasoning: efforts.some((effort) => effort !== "none"),
                thinkingLevelMap,
                input: entry.input_modalities.includes("image") ? ["text", "image"] : ["text"],
                contextWindow: Number(entry.context_window),
                maxTokens: 4096,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            };
        });
}

export function chatGPTPayload(value: unknown): unknown {
    const payload = value as {
        tools?: { type: string; name?: string; description?: string; tools?: unknown[] }[];
    };

    if (!payload.tools?.length) {
        return value;
    }

    const flat = payload.tools.filter((tool) => tool.type === "function" || tool.type === "custom");
    const groups = payload.tools.filter((tool) => tool.type === "namespace");

    if (flat.length + groups.length !== payload.tools.length) {
        throw new Error("This ChatGPT plan route does not support hosted tools or tool_search.");
    }

    if (!flat.length) {
        return value;
    }

    const functions = groups.find((group) => group.name === "functions");

    return {
        ...payload,
        tools: [
            ...groups.filter((group) => group !== functions),
            {
                ...functions,
                type: "namespace",
                name: "functions",
                description:
                    functions?.description ?? "Local tools executed by the self-hosted app.",
                tools: [...(functions?.tools ?? []), ...flat],
            },
        ],
    };
}

export function chatGPTProvider(fetchImpl: typeof fetch = fetch): Provider {
    const native: Provider = openaiProvider();
    let catalog: Catalog | undefined;
    const optionsFor = <T extends StreamOptions>(options: T | undefined): T =>
        ({
            ...options,
            async onPayload(payload, model) {
                const replacement = await options?.onPayload?.(payload, model);
                const prepared = replacement === undefined ? payload : replacement;

                // Native Pi already omits unsupported scalar fields for SIWC. Its default function list still needs a namespace.
                return catalog ? chatGPTPayload(prepared) : prepared;
            },
        }) as T;

    return {
        ...native,
        name: "OpenAI API / ChatGPT",
        stream: (model, context, options) => native.stream(model, context, optionsFor(options)),
        streamSimple: (model, context, options) =>
            native.streamSimple(model, context, optionsFor(options)),
        getModels: () => [
            ...(catalog?.models ?? []),
            ...native
                .getModels()
                .filter((model) => !catalog?.models.some((known) => known.id === model.id)),
        ],
        filterModels(models, credential) {
            if (credential?.type !== "oauth") {
                return models;
            }

            if (!catalog || catalog.scope !== scopeOf(credential)) {
                return [];
            }

            return catalog.models.flatMap((model) =>
                models.filter((available) => available.id === model.id),
            );
        },
        async refreshModels(context) {
            if (context.credential?.type !== "oauth") {
                catalog = undefined;

                return;
            }

            const scope = scopeOf(context.credential);

            if (!scope) {
                throw new Error(
                    "ChatGPT requires an independently issued SIWC client credential, not a rekeyed Codex credential.",
                );
            }

            const stored = context.stored as Catalog | undefined;

            if (!catalog && stored?.scope === scope) {
                await context.publish({
                    update: () => {
                        catalog = stored;
                    },
                });
            }

            if (
                !context.allowNetwork ||
                (!context.force && catalog?.scope === scope && catalog.checkedAt + TTL > Date.now())
            ) {
                return;
            }

            const signal = AbortSignal.any([context.signal, AbortSignal.timeout(30_000)]);
            const response = await fetchImpl("https://api.openai.com/v1/models", {
                headers: { Authorization: `Bearer ${context.credential.access}` },
                signal,
            });

            if (!response.ok) {
                throw new Error(
                    `ChatGPT account catalog HTTP ${response.status}. No inference was dispatched.`,
                );
            }

            const next: Catalog = {
                models: parseChatGPTCatalog(await response.json()),
                scope,
                checkedAt: Date.now(),
            };

            await context.publish({
                persist: next,
                update: () => {
                    catalog = next;
                },
            });
        },
    };
}
