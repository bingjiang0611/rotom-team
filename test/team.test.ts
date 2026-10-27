import { after, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { statSync, readFileSync, mkdirSync, realpathSync } from "node:fs";
import {
    cleanUp,
    context,
    root,
    work,
    owner,
    scriptedModel,
    lastText,
    until,
    fakeTab,
    seedHistoricalSession,
    appendHistoricalTurn,
    recordCost,
} from "./helpers.ts";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { normalizeContext } from "@earendil-works/pi-ai";
import { PocketApp } from "../src/server/app.ts";
import { TeamRunDoc } from "../src/server/team-execution.ts";
import { accountContext } from "../src/server/team-accounts.ts";
import { FileCredentials } from "../src/server/credential-store.ts";
import { AuthorsDoc, SubagentsDoc } from "../src/server/docs.ts";
import { AgentDoc, ProviderDoc } from "@earendil-works/pi-durable";
import { NOTE_ENTRY } from "../src/server/entry-format.ts";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { seedLegacySession } from "./fixtures/legacy-session.ts";

after(cleanUp);

async function team(folder: string) {
    const calls: { user: string; text: string; history: string; session?: string }[] = [];
    const app = await PocketApp.open({
        dataDir: join(root, folder),
        defaultCwd: work,
        supervised: false,
        log: () => {},
        browser: null,
        configureUserModels(models, user) {
            let session: string | undefined;
            const mock = scriptedModel((input) => {
                calls.push({
                    user: user.id,
                    text: lastText(input).text,
                    history: JSON.stringify(input.messages),
                    session,
                });

                return fauxAssistantMessage([fauxText(`response for ${user.id}`)]);
            });

            models.registerNativeProvider({
                ...mock.provider,
                streamSimple(model, input, options) {
                    session = options?.sessionId;

                    return mock.provider.streamSimple(model, input, options);
                },
            });
        },
    });

    return { app, calls };
}

test("personal model visibility and shared historical reads survive restart without legacy dispatch", async () => {
    let { app, calls } = await team("team-shared");

    try {
        const a = owner(app);
        const b = app.config.addUser("Bob", "guest").user;

        await app.hello(b);
        const id = await seedHistoricalSession(app);

        await appendHistoricalTurn(app, id, "first task", "stored historical reply");
        const available = app.accounts.available(a)[0]!;
        const ref = { provider: available.provider, modelId: available.id };

        assert.ok(ref.provider.startsWith(`team:${a.id}:`));
        assert.ok(!app.accounts.available(b).some((model) => model.provider === ref.provider));
        assert.throws(() => app.accounts.assertModel(b, ref), /own connected accounts/);
        app.accounts.assertModel(a, ref);
        const exported = await app.transcripts.exportMarkdown(id, a);

        assert.equal((await app.transcripts.exportMarkdown(id, b)).markdown, exported.markdown);

        for (const user of [a, b]) {
            await assert.rejects(
                app.commands.submit(id, user, { text: "continue", requestId: user.id }),
                /read-only archive/,
            );
        }

        assert.equal(calls.length, 0);
        await app.close();
        ({ app, calls } = await team("team-shared"));
        assert.equal(
            (await app.transcripts.exportMarkdown(id, app.config.userById(b.id)!)).markdown,
            exported.markdown,
        );
        await assert.rejects(
            app.commands.submit(id, app.config.userById(b.id)!, {
                text: "after restart",
                requestId: "restart",
            }),
            /read-only archive/,
        );
        assert.equal(calls.length, 0);
        // Actual native payer handoff/fork/restart is separately proved by team-kernel-proof.ts.
    } finally {
        await app.close();
    }
});

test("personal refresh checks Qoder's account catalog, not only its offline baseline", async () => {
    let networkCatalogChecks = 0;
    const app = await PocketApp.open({
        dataDir: join(root, "qoder-catalog-refresh"),
        defaultCwd: work,
        supervised: false,
        browser: null,
        log: () => {},
        configureUserModels(models) {
            models.registerNativeProvider({
                ...models.getProvider("qoder")!,
                auth: {
                    apiKey: {
                        name: "fixture",
                        resolve: async () => ({ auth: { apiKey: "fixture-only" }, source: "test" }),
                    },
                },
                async refreshModels(context) {
                    if (context.allowNetwork) {
                        networkCatalogChecks++;
                    }
                },
            });
        },
    });

    try {
        const before = networkCatalogChecks;

        await app.accounts.refresh(owner(app));
        assert.equal(networkCatalogChecks, before + 1);
    } finally {
        await app.close();
    }
});

test("missing personal credentials never inherit the owner's or ambient OpenAI key", async () => {
    const previous = process.env.OPENAI_API_KEY;

    process.env.OPENAI_API_KEY = "not-a-real-key";
    const data = join(realpathSync(root), "no-account");

    mkdirSync(data, { mode: 0o700 });
    const app = await PocketApp.open({
        dataDir: data,
        defaultCwd: realpathSync(work),
        supervised: false,
        kernel: true,
        browser: null,
        log: () => {},
    });

    try {
        const a = owner(app);

        assert.equal(app.accounts.available(a).length, 0);
        const before = (await app.sessions()).length;

        await assert.rejects(
            app.commands.createSession(a, { backend: "rotom" }),
            /Connect and select your own model account/,
        );
        assert.equal((await app.sessions()).length, before);
        assert.equal(statSync(join(app.dataDir, "people", a.id)).mode & 0o777, 0o700);
        assert.equal(
            statSync(join(app.dataDir, "people", a.id, "profile.json")).mode & 0o777,
            0o600,
        );
    } finally {
        await app.close();

        if (previous === undefined) {
            delete process.env.OPENAI_API_KEY;
        } else {
            process.env.OPENAI_API_KEY = previous;
        }
    }
});

test("account projection preserves own signatures and never sends foreign opaque state", () => {
    const message = fauxAssistantMessage([
        { type: "thinking", thinking: "secret", thinkingSignature: "opaque" },
        { type: "text", text: "public", textSignature: "signed" },
    ]);

    message.provider = "team:alice:v1:qoder";
    message.responseId = "private-id";
    const input = normalizeContext({ messages: [message] });
    const own = accountContext(input, message.provider, "qoder").messages[0]!;

    assert.equal(own.role === "assistant" && own.provider, "qoder");
    assert.match(JSON.stringify(own), /opaque/);
    const foreign = accountContext(input, "team:bob:v1:qoder", "qoder").messages[0]!;

    assert.match(JSON.stringify(foreign), /public/);
    assert.doesNotMatch(JSON.stringify(foreign), /opaque|private-id|secret|signed/);
    assert.equal(message.responseId, "private-id");
});

test("credential mutations serialize and persist privately, without changing another account", async () => {
    const a = new FileCredentials(join(root, "credential-a.json"));
    const b = new FileCredentials(join(root, "credential-b.json"));

    await a.modify("test", async () => ({
        type: "oauth",
        access: "fixture",
        refresh: "0",
        expires: 0,
    }));
    await Promise.all(
        Array.from({ length: 4 }, () =>
            a.modify("test", async (current) => ({
                ...current!,
                type: "oauth",
                access: "fixture",
                refresh: String(Number((current as { refresh: string }).refresh) + 1),
                expires: 0,
            })),
        ),
    );
    assert.equal(((await a.read("test")) as { refresh: string }).refresh, "4");
    assert.equal(await b.read("test"), undefined);
    assert.equal(statSync(join(root, "credential-a.json")).mode & 0o777, 0o600);
    assert.equal(
        JSON.parse(readFileSync(join(root, "credential-a.json"), "utf8")).test.refresh,
        "4",
    );
});

test("cancellation while a credential mutation is queued never persists cancelled credentials", async () => {
    const store = new FileCredentials(join(root, "cancel-credential.json"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const first = store.modify("provider", async () => {
        await gate;

        return { type: "api_key", key: "original-fixture" };
    });
    const abort = new AbortController();
    let ran = false;
    const cancelled = store.modify(
        "provider",
        async () => {
            ran = true;

            return { type: "api_key", key: "cancelled-fixture" };
        },
        { signal: abort.signal },
    );

    abort.abort();
    release();
    await first;
    await assert.rejects(cancelled, /abort/i);
    assert.equal(ran, false);
    assert.deepEqual(await store.read("provider"), { type: "api_key", key: "original-fixture" });
});

test("failed login reconciles routes, and a viewer or changing member cannot break other catalogs", async () => {
    let { app } = await team("catalogs");

    try {
        const a = owner(app);
        const b = app.config.addUser("Bob", "guest").user;

        await app.hello(b);
        const { runtime } = await app.accounts.forUser(b);
        const login = runtime.login;
        const tab = fakeTab(undefined, b);

        await app.attach(tab.client);

        runtime.login = async () => {
            throw new Error("fixture cancellation");
        };

        const old = app.accounts.choice(b)!;
        const flow = await app.providers.startLogin(b, "faux", "api_key");

        await app.accounts.refresh(a);
        assert.ok(app.accounts.available(a).length > 0);
        await until(
            () =>
                tab.events.some(
                    (event) =>
                        event.event === "auth" &&
                        event.data.flowId === flow &&
                        event.data.step === "done",
                ),
            "failed login completion",
        );
        const fresh = app.accounts.choice(b)!;

        assert.notEqual(old.provider, fresh.provider);
        app.accounts.assertModel(b, fresh);
        await assert.rejects(
            async () => app.accounts.assertModel(b, old),
            /own connected accounts/,
        );
        runtime.login = login;
        app.detach(tab.client);
        app.config.updateUser(b.id, { role: "viewer" });
        await app.accounts.refresh(a);
        assert.ok(app.accounts.available(a).length > 0);
        assert.equal(app.accounts.available(b).length, 0);
        await app.close();
        ({ app } = await team("catalogs"));
        assert.ok(app.accounts.available(owner(app)).length > 0);
    } finally {
        await app.close();
    }
});

test("archived handoff provenance, note authorship and payer accounting remain independent", async () => {
    let { app, calls } = await team("dedup");

    try {
        const a = owner(app);
        const b = app.config.addUser("Bob", "guest").user;

        await app.hello(b);
        const id = await seedHistoricalSession(app);

        await app.harness.commit(async (tx) => {
            (await tx.doc(TeamRunDoc, id)).owner = b.id;
            const entry = await tx.appendEntry(id, {
                kind: NOTE_ENTRY,
                data: { text: "historical note is not a payer change", by: a.id, name: a.name },
                model: [{ role: "user", content: "historical note", timestamp: Date.now() }],
            });
            const authors = await tx.doc(AuthorsDoc, id);

            authors.requesters = { ...authors.requesters, [String(entry.id)]: a.id };
        }, context);
        await app.close();
        ({ app, calls } = await team("dedup"));
        const before = await app.harness.snapshot(TeamRunDoc, id, context);

        for (const user of [a, b, a]) {
            await assert.rejects(
                app.commands.submit(id, user, { text: "retry", requestId: "same-request" }),
                /read-only archive/,
            );
        }

        assert.deepEqual(await app.harness.snapshot(TeamRunDoc, id, context), before);
        assert.equal(calls.length, 0);
        await recordCost(app, id, 3);
        await until(
            () => app.spend.personSpent(b.id) === 3,
            "historical execution-based attribution",
        );
        assert.equal(app.spend.personSpent(a.id), 0);
        assert.equal(app.attribution.requesterOf(id), a.id);
        assert.equal(app.execution.owner(id), b.id);
        // Native receipt dedupe, payer handoff and compaction are exercised by team-kernel-proof.ts:1020–1131.
        // Private thinking/signature stripping remains independently tested in accountContext and team-durability.
    } finally {
        await app.close();
    }
});

test("no member can turn an archive into a live execution or change its configuration", async () => {
    const { app, calls } = await team("busy");

    try {
        const a = owner(app);
        const b = app.config.addUser("Bob", "guest").user;

        await app.hello(b);
        const id = await seedHistoricalSession(app);
        const before = await app.harness.snapshot(AgentDoc, id, context);

        for (const user of [a, b]) {
            await assert.rejects(
                app.commands.submit(id, user, { text: "steer", requestId: user.id, mode: "steer" }),
                /read-only archive/,
            );
            await assert.rejects(
                app.commands.configure(id, user, { model: app.accounts.choice(user) }),
                /read-only archive/,
            );
        }

        assert.equal(app.isBusy(id), false);
        assert.equal(calls.length, 0);
        assert.deepEqual(await app.harness.snapshot(AgentDoc, id, context), before);
        // Native live exclusion/account-generation fencing remains in the actual kernel proof, not this archive test.
    } finally {
        await app.close();
    }
});

test("historical owned children remain readable but cannot resume under either member", async () => {
    const data = join(root, "subagent-identity");

    mkdirSync(data);
    const storage = await openNodeSqliteStorage(join(data, "pocket.sqlite"));
    let fixture;

    try {
        fixture = await seedLegacySession(storage, work);
    } finally {
        await storage.close(context);
    }

    const { app, calls } = await team("subagent-identity");

    try {
        const a = owner(app);
        const b = app.config.addUser("Bob", "guest").user;

        await app.hello(b);
        const rootId = fixture.conversationId;
        const child = fixture.childConversationId;

        assert.equal(app.rootOf(child), rootId);
        assert.equal(
            (await app.harness.snapshot(SubagentsDoc, rootId, context))?.agents.helper
                ?.conversationId,
            child,
        );
        const before = await (await app.conversation(child)).entries({}, 100, undefined, context);

        for (const user of [a, b]) {
            await assert.rejects(
                app.commands.submit(child, user, { text: "reuse helper", requestId: user.id }),
                /read-only archive/,
            );
        }

        assert.deepEqual(
            await (await app.conversation(child)).entries({}, 100, undefined, context),
            before,
        );
        assert.equal(calls.length, 0);
        assert.equal(app.isBusy(rootId), false);
        assert.equal(app.isBusy(child), false);
        // Native child gate expiry and stop/join are separately tested by the real kernel proof.
    } finally {
        await app.close();
    }
});

test("dispatch rejects unknown and archived identities; model ownership is checked independently", async () => {
    const { app, calls } = await team("dispatch-gate");

    try {
        const a = owner(app);
        const b = app.config.addUser("Bob", "guest").user;

        await app.hello(b);
        const id = await seedHistoricalSession(app);
        const aRef = app.accounts.choice(a)!;
        const bRef = app.accounts.choice(b)!;

        await app.harness.commit(async (tx) => {
            (await tx.doc(ProviderDoc, id)).sessionId = "historical-provider-session";
            (await tx.doc(AgentDoc, id)).model = aRef;
            (await tx.doc(TeamRunDoc, id)).owner = a.id;
        }, context);
        assert.throws(() => app.accounts.assertModel(a, bRef), /own connected accounts/);
        const model = app.models.getModel(bRef.provider, bRef.modelId)!;

        for (const sessionId of ["unrecognized-session", "historical-provider-session"]) {
            const result = await app.models.completeSimple(
                model,
                { messages: [{ role: "user", content: "wrong routing", timestamp: Date.now() }] },
                { sessionId },
            );

            assert.equal(result.stopReason, "error");
        }

        assert.equal(calls.length, 0);
    } finally {
        await app.close();
    }
});
