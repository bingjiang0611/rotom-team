import assert from "node:assert/strict";
import { test } from "node:test";
import type {
    OAuthCredential,
    ModelsStoreEntry,
    RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
    chatGPTPayload,
    chatGPTProvider,
    parseChatGPTCatalog,
} from "../src/server/openai-chatgpt.ts";
const row = (slug: string) => ({
    slug,
    display_name: slug,
    visibility: "list",
    context_window: 272000,
    input_modalities: ["text", "image"],
    supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "ultra" }],
});
const credential = (clientId: string): OAuthCredential => ({
    type: "oauth",
    clientId,
    access: "fake-access",
    refresh: "fake-refresh",
    expires: Date.now() + 3_600_000,
});

test("ChatGPT uses visible account slugs in server order and only native-supported reasoning levels", () => {
    const models = parseChatGPTCatalog({
        models: [row("z-first"), { ...row("hidden"), visibility: "hidden" }, row("a-second")],
    });

    assert.deepEqual(
        models.map((model) => model.id),
        ["z-first", "a-second"],
    );
    assert.deepEqual(getSupportedThinkingLevels(models[0]!), ["low", "medium"]);
    assert.equal(models[0]!.api, "openai-responses");
    assert.equal(models[0]!.baseUrl, "https://api.openai.com/v1");
    assert.throws(() => parseChatGPTCatalog({ data: [] }), /catalog shape/);
    assert.throws(() => parseChatGPTCatalog(null), /catalog shape/);
    assert.throws(
        () => parseChatGPTCatalog({ models: [row("duplicate"), row("duplicate")] }),
        /Duplicate/,
    );
    assert.throws(
        () => parseChatGPTCatalog({ models: [{ ...row("bad"), context_window: "272000" }] }),
        /model metadata/,
    );
});

test("account scope, failed refresh and offline restore never expose the static API-key catalog to OAuth", async () => {
    let requests = 0,
        fail = false;
    const provider = chatGPTProvider(async () => {
        requests++;

        return fail
            ? new Response("", { status: 503 })
            : Response.json({ models: [row("account-only")] });
    });
    let saved: ModelsStoreEntry | undefined;
    const context = (clientId: string, allowNetwork: boolean): RefreshModelsContext => ({
        credential: credential(clientId),
        stored: saved,
        allowNetwork,
        signal: new AbortController().signal,
        async publish(publication) {
            if (publication.persist) {
                saved = structuredClone(publication.persist);
            }

            publication.update?.();

            return true;
        },
    });

    assert.deepEqual(provider.filterModels!(provider.getModels(), credential("client-a")), []);
    await provider.refreshModels!(context("client-a", true));
    assert.equal(requests, 1);
    assert.deepEqual(
        provider.filterModels!(provider.getModels(), credential("client-a")).map(
            (model) => model.id,
        ),
        ["account-only"],
    );
    assert.deepEqual(provider.filterModels!(provider.getModels(), credential("client-b")), []);
    assert.deepEqual(
        provider.filterModels!(provider.getModels(), {
            ...credential("client-a"),
            refresh: "another-account-grant",
        }),
        [],
        "Reusing a client registration must not restore another grant's catalog",
    );
    fail = true;
    await assert.rejects(provider.refreshModels!(context("client-b", true)), /HTTP 503/);
    assert.deepEqual(provider.filterModels!(provider.getModels(), credential("client-b")), []);
    const restored = chatGPTProvider(async () => {
        throw new Error("Offline restore must not fetch");
    });

    await restored.refreshModels!(context("client-a", false));
    assert.deepEqual(
        restored.filterModels!(restored.getModels(), credential("client-a")).map(
            (model) => model.id,
        ),
        ["account-only"],
    );
    await restored.refreshModels!({
        ...context("client-a", false),
        credential: { type: "api_key", key: "sk-fake" },
    });
    assert.ok(
        restored.filterModels!(restored.getModels(), { type: "api_key", key: "sk-fake" }).some(
            (model) => model.id === "gpt-4",
        ),
    );
});

test("SIWC groups native function tools without losing schemas and declines unsupported hosted tools", () => {
    const fn = {
        type: "function",
        name: "read",
        parameters: { type: "object", properties: { path: { type: "string" } } },
    };
    const payload = { store: false, stream: true, input: [], tools: [fn] };

    assert.deepEqual(chatGPTPayload(payload), {
        ...payload,
        tools: [
            {
                type: "namespace",
                name: "functions",
                description: "Local tools executed by the self-hosted app.",
                tools: [fn],
            },
        ],
    });
    assert.deepEqual(payload.tools, [fn], "Do not mutate the native request");
    const existing = {
        type: "namespace",
        name: "functions",
        tools: [{ type: "function", name: "other" }],
    };
    const merged = chatGPTPayload({ tools: [existing, fn] }) as { tools: { tools: unknown[] }[] };

    assert.equal(merged.tools.length, 1);
    assert.equal(merged.tools[0]!.tools.length, 2);
    assert.throws(() => chatGPTPayload({ tools: [{ type: "tool_search" }] }), /does not support/);
});
