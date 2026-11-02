import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
    inferenceDiagnosticFetch,
    type InferenceHttpFailure,
} from "../src/server/rotom-inference-diagnostics.ts";
import { stream } from "../runtime/rotom/node_modules/@bingjiang0611/rotom/runtime/pi/node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js";
import { normalizeContext } from "../runtime/rotom/node_modules/@bingjiang0611/rotom/runtime/pi/node_modules/@earendil-works/pi-ai/dist/index.js";
import type { Model } from "../runtime/rotom/node_modules/@bingjiang0611/rotom/runtime/pi/node_modules/@earendil-works/pi-ai/dist/types.d.ts";

const sha256 = (body: string | Uint8Array) => createHash("sha256").update(body).digest("hex");

test("HTTP failure records only bounded metadata and returns the unconsumed response", async () => {
    const body = JSON.stringify({ input: "PRIVATE_PROMPT_中文", token: "PRIVATE_BODY" });
    const init = { method: "POST", body, headers: { Authorization: "Bearer PRIVATE_AUTH" } };
    const response = new Response("PRIVATE_ERROR_BODY", {
        status: 400,
        headers: {
            "X-Request-Id": "req_123-abc",
            "Request-Id": "request:456",
            "CF-Ray": "123abc-SJC",
            "Set-Cookie": "PRIVATE_COOKIE",
            "X-Debug": "PRIVATE_DEBUG",
        },
    });
    const records: InferenceHttpFailure[] = [];
    let requests = 0;
    const fetch = inferenceDiagnosticFetch(
        async (input, options) => {
            requests++;
            assert.equal(input, "https://provider.invalid/private?token=PRIVATE_URL");
            assert.equal(options, init);

            return response;
        },
        (failure) => records.push(failure),
    );
    const result = await fetch("https://provider.invalid/private?token=PRIVATE_URL", init);

    assert.equal(requests, 1);
    assert.equal(result, response);
    assert.equal(response.bodyUsed, false);
    assert.deepEqual(records, [
        {
            status: 400,
            requestIds: {
                "x-request-id": "req_123-abc",
                "request-id": "request:456",
                "cf-ray": "123abc-SJC",
            },
            requestBody: { bytes: Buffer.byteLength(body), sha256: sha256(body) },
        },
    ]);
    assert.doesNotMatch(JSON.stringify(records), /PRIVATE_|provider\.invalid/);
    assert.equal(await result.text(), "PRIVATE_ERROR_BODY");
});

test("request IDs reject whitespace, URL/query content and overlong values", async () => {
    const records: InferenceHttpFailure[] = [];
    const fetch = inferenceDiagnosticFetch(
        async () =>
            new Response(null, {
                status: 503,
                headers: {
                    "x-request-id": "invalid id",
                    "request-id": "https://private.invalid/?secret=private",
                    "cf-ray": "x".repeat(129),
                },
            }),
        (failure) => records.push(failure),
    );

    await fetch("https://provider.invalid", { method: "POST", body: "test" });
    assert.deepEqual(records[0]!.requestIds, {});
});

test("successful responses do not produce records", async () => {
    const fetch = inferenceDiagnosticFetch(
        async () => new Response("ok"),
        () => {
            assert.fail("success must not write diagnostic entries");
        },
    );
    const response = await fetch("https://provider.invalid");

    assert.equal(await response.text(), "ok");
});

test("Request bodies are not consumed to measure them", async () => {
    const records: InferenceHttpFailure[] = [];
    const request = new Request("https://provider.invalid", { method: "POST", body: "private" });
    const fetch = inferenceDiagnosticFetch(
        async () => new Response(null, { status: 400 }),
        (failure) => records.push(failure),
    );

    await fetch(request);
    assert.equal(request.bodyUsed, false);
    assert.equal(records[0]!.requestBody, null);
});

test("network failures are propagated once without inventing HTTP metadata", async () => {
    const error = new Error("synthetic connection failure");
    let requests = 0;
    const fetch = inferenceDiagnosticFetch(
        async () => {
            requests++;

            throw error;
        },
        () => assert.fail("no HTTP response exists"),
    );

    await assert.rejects(fetch("https://provider.invalid"), (caught) => caught === error);
    assert.equal(requests, 1);
});

test("a failed diagnostic write cannot replace the provider response", async (t) => {
    const log = t.mock.method(console, "error", () => {});
    const response = new Response("original error", { status: 400 });
    const fetch = inferenceDiagnosticFetch(
        async () => response,
        () => {
            throw new Error("PRIVATE_DISK_ERROR");
        },
    );

    assert.equal(await fetch("https://provider.invalid"), response);
    assert.equal(response.bodyUsed, false);
    assert.deepEqual(
        log.mock.calls.map((call) => call.arguments),
        [["[team-inference] Could not persist HTTP failure metadata"]],
    );
});

test("pinned Codex SSE adapter records the actual request bytes and preserves Bad Request", async () => {
    const records: InferenceHttpFailure[] = [];
    let requests = 0;
    let expectedBody: { bytes: number; sha256: string };
    const model: Model<"openai-codex-responses"> = {
        id: "gpt-6-sol",
        name: "Synthetic Codex fixture",
        provider: "openai-codex",
        api: "openai-codex-responses",
        baseUrl: "https://provider.invalid",
        reasoning: true,
        input: ["text"],
        contextWindow: 272000,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const token = `synthetic.${Buffer.from(
        JSON.stringify({
            "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" },
        }),
    ).toString("base64")}.synthetic`;
    const result = await stream(
        model,
        normalizeContext({
            messages: [{ role: "user", content: "PRIVATE_SYNTHETIC_PROMPT", timestamp: 1 }],
        }),
        {
            apiKey: token,
            transport: "sse",
            fetch: inferenceDiagnosticFetch(
                async (_input, init) => {
                    requests++;
                    const body = init!.body;

                    assert.ok(typeof body === "string" || body instanceof Uint8Array);
                    expectedBody = { bytes: Buffer.byteLength(body), sha256: sha256(body) };

                    return new Response('{"detail":"Bad Request"}', {
                        status: 400,
                        headers: { "x-request-id": "synthetic-codex-400" },
                    });
                },
                (failure) => records.push(failure),
            ),
        },
    ).result();

    assert.equal(requests, 1, "diagnostics must not retry the rejected request");
    assert.equal(result.stopReason, "error");
    assert.equal(result.errorMessage, '{"detail":"Bad Request"}');
    assert.deepEqual(records, [
        {
            status: 400,
            requestIds: { "x-request-id": "synthetic-codex-400" },
            requestBody: expectedBody!,
        },
    ]);
    assert.doesNotMatch(JSON.stringify(records), /PRIVATE_|synthetic-account/);
});
