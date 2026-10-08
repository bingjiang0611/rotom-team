import { after, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { statSync, readFileSync } from "node:fs";
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
    recordCost,
} from "./helpers.ts";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { normalizeContext } from "@earendil-works/pi-ai";
import { PocketApp } from "../src/server/app.ts";
import { TeamRunDoc } from "../src/server/team-execution.ts";
import { accountContext } from "../src/server/team-accounts.ts";
import { FileCredentials } from "../src/server/credential-store.ts";
import { SubagentsDoc } from "../src/server/docs.ts";
import { ProviderDoc } from "@earendil-works/pi-durable";

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

test("two personal accounts: same shared history, own model/quota route, fork and restart", async () => {
    let { app, calls } = await team("team-shared");

    try {
        const a = owner(app);
        const b = app.config.addUser("Bob", "guest").user;

        await app.hello(b);
        const { id } = await app.commands.createSession(a, { title: "shared task" });

        const submit = async (user: typeof a, text: string) => {
            const result = await app.commands.submit(id, user, {
                text,
                requestId: crypto.randomUUID(),
            });
            const settled = await (await app.harness.submission(
                result.submissionId,
                context,
            ))!.wait(context);

            assert.equal(settled.status, "done", JSON.stringify(settled));
        };

        await submit(a, "first task");
        const aModel = (await app.agentState(id))!.model!;

        assert.ok(aModel.provider.startsWith(`team:${a.id}:`));
        assert.ok(!app.accounts.available(b).some((model) => model.provider === aModel.provider));
        await assert.rejects(
            app.commands.configure(id, b, { model: aModel }),
            /own connected accounts/,
        );
        await submit(b, "continue from Alice");
        assert.equal(calls.at(-1)!.user, b.id);
        assert.match(calls.at(-1)!.history, /first task/);
        assert.notEqual(calls[0]!.session, calls.at(-1)!.session);
        assert.equal((await app.harness.snapshot(TeamRunDoc, id, context))!.owner, b.id);
        const latest = (
            await (await app.conversation(id)).entries({}, 100, undefined, context)
        ).items.find((e) => e.kind === "pi.assistant")!;
        const fork = await app.commands.fork(id, a, { entryId: Number(latest.id) });

        assert.ok((await app.agentState(fork.id))!.model!.provider.startsWith(`team:${a.id}:`));
        await app.close();
        ({ app, calls } = await team("team-shared"));
        const again = await app.commands.submit(id, app.config.userById(b.id)!, {
            text: "after restart",
            requestId: crypto.randomUUID(),
        });

        assert.equal(
            (await (await app.harness.submission(again.submissionId, context))!.wait(context))
                .status,
            "done",
        );
        assert.equal(calls.at(-1)!.user, b.id);
    } finally {
        await app.close();
    }
});

