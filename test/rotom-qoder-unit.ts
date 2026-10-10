import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { root, work, owner, cleanUp } from "./helpers.ts";
import { PocketApp } from "../src/server/app.ts";
import { normalizeContext } from "@earendil-works/pi-ai";
import { qoderRequestProvider } from "../src/server/rotom-qoder.mjs";
import type { QoderRequestAuth } from "../src/server/rotom-executions.ts";

after(cleanUp);

function requestAuth(): QoderRequestAuth {
    return {
        credential: {
            accessToken: "synthetic-access-only",
            expiresAt: Date.now() + 60_000,
            fingerprint: "a".repeat(64),
            uid: "fixture-user",
            org: "",
            machineId: "00000000-0000-4000-8000-000000000001",
        },
        catalog: {
            scope: "a".repeat(64),
            checkedAt: Date.now(),
            metadata: {
                version: 1,
                assistant: [
                    {
                        source: "system",
                        key: "performance",
                        display_name: "Fixture",
                        enable: true,
                        format: "openai",
                        max_input_tokens: 32000,
                    },
                ],
            },
        },
    };
}

const sse = (usage: object = {}) =>
    new Response(
        [
            {
                id: "fixture",
                choices: [
                    {
                        index: 0,
                        delta: { role: "assistant", content: "QODER_NATIVE_FIXTURE" },
                        finish_reason: null,
                    },
                ],
            },
            {
                id: "fixture",
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5, ...usage },
            },
        ]
            .map((value) => `data: ${JSON.stringify(value)}\n\n`)
            .join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
    );

test("native Qoder uses a per-request access snapshot and pinned transport without a refresh grant", async (t) => {
    let calls = 0;
    const observations: Record<string, unknown>[] = [];

    t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
        calls++;
        assert.equal(url, "https://api2-v2.qoder.sh/model/v1/chat/completions");
        assert.equal(
            new Headers(options.headers).get("authorization"),
            "Bearer synthetic-access-only",
        );
        assert.ok(!String(options.body).includes("synthetic-access-only"));

        return sse({ credits: 0.125, billable: true });
    });
    const auth = requestAuth();
    const provider = await qoderRequestProvider(auth, undefined, (data: Record<string, unknown>) =>
        observations.push(data),
    );
    const model = provider.getModels().find((value: { id: string }) => value.id === "performance");

    assert.ok(model);
    const result = await provider
        .streamSimple(
            model,
            normalizeContext({
                messages: [
                    {
                        role: "user",
                        content: [{ type: "text", text: "Say the marker" }],
                        timestamp: Date.now(),
                    },
                ],
            }),
        )
        .result();

    assert.equal(result.stopReason, "stop", result.errorMessage ?? "");
    assert.equal(result.content[0]?.type, "text");
    assert.ok(
        result.content.some(
            (block) => block.type === "text" && block.text === "QODER_NATIVE_FIXTURE",
        ),
    );
    assert.equal(calls, 1);
    assert.equal(observations.length, 1);
    assert.equal(observations[0]?.status, "reported");
    assert.equal(observations[0]?.credits, 0.125);
    assert.ok(!JSON.stringify({ result, observations }).includes(auth.credential.accessToken));
    assert.equal("refresh" in auth.credential, false);
});

test("native Qoder declines expired, foreign and invalid catalogs before network", async (t) => {
    t.mock.method(globalThis, "fetch", () => {
        throw new Error("Unexpected network");
    });
    const expired = requestAuth();

    expired.credential.expiresAt = Date.now() - 1;
    await assert.rejects(qoderRequestProvider(expired), /scope_invalid/);
    const foreign = requestAuth();

    foreign.catalog.scope = "b".repeat(64);
    await assert.rejects(qoderRequestProvider(foreign), /scope_invalid/);
    const stale = requestAuth();

    stale.catalog.checkedAt = Date.now() - 3_600_001;
    await assert.rejects(qoderRequestProvider(stale), /scope_invalid/);
    const invalid = requestAuth();

    invalid.catalog.metadata = {};
    await assert.rejects(qoderRequestProvider(invalid), /catalog_invalid/);
});

