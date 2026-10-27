/** Native metadata-only sessions with deterministic UI state; no inference. The fork dispatch is a UI stub, not an executed fork. */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { createHandler } from "../src/server/http.ts";
import { cleanUp, openNativeApp, owner, root, scriptedModel, until } from "./helpers.ts";

const chromium = findBrowser();
const real = { skip: chromium === undefined ? "Chromium not installed" : false };
let app: Awaited<ReturnType<typeof openNativeApp>>;
let browsers: Browsers;
let server: Server;
let page: Awaited<ReturnType<Browsers["open"]>>;
let id: number;
let forkId: number;

before(async () => {
    if (!chromium) {
        return;
    }

    const data = join(realpathSync(root), "attention-data");

    mkdirSync(data, { mode: 0o700 });
    app = await openNativeApp(scriptedModel(), data);
    id = Number((await app.commands.createSession(owner(app), { backend: "rotom" })).id);
    forkId = Number((await app.commands.createSession(owner(app), { backend: "rotom" })).id);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "attention-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await page.navigate(`${base}/s/${id}`);
    await until(
        async () =>
            (await page.evaluate(`Boolean(document.querySelector('.composer'))`)) === "true",
        "session loaded",
        20_000,
    );
    // Drive the real components with deterministic states through their real store.
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

async function setKernel(kernel: object, live: object = {}) {
    await page.evaluate(`
        const { store, openSheet } = await import('/store.js');
        store.set({ view: { ...store.state.view, kernel: ${JSON.stringify(kernel)}, live: ${JSON.stringify(live)} } });
        openSheet({ type: 'menu' });
    `);
    await until(
        async () =>
            (await page.evaluate(
                `Boolean(document.querySelector('[aria-label="Session actions"]'))`,
            )) === "true",
        "native session menu",
    );
}

const fork = `Array.from(document.querySelectorAll('[aria-label="Session actions"] button')).find(b => b.querySelector('span')?.textContent === 'Fork')`;

async function forkState() {
    return JSON.parse(
        await page.evaluate(`
        JSON.stringify({disabled: ${fork}.disabled, text: ${fork}.textContent, title: ${fork}.title})
    `),
    ) as { disabled: boolean; text: string; title: string };
}

test("running and unknown sessions explain why Fork does not dispatch", real, async () => {
    await page.evaluate(`
        const { actions } = await import('/store.js');
        window.forkCalls = 0;
        actions.kernel = async () => { window.forkCalls++; return {id: ${forkId}}; };
    `);
    await setKernel({ yours: true, memberName: "Fixture", segmentId: "one" }, { busy: true });
    const running = await forkState();

    assert.equal(running.disabled, true);
    assert.match(running.text, /Wait for the run to finish, or Stop it first/);
    await page.evaluate(`${fork}.click()`);
    assert.equal(await page.evaluate("window.forkCalls"), "0");
    await setKernel({ yours: true, memberName: "Fixture", pending: { status: "unknown" } });
    assert.match((await forkState()).text, /Resolve the unknown outcome/);
    await setKernel({ yours: true, memberName: "Fixture", initializing: true });
    assert.match((await forkState()).text, /still initializing/);
    await page.evaluate(`
        await Promise.all(document.querySelector('.sheet').getAnimations({subtree: true})
            .filter(animation => animation.effect.getTiming().iterations !== Infinity)
            .map(animation => animation.finished));
    `);
    const shot = await page.screenshot();

    writeFileSync("/tmp/rotom-fork-disabled.jpg", Buffer.from(shot.data, "base64"));
});

test("idle Fork is enabled and dispatches once", real, async () => {
    await setKernel({ yours: true, memberName: "Fixture", segmentId: "one" });
    assert.equal((await forkState()).disabled, false);
    await page.evaluate(`${fork}.click()`);
    await until(async () => (await page.evaluate("window.forkCalls")) === "1", "one fork dispatch");
    await until(
        async () =>
            (await page.evaluate(
                `location.pathname === '/s/${forkId}' && (await import('/store.js')).store.state.view.conversation?.id === ${forkId} && (await import('/store.js')).store.state.view.kernel?.segmentId !== 'one'`,
            )) === "true",
        "navigation reloads the fixture session",
    );
});

test(
    "answer attention replaces the working animation in sidebar and folded rail",
    real,
    async () => {
        await page.evaluate(`
        dispatchEvent(new Event('pagehide'));
        const { store, closeSheet } = await import('/store.js');
        const { setPrefs } = await import('/theme.js');
        closeSheet();
        setPrefs({ sidebar: 'open' });
        store.set({
            sessions: store.state.sessions.map(s =>
                s.id === ${id} ? {...s, busy: true, needsAnswer: true} : s
            ),
        });
    `);
        const row = `.session-row[data-id="${id}"]`;

        await until(
            async () =>
                (await page.evaluate(`Boolean(document.querySelector('${row} .state-input'))`)) ===
                "true",
            "waiting-for-answer sidebar marker",
        );
        assert.equal(
            await page.evaluate(`document.querySelector('${row} .session-attention').textContent`),
            "Needs answer",
        );
        assert.equal(
            await page.evaluate(`Boolean(document.querySelector('${row} .mini-sweep'))`),
            "false",
        );
        const shot = await page.screenshot();

        writeFileSync("/tmp/rotom-session-needs-answer.jpg", Buffer.from(shot.data, "base64"));
        await page.evaluate(`
            const { store } = await import('/store.js');
            (await import('/theme.js')).setPrefs({ sidebar: 'rail' });
            store.set({
                sessions: store.state.sessions.map(s =>
                    s.id === ${id} ? {...s, busy: true, needsAnswer: true} : s
                ),
            });
        `);
        await until(
            async () =>
                (await page.evaluate(`Boolean(document.querySelector('.rail .ws-answer'))`)) ===
                "true",
            "folded rail question marker",
        );
        const underline = await page.evaluate(
            `getComputedStyle(document.querySelector('.ws.waiting'), '::after').content`,
        );

        assert.equal(underline, "none", "waiting must not look like working");
        await page.setViewport({ width: 390, height: 844, scale: 1, mobile: true });
        await page.evaluate(`
            const { store } = await import('/store.js');
            (await import('/theme.js')).setPrefs({ sidebar: 'open' });
            store.set({ drawer: true });
        `);
        await until(
            async () =>
                (await page.evaluate(
                    `Boolean(document.querySelector('.drawer ${row} .session-attention'))`,
                )) === "true",
            "phone drawer answer attention",
        );
        const fits = await page.evaluate(`
            const label = document.querySelector('.drawer ${row} .session-attention');
            const session = label.closest('.session');
            JSON.stringify(label.getBoundingClientRect().right <= session.getBoundingClientRect().right);
        `);

        assert.equal(fits, "true", "answer text stays within the phone row");
        await page.setViewport({ width: 1280, height: 800, scale: 1, mobile: false });
        await page.evaluate(`
        const { store } = await import('/store.js');
        (await import('/theme.js')).setPrefs({ sidebar: 'open' });
        store.set({
            sessions: store.state.sessions.map(s =>
                s.id === ${id} ? {...s, needsAnswer: false} : s
            ),
        });
    `);
        await until(
            async () =>
                (await page.evaluate(`Boolean(document.querySelector('${row} .mini-sweep'))`)) ===
                "true",
            "answering restores working indicator",
        );
        assert.equal(
            await page.evaluate(`Boolean(document.querySelector('${row} .session-attention'))`),
            "false",
        );
    },
);