test("missing personal credentials never inherit the owner's or ambient OpenAI key", async () => {
    const previous = process.env.OPENAI_API_KEY;

    process.env.OPENAI_API_KEY = "not-a-real-key";
    const app = await PocketApp.open({
        dataDir: join(root, "no-account"),
        defaultCwd: work,
        supervised: false,
        browser: null,
        log: () => {},
    });

    try {
        const a = owner(app);
        const { id } = await app.commands.createSession(a, {});

        assert.equal(app.accounts.available(a).length, 0);
        await assert.rejects(
            app.commands.submit(id, a, { text: "hello", requestId: "no-creds" }),
            /Connect your own/,
        );
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

test("retry after another person's handoff returns the original receipt without rebinding or charging", async () => {
    const { app, calls } = await team("dedup");

    try {
        const a = owner(app);
        const b = app.config.addUser("Bob", "guest").user;

        await app.hello(b);
        const { id } = await app.commands.createSession(a, { title: "dedup" });
        const request = { text: "first", requestId: "same-request" };
        const first = await app.commands.submit(id, a, request);

        await (await app.harness.submission(first.submissionId, context))!.wait(context);
        const second = await app.commands.submit(id, b, { text: "take over", requestId: "b" });

        await (await app.harness.submission(second.submissionId, context))!.wait(context);
        const count = calls.length;

        assert.deepEqual(await app.commands.submit(id, a, request), first);
        assert.equal(calls.length, count);
        assert.equal((await app.harness.snapshot(TeamRunDoc, id, context))!.owner, b.id);
        await app.commands.note(id, a, "a note is not a payer change");
        await recordCost(app, id, 3);
        await until(() => app.spend.personSpent(b.id) === 3, "execution-based attribution");
        assert.equal(app.spend.personSpent(a.id), 0);
        const before = calls.length;

        app.settings.getCompactionSettings = () => ({
            enabled: true,
            reserveTokens: 1024,
            keepRecentTokens: 1,
        });
        const tab = fakeTab(id, b);

        await app.attach(tab.client);
        await app.commands.compact(id, b, undefined);
        await app.harness.waitForIdle(context);
        assert.equal(
            calls.length,
            before,
            "cross-account compaction must decline before serializing foreign thinking",
        );
        assert.ok(
            tab.events.some(
                (event) =>
                    event.event === "notice" &&
                    String(event.data.message).includes("Cross-account compaction"),
            ),
            "the selected compaction range actually reached the boundary check",
        );
        app.detach(tab.client);
    } finally {
        await app.close();
    }
});

test("another member cannot steer or change a live execution, and account changes wait", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const app = await PocketApp.open({
        dataDir: join(root, "busy"),
        defaultCwd: work,
        supervised: false,
        browser: null,
        log: () => {},
        configureUserModels(models) {
            models.registerNativeProvider(
                scriptedModel(async () => {
                    await gate;

                    return fauxAssistantMessage([fauxText("done")]);
                }).provider,
            );
        },
    });

    try {
        const a = owner(app);
        const b = app.config.addUser("Bob", "guest").user;

        await app.hello(b);
        const { id } = await app.commands.createSession(a, { title: "busy" });
        const started = await app.commands.submit(id, a, { text: "work", requestId: "a" });

        await until(() => app.isBusy(id), "busy execution");
        await assert.rejects(
            app.commands.submit(id, b, { text: "steal", requestId: "b", mode: "steer" }),
            /Another member/,
        );
        await assert.rejects(
            app.commands.configure(id, b, { model: app.accounts.choice(b) }),
            /still active/,
        );
        await assert.rejects(app.providers.startLogin(a, "openai", "oauth"), /still active/);
        release();
        assert.equal(
            (await (await app.harness.submission(started.submissionId, context))!.wait(context))
                .status,
            "done",
        );
    } finally {
        release();
        await app.close();
    }
});

test("persistent subagents cannot spend a prior owner's account after takeover", async () => {
    const calls: string[] = [];
    const app = await PocketApp.open({
        dataDir: join(root, "subagent-identity"),
        defaultCwd: work,
        supervised: false,
        browser: null,
        log: () => {},
        configureUserModels(models, user) {
            models.registerNativeProvider(
                scriptedModel((input) => {
                    calls.push(user.id);
                    const last = lastText(input);

                    if (last.role === "user" && last.text.includes("spawn-helper")) {
                        return fauxAssistantMessage(
                            [
                                fauxToolCall("subagent", {
                                    action: "spawn",
                                    name: "helper",
                                    message: "child task",
                                }),
                            ],
                            { stopReason: "toolUse" },
                        );
                    }

                    if (last.role === "user" && last.text.includes("reuse-helper")) {
                        return fauxAssistantMessage(
                            [
                                fauxToolCall("subagent", {
                                    action: "send",
                                    name: "helper",
                                    message: "new child task",
                                }),
                            ],
                            { stopReason: "toolUse" },
                        );
                    }

                    return fauxAssistantMessage([fauxText("done")]);
                }).provider,
            );
        },
    });

    try {
        const a = owner(app);
        const b = app.config.addUser("Bob", "guest").user;

        await app.hello(b);
        const { id } = await app.commands.createSession(a, { title: "child test" });
        const first = await app.commands.submit(id, a, {
            text: "spawn-helper",
            requestId: "spawn",
        });

        await (await app.harness.submission(first.submissionId, context))!.wait(context);
        await app.harness.waitForIdle(context);
        const child = (await app.harness.snapshot(SubagentsDoc, id, context))!.agents.helper!
            .conversationId;

        assert.equal(app.rootOf(child), id);
        const before = calls.filter((user) => user === a.id).length;

        const next = await app.commands.submit(id, b, { text: "reuse-helper", requestId: "send" });

        await (await app.harness.submission(next.submissionId, context))!.wait(context);
        await app.harness.waitForIdle(context);
        assert.equal(calls.filter((user) => user === a.id).length, before);
        assert.ok(calls.includes(b.id));
    } finally {
        await app.close();
    }
});

test("dispatch rejects unknown durable identities and model-owner mismatches without invoking a provider", async () => {
    const { app, calls } = await team("dispatch-gate");

    try {
        const a = owner(app);
        const b = app.config.addUser("Bob", "guest").user;

        await app.hello(b);
        const { id } = await app.commands.createSession(a, { title: "dispatch" });
        const sent = await app.commands.submit(id, a, { text: "initial", requestId: "start" });

        await (await app.harness.submission(sent.submissionId, context))!.wait(context);
        const provider = (await app.harness.snapshot(ProviderDoc, id, context))!;
        const ref = app.accounts.choice(b)!;
        const model = app.models.getModel(ref.provider, ref.modelId)!;
        const count = calls.length;

        for (const sessionId of ["unrecognized-session", provider.sessionId]) {
            const result = await app.models.completeSimple(
                model,
                { messages: [{ role: "user", content: "wrong routing", timestamp: Date.now() }] },
                { sessionId },
            );

            assert.equal(result.stopReason, "error");
        }

        assert.equal(calls.length, count);
    } finally {
        await app.close();
    }
});
