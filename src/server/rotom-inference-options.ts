/** Assemble the already-authorized OpenAI-compatible HTTP request options. */
import type { StreamOptions } from "@earendil-works/pi-ai";
import { chatGPTPayload } from "./openai-chatgpt-payload.ts";
import {
    inferenceDiagnosticFetch,
    type InferenceHttpFailure,
} from "./rotom-inference-diagnostics.ts";

export function inferenceRequestOptions(
    model: { provider: string; baseUrl: string },
    auth: Pick<StreamOptions, "apiKey" | "headers"> | undefined,
    options: StreamOptions,
    record: (failure: InferenceHttpFailure) => void,
): StreamOptions {
    const siwc =
        model.provider === "openai" &&
        model.baseUrl === "https://api.openai.com/v1" &&
        auth?.apiKey &&
        !auth.apiKey.startsWith("sk-");

    return {
        ...options,
        ...(auth ? { apiKey: auth.apiKey, headers: { ...options.headers, ...auth.headers } } : {}),
        ...(siwc
            ? {
                  onPayload: async (payload, model) =>
                      chatGPTPayload((await options.onPayload?.(payload, model)) ?? payload),
              }
            : {}),
        transport: "sse",
        fetch: inferenceDiagnosticFetch(options.fetch ?? globalThis.fetch, record),
    };
}
