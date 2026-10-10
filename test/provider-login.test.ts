import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";
import { cleanUp, fakeTab, openApp, owner, scriptedModel, until, type App } from "./helpers.ts";

let app: App;
let tab: ReturnType<typeof fakeTab>;
let calls = 0;

beforeEach(async () => {
    app = await openApp(scriptedModel());
    tab = fakeTab(undefined, owner(app));
    await app.attach(tab.client);
    const { runtime } = await app.accounts.forUser(owner(app));

    calls = 0;

    runtime.login = async () => {
        calls++;

        return {} as never;
    };
});

afterEach(async () => {
    app.detach(tab.client);
    await app.close();
});
after(cleanUp);

const event = <T = Record<string, unknown>>(flow: string, step: string) =>
    tab.events.findLast(
        (row) => row.event === "auth" && row.data.flowId === flow && row.data.step === step,
    )?.data as T | undefined;

function promptEvent(flow: string) {
    const found = event<{ promptId: string; prompt: { message: string } }>(flow, "prompt");

    assert.ok(found);

    return found;
}

async function finish(flow: string) {
    await until(() => Boolean(event(flow, "done")), "login settlement");
    // The flow reservation is released after the completion notification.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const done = event<{ ok: boolean; error?: string }>(flow, "done");

    assert.ok(done);

    return done;
}

async function answer(flow: string, value: string) {
    const prompt = promptEvent(flow);

    app.providers.answerLogin(owner(app), flow, prompt.promptId, value);
    await new Promise<void>((resolve) => setImmediate(resolve));
}

test("OpenAI waits for location and SSH readiness before invoking the SDK", async () => {
    const flow = await app.providers.startLogin(owner(app), "openai", "oauth");

    assert.equal(calls, 0);
    assert.match(promptEvent(flow).prompt.message, /Where is this browser/);
    await answer(flow, "ssh");
    assert.equal(calls, 0);
    assert.ok(event(flow, "callback-guide"));
    assert.match(promptEvent(flow).prompt.message, /not an automatic connectivity check/);
    await answer(flow, "ready");
    assert.equal((await finish(flow)).ok, true);
    assert.equal(calls, 1);
});

test("same-host choice uses the existing SDK login without SSH instructions", async () => {
    const flow = await app.providers.startLogin(owner(app), "openai", "oauth");

    await answer(flow, "local");
    assert.equal((await finish(flow)).ok, true);
    assert.equal(calls, 1);
    assert.equal(event(flow, "callback-guide"), undefined);
});

test("cancelling SSH setup neither authorizes nor calls the provider", async () => {
    const flow = await app.providers.startLogin(owner(app), "openai", "oauth");

    await answer(flow, "ssh");
    app.providers.cancelLogin(owner(app), flow);
    assert.equal((await finish(flow)).ok, false);
    assert.equal(calls, 0);
    assert.equal(
        (await app.accounts.forUser(owner(app))).runtime.getProviderAuthStatus("openai").configured,
        false,
    );
    const next = await app.providers.startLogin(owner(app), "openai", "oauth");

    app.providers.cancelLogin(owner(app), next);
    await finish(next);
});

test("a different member cannot confirm or cancel this login; callback logins are serialized", async () => {
    const other = app.config.addUser("Other", "guest").user;
    const flow = await app.providers.startLogin(owner(app), "openai", "oauth");
    const prompt = promptEvent(flow);

    assert.throws(
        () => app.providers.answerLogin(other, flow, prompt.promptId, "local"),
        /No such login/,
    );
    app.providers.cancelLogin(other, flow);
    await assert.rejects(
        app.providers.startLogin(other, "openai", "oauth"),
        /callback port 1455 is shared/,
    );
    await assert.rejects(
        app.providers.startLogin(other, "openai-codex", "oauth"),
        /callback port 1455 is shared/,
    );
    assert.equal(calls, 0);
    await answer(flow, "local");
    assert.equal((await finish(flow)).ok, true);
});

test("invalid location/readiness choices never invoke OAuth", async () => {
    const local = await app.providers.startLogin(owner(app), "openai", "oauth");

    await answer(local, "invented");
    assert.equal((await finish(local)).ok, false);
    const ssh = await app.providers.startLogin(owner(app), "openai", "oauth");

    await answer(ssh, "ssh");
    await answer(ssh, "invented");
    assert.equal((await finish(ssh)).ok, false);
    assert.equal(calls, 0);
});

test("setup expires after ten minutes and releases admission without invoking OAuth", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const flow = await app.providers.startLogin(owner(app), "openai", "oauth");

    t.mock.timers.tick(10 * 60_000);
    t.mock.timers.reset();
    const done = await finish(flow);

    assert.equal(done.ok, false);
    assert.match(done.error ?? "", /timed out after 10 minutes/);
    assert.equal(calls, 0);
    const next = await app.providers.startLogin(owner(app), "openai", "oauth");

    app.providers.cancelLogin(owner(app), next);
    await finish(next);
});

test("cancelling during SDK login aborts its signal, not just the browser dialog", async () => {
    const { runtime } = await app.accounts.forUser(owner(app));
    let aborted = false;

    runtime.login = async (_provider, _type, interaction) => {
        calls++;
        await new Promise<void>((_resolve, reject) => {
            interaction.signal!.addEventListener(
                "abort",
                () => {
                    aborted = true;
                    reject(interaction.signal!.reason);
                },
                { once: true },
            );
        });

        return {} as never;
    };

    const flow = await app.providers.startLogin(owner(app), "openai", "oauth");

    await answer(flow, "local");
    assert.equal(calls, 1);
    app.providers.cancelLogin(owner(app), flow);
    assert.equal((await finish(flow)).ok, false);
    assert.equal(aborted, true);
});

test("cancellation between consecutive setup prompts does not leave a stuck flow", async () => {
    const flow = await app.providers.startLogin(owner(app), "openai", "oauth");

    app.providers.answerLogin(owner(app), flow, promptEvent(flow).promptId, "ssh");
    app.providers.cancelLogin(owner(app), flow);
    assert.equal((await finish(flow)).ok, false);
    assert.equal(calls, 0);
    const next = await app.providers.startLogin(owner(app), "openai", "oauth");

    app.providers.cancelLogin(owner(app), next);
    await finish(next);
});

test("timeout during SDK login aborts the attempt without replay", async (t) => {
    const { runtime } = await app.accounts.forUser(owner(app));
    let aborted = false;

    runtime.login = async (_provider, _type, interaction) => {
        calls++;
        await new Promise<void>((_resolve, reject) => {
            interaction.signal!.addEventListener(
                "abort",
                () => {
                    aborted = true;
                    reject(interaction.signal!.reason);
                },
                { once: true },
            );
        });

        return {} as never;
    };

    t.mock.timers.enable({ apis: ["setTimeout"] });
    const flow = await app.providers.startLogin(owner(app), "openai", "oauth");

    await answer(flow, "local");
    assert.equal(calls, 1);
    t.mock.timers.tick(10 * 60_000);
    t.mock.timers.reset();
    const done = await finish(flow);

    assert.equal(done.ok, false);
    assert.match(done.error ?? "", /timed out after 10 minutes/);
    assert.equal(aborted, true);
    assert.equal(calls, 1);
});

test("API-key login does not ask for callback forwarding", async () => {
    const flow = await app.providers.startLogin(owner(app), "openai", "api_key");

    assert.equal((await finish(flow)).ok, true);
    assert.equal(event(flow, "prompt"), undefined);
    assert.equal(calls, 1);
});
