import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { cleanUp, openApp, owner, root, scriptedModel, until, type App } from "./helpers.ts";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { createHandler } from "../src/server/http.ts";

const real = { skip: findBrowser() === undefined ? "no Chromium browser" : false };
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base: string;
let sdkCalls = 0;
let answersCompleted = 0;
let rejectLogin = false;
let pasted: string | undefined;
const CALLBACK = "http://localhost:1455/auth/callback?code=synthetic&state=synthetic";

async function state() {
    return JSON.parse(
        await page.evaluate(`
        const {store} = await import('/store.js');
        return JSON.stringify({ auth: store.state.auth, text: document.body.innerText,
            width: document.documentElement.scrollWidth, viewport: innerWidth });
    `),
    );
}

async function click(label: string) {
    await page.evaluate(`
        const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)});
        if (!button) throw Error('Missing test button');
        button.click();
    `);
}

async function begin() {
    await page.evaluate(
        `const {api} = await import('/store.js'); await api('providers/openai-codex/login', {type:'oauth'});`,
    );
    await until(async () => (await state()).auth?.prompt?.type === "manual_code", "paste prompt");
}

before(async () => {
    if (real.skip) {
        return;
    }

    app = await openApp(scriptedModel());
    const { runtime } = await app.accounts.forUser(owner(app));

    // The SDK's own browser login: a link, then a prompt that also takes the pasted callback address.
    runtime.login = async (_provider, _type, interaction) => {
        sdkCalls++;
        interaction.notify({ type: "auth_url", url: "https://auth.example.test/authorize" });

        if (rejectLogin) {
            throw new Error("Synthetic provider refusal");
        }

        pasted = await interaction.prompt({
            type: "manual_code",
            message:
                "Complete login in your browser, or paste the authorization code / redirect URL here:",
            placeholder: "http://localhost:1455/auth/callback",
        });

        return {} as never;
    };

    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });

    server = createServer((request, response) => {
        // Force the next SSE prompt/result to precede the answer's HTTP completion.
        if (
            request.method === "POST" &&
            request.url?.startsWith("/api/auth/") &&
            !request.url.endsWith("/cancel")
        ) {
            const end = response.end;

            response.end = ((...args: Parameters<typeof end>) => {
                setTimeout(() => {
                    Reflect.apply(end, response, args);
                    answersCompleted++;
                }, 150);

                return response;
            }) as typeof end;
        }

        void handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "login-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport({ width: 390, height: 844, scale: 1, mobile: true });
    // Only this isolated Chromium profile receives the synthetic fixture cookie.
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await until(
        async () =>
            (await page.evaluate(
                `String(document.querySelector('.me-row[title="Settings"]') !== null)`,
            )) === "true",
        "fixture sign-in",
        20_000,
    );
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "a browser on another computer pastes the callback address back, at 390px and 320px",
    real,
    async () => {
        await begin();
        const shown = await state();

        assert.match(shown.text, /Open the sign-in page/);
        assert.match(
            shown.text,
            /copy that page's full address from the address bar and paste it here/,
        );
        assert.doesNotMatch(shown.text, /SSH|1455 forward/);
        assert.ok(shown.width <= shown.viewport);
        await page.setViewport({ width: 320, height: 740, scale: 1, mobile: true });
        const narrow = await state();

        assert.ok(narrow.width <= narrow.viewport);
        await page.setViewport({ width: 390, height: 844, scale: 1, mobile: true });
        await page.evaluate(`
            const input = document.querySelector('.sheet:not(.leaving) .field input');
            input.value = ${JSON.stringify(CALLBACK)};
            input.dispatchEvent(new Event('input', { bubbles: true }));
        `);
        const answered = answersCompleted;

        await click("Continue");
        await until(() => answersCompleted > answered, "delayed paste HTTP answer");
        await until(async () => (await state()).auth === null, "signed in closes the sheet");
        assert.equal(pasted, CALLBACK);
        assert.equal(sdkCalls, 1);
    },
);

test("cancel dismisses the flow, ends the SDK's wait and releases the login", real, async () => {
    await begin();
    const flowId = (await state()).auth.flowId;

    await page.evaluate(
        `document.querySelector('.sheet:not(.leaving) [aria-label="Close"]').click()`,
    );
    await until(async () => (await state()).auth === null, "cancel dialog");
    // Server acknowledgement is a readback, not a replay of the cancellation mutation.
    await until(async () => {
        try {
            app.providers.answerLogin(owner(app), flowId, "not-a-prompt", "x");
        } catch (error) {
            return (error as Error).message === "No such login";
        }

        return false;
    }, "cancelled flow reservation released");
    assert.doesNotMatch((await state()).text, /SSH/);
    assert.equal(sdkCalls, 2);
});

test("provider failure is shown until the member closes it", real, async () => {
    rejectLogin = true;
    await page.evaluate(
        `const {api} = await import('/store.js'); await api('providers/openai-codex/login', {type:'oauth'});`,
    );
    await until(async () => (await state()).auth?.done?.ok === false, "failed login");
    assert.match((await state()).text, /Synthetic provider refusal/);
    assert.equal(sdkCalls, 3);
    await click("Close");
    await until(async () => (await state()).auth === null, "close failed login");
});
