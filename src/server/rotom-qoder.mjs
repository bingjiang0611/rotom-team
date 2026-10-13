/** Access-only bridge into the pinned product's Qoder transport; never an Agent loop or refresh writer. */
import * as piAI from "../../runtime/rotom/node_modules/@bingjiang0611/rotom/runtime/pi/node_modules/@earendil-works/pi-ai/dist/compat.js";
import { clampMaxTokensToContext } from "../../runtime/rotom/node_modules/@bingjiang0611/rotom/runtime/pi/node_modules/@earendil-works/pi-ai/dist/api/simple-options.js";
import { createQoderProvider } from "../../vendor/qoder/provider.mjs";
import {
    CATALOG_TTL_MS,
    parseCatalogMetadata,
} from "../../runtime/rotom/node_modules/@bingjiang0611/rotom/extensions/qoder/catalog.mjs";

export async function qoderRequestProvider(auth, signal, onMetering) {
    const now = Date.now();

    if (
        !auth ||
        !Number.isSafeInteger(auth.credential?.expiresAt) ||
        auth.credential.expiresAt <= now ||
        auth.catalog?.scope !== auth.credential.fingerprint ||
        !Number.isSafeInteger(auth.catalog?.checkedAt) ||
        auth.catalog.checkedAt + CATALOG_TTL_MS <= now
    ) {
        throw new Error("team_qoder_request_scope_invalid");
    }

    parseCatalogMetadata(auth.catalog.metadata);
    // The factory's read-only branch accepts an injected credential reader. It never
    // reads CLI files here: this immutable access snapshot belongs to this one request.
    const provider = await createQoderProvider({
        piAI,
        clampMaxTokens: clampMaxTokensToContext,
        authMode: "qodercli",
        getCredential: async () => {
            if (auth.credential.expiresAt <= Date.now()) {
                throw new Error("team_qoder_access_expired");
            }

            return auth.credential;
        },
        onMetering,
    });

    await provider.refreshModels({
        signal: signal ?? new AbortController().signal,
        allowNetwork: false,
        stored: auth.catalog,
        publish: async ({ update }) => {
            update?.();

            return true;
        },
    });

    return provider;
}
