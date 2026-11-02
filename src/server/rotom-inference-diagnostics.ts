/** HTTP failure metadata only; never retain provider URLs, arbitrary headers, or body text. */
import { createHash } from "node:crypto";
import type { FetchFunction } from "@earendil-works/pi-ai";

export const INFERENCE_HTTP_FAILURE_ENTRY = "team-inference-http-failure-v1";

export type InferenceHttpFailure = {
    status: number;
    requestIds: Record<string, string>;
    requestBody: { bytes: number; sha256: string } | null;
};

/** Wrap the actual SSE fetch, including SDK non-2xx responses that skip onResponse. */
export function inferenceDiagnosticFetch(
    fetch: FetchFunction,
    record: (failure: InferenceHttpFailure) => void,
): FetchFunction {
    return async (input, init) => {
        const response = await fetch(input, init);

        if (response.status < 400) {
            return response;
        }

        const requestIds: Record<string, string> = {};

        for (const name of ["x-request-id", "request-id", "cf-ray"]) {
            const value = response.headers.get(name);

            if (value && /^[a-zA-Z0-9._:-]{1,128}$/.test(value)) {
                requestIds[name] = value;
            }
        }

        // Pinned OpenAI adapters send a string or Uint8Array (Codex may use zstd).
        // Do not consume Request/stream bodies; null explicitly means unmeasured.
        const body = init?.body;
        const requestBody =
            typeof body === "string" || body instanceof Uint8Array
                ? {
                      bytes: Buffer.byteLength(body),
                      sha256: createHash("sha256").update(body).digest("hex"),
                  }
                : null;

        try {
            record({ status: response.status, requestIds, requestBody });
        } catch {
            // A diagnostic write failure must not replace the provider's original HTTP error.
            console.error("[team-inference] Could not persist HTTP failure metadata");
        }

        return response;
    };
}