test("native Qoder errors never retry and absent metering stays unknown", async (t) => {
    let calls = 0;
    let fail = true;
    const observations: Record<string, unknown>[] = [];

    t.mock.method(globalThis, "fetch", async () => {
        calls++;

        return fail ? new Response("unavailable", { status: 503 }) : sse();
    });
    const provider = await qoderRequestProvider(
        requestAuth(),
        undefined,
        (data: Record<string, unknown>) => observations.push(data),
    );
    const model = provider.getModels()[0];

    assert.ok(model);
    const context = normalizeContext({
        messages: [
            { role: "user", content: [{ type: "text", text: "test" }], timestamp: Date.now() },
        ],
    });
    const failed = await provider.streamSimple(model, context).result();

    assert.equal(failed.stopReason, "error");
    assert.equal(calls, 1);
    fail = false;
    const success = await provider.streamSimple(model, context).result();

    assert.equal(success.stopReason, "stop", success.errorMessage ?? "");
    assert.equal(calls, 2);
    assert.ok(
        observations.length === 2 && observations.every((value) => value.status === "unknown"),
    );
});

test("team broker exports only refreshed-account access fields and the bound catalog", async (t) => {
    let catalogCalls = 0;
    let refreshCalls = 0;
    const auth = requestAuth();
    // Startup installs Pi's HTTP dispatcher. Mock only after that initialization,
    // then rebuild Qoder so its OAuth closure captures this fixture transport.
    const app = await PocketApp.open({
        dataDir: join(root, "qoder-broker"),
        defaultCwd: work,
        supervised: false,
        browser: null,
        log: () => {},
    });

    const fakeFetch = t.mock.method(
        globalThis,
        "fetch",
        async (url: string, options: RequestInit) => {
            if (url === "https://openapi.qoder.sh/api/v1/deviceToken/refresh") {
                refreshCalls++;
                assert.equal(
                    JSON.parse(String(options.body)).refresh_token,
                    "synthetic-refresh-not-exportable",
                );

                return Response.json({
                    token: "rotated-access-only",
                    refresh_token: "rotated-refresh-not-exportable",
                    expires_in: 7200,
                    refresh_token_expires_in: 86400,
                });
            }

            if (url === "https://openapi.qoder.sh/api/v1/userinfo") {
                return Response.json({ uid: auth.credential.uid, orgId: auth.credential.org });
            }

            assert.equal(url, "https://api2.qoder.sh/algo/api/v2/model/list?Encode=1");
            catalogCalls++;

            return Response.json(auth.catalog.metadata);
        },
    );

    try {
        assert.equal(globalThis.fetch, fakeFetch);
        const user = owner(app);
        const account = await app.accounts.forUser(user);
        const fingerprint = createHmac("sha256", auth.credential.machineId)
            .update(
                JSON.stringify([
                    "rotom-qoder-browser-v1",
                    auth.credential.uid,
                    auth.credential.org,
                ]),
            )
            .digest("hex");

        await account.credentials.modify("qoder", async () => ({
            type: "oauth",
            qoderAuthVersion: 1,
            access: auth.credential.accessToken,
            refresh: "synthetic-refresh-not-exportable",
            expires: Date.now() - 1,
            refreshExpires: Date.now() + 600_000,
            fingerprint,
            uid: auth.credential.uid,
            org: auth.credential.org,
            machineId: auth.credential.machineId,
        }));
        assert.equal(typeof account.runtime.getProvider("qoder")?.refreshModels, "function");
        assert.equal((await account.credentials.read("qoder"))?.type, "oauth");
        await app.accounts.refresh(user, "qoder");
        assert.equal(refreshCalls, 1);
        const rotated = await account.credentials.read("qoder");

        assert.ok(rotated?.type === "oauth");
        assert.equal(rotated.access, "rotated-access-only");
        const model = app.accounts.available(user).find((entry) => entry.id === "performance");

        assert.ok(model);
        const ref = { provider: model.provider, modelId: model.id };
        const request = await app.accounts.kernelAuth(user, ref);

        assert.ok(request.qoder);
        assert.equal(request.qoder.credential.accessToken, "rotated-access-only");
        assert.equal(request.qoder.catalog.scope, fingerprint);
        assert.equal(
            request.apiKey,
            undefined,
            "the parent process-local envelope is not transferable",
        );
        assert.ok(!JSON.stringify(request).includes("refresh-not-exportable"));
        assert.equal(refreshCalls, 1);
        assert.equal(rotated.refresh, "rotated-refresh-not-exportable");
        assert.ok(catalogCalls > 0);
        const provider = await qoderRequestProvider(request.qoder);

        assert.equal(provider.getModels()[0]?.id, "performance");
        const stored = await account.modelsStore.read("qoder");

        assert.ok(stored);
        await account.modelsStore.write("qoder", { ...stored, ...{ scope: "b".repeat(64) } });
        await assert.rejects(app.accounts.kernelAuth(user, ref), /identity is unavailable/);
    } finally {
        await app.close();
    }
});
