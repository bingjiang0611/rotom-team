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

/** A login that stays open until it is cancelled or timed out, as one waiting for its callback does. */
async function pendingLogin() {
    const { runtime } = await app.accounts.forUser(owner(app));
    const seen = { aborted: false };

    runtime.login = async (_provider, _type, interaction) => {
        calls++;
        await new Promise<void>((_resolve, reject) => {
            interaction.signal!.addEventListener(
                "abort",
                () => {
                    seen.aborted = true;
                    reject(interaction.signal!.reason);
                },
                { once: true },
            );
        });

        return {} as never;
    };

    return seen;
}

test("OpenAI sign-in goes straight to the SDK: no location or SSH setup is asked first", async () => {
    for (const provider of ["openai", "openai-codex"]) {
        const before = calls;
        const flow = await app.providers.startLogin(owner(app), provider, "oauth");

        assert.equal((await finish(flow)).ok, true);
        assert.equal(calls, before + 1);
        assert.equal(event(flow, "prompt"), undefined);
    }
});

test("an address pasted into the SDK's prompt reaches the SDK", async () => {
    const { runtime } = await app.accounts.forUser(owner(app));
    let pasted: string | undefined;

    runtime.login = async (_provider, _type, interaction) => {
        pasted = await interaction.prompt({
            type: "manual_code",
            message: "paste the redirect URL here:",
        });

        return {} as never;
    };

    const flow = await app.providers.startLogin(owner(app), "openai-codex", "oauth");

    await answer(flow, "http://localhost:1455/auth/callback?code=c&state=s");
    assert.equal((await finish(flow)).ok, true);
    assert.equal(pasted, "http://localhost:1455/auth/callback?code=c&state=s");
});

test("a different member cannot answer or cancel this login; callback logins are serialized", async () => {
    const seen = await pendingLogin();
    const other = app.config.addUser("Other", "guest").user;
    const flow = await app.providers.startLogin(owner(app), "openai", "oauth");

    assert.throws(() => app.providers.answerLogin(other, flow, "any-prompt", "x"), /No such login/);
    app.providers.cancelLogin(other, flow);
    await assert.rejects(
        app.providers.startLogin(other, "openai", "oauth"),
        /callback port 1455 is shared/,
    );
    await assert.rejects(
        app.providers.startLogin(other, "openai-codex", "oauth"),
        /callback port 1455 is shared/,
    );
    assert.equal(seen.aborted, false);
    app.providers.cancelLogin(owner(app), flow);
    assert.equal((await finish(flow)).ok, false);
    assert.equal(calls, 1);
});

test("cancelling during SDK login aborts its signal, not just the browser dialog", async () => {
    const seen = await pendingLogin();
    const flow = await app.providers.startLogin(owner(app), "openai", "oauth");

    assert.equal(calls, 1);
    app.providers.cancelLogin(owner(app), flow);
    assert.equal((await finish(flow)).ok, false);
    assert.equal(seen.aborted, true);
    const next = await app.providers.startLogin(owner(app), "openai", "oauth");

    app.providers.cancelLogin(owner(app), next);
    await finish(next);
});

test("timeout during SDK login aborts the attempt without replay", async (t) => {
    const seen = await pendingLogin();

    t.mock.timers.enable({ apis: ["setTimeout"] });
    const flow = await app.providers.startLogin(owner(app), "openai", "oauth");

    assert.equal(calls, 1);
    t.mock.timers.tick(10 * 60_000);
    t.mock.timers.reset();
    const done = await finish(flow);

    assert.equal(done.ok, false);
    assert.match(done.error ?? "", /timed out after 10 minutes/);
    assert.equal(seen.aborted, true);
    assert.equal(calls, 1);
});

test("API-key login asks nothing before the SDK", async () => {
    const flow = await app.providers.startLogin(owner(app), "openai", "api_key");

    assert.equal((await finish(flow)).ok, true);
    assert.equal(event(flow, "prompt"), undefined);
    assert.equal(calls, 1);
});
