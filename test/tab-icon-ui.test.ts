/** Real app components with deterministic native/list states; no model inference or production data. */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { createHandler } from "../src/server/http.ts";
import { cleanUp, openNativeApp, owner, root, scriptedModel, until } from "./helpers.ts";

const chromium = findBrowser();
const real = { skip: chromium === undefined ? "Chromium not installed" : false };
const PLAIN = "/icon.svg";
const RUNNING = "/icon-running.svg";
const ANSWER = "/icon-answer.svg";
const FINISHED = "/icon-finished.svg";
/** Longer than one blink: a still icon stays put across it. */
const STILL_MS = 1_200;
let app: Awaited<ReturnType<typeof openNativeApp>>;
let browsers: Browsers;
let server: Server;
let page: Awaited<ReturnType<Browsers["open"]>>;
let id: number;

before(async () => {
    if (!chromium) {
        return;
    }

    const data = join(realpathSync(root), "tab-icon-data");

    mkdirSync(data, { mode: 0o700 });
    app = await openNativeApp(scriptedModel(), data);
    id = Number((await app.commands.createSession(owner(app), { backend: "rotom" })).id);
    await app.commands.createSession(owner(app), { backend: "rotom" });
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "tab-icon-ui-")),
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
    await until(
        async () =>
            (await page.evaluate(`(await import('/store.js')).store.state.sessions.length`)) ===
            "2",
        "both session summaries loaded",
    );
    await page.evaluate(`
        dispatchEvent(new Event('pagehide'));
        window.tabIconView = (await import('/store.js')).store.state.view;
    `);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

/** The file the tab's icon link points at, whatever the server's port. */
async function iconFile(): Promise<string> {
    return JSON.parse(
        await page.evaluate(`
        JSON.stringify(new URL(document.querySelector('link[rel="icon"]').href).pathname)
    `),
    ) as string;
}

/** Set both summaries and the open session's authoritative view, without a model run. */
async function setState(
    live: object = {},
    kernel: object = {},
    current: object = {},
    other: object = {},
) {
    await page.evaluate(`
        const { store } = await import('/store.js');
        store.set({
            conversationId: ${id},
            sessions: store.state.sessions.map(session => ({
                ...session, busy: false, needsAnswer: false, waiting: false,
                finishedUnread: false, archived: false,
                ...(session.id === ${id} ? ${JSON.stringify(current)} : ${JSON.stringify(other)}),
            })),
            view: { ...window.tabIconView, live: ${JSON.stringify(live)}, kernel: ${JSON.stringify(kernel)} },
        });
    `);
}

async function stillIcon(expected: string) {
    await until(async () => (await iconFile()) === expected, expected);
    await new Promise((resolve) => setTimeout(resolve, STILL_MS));
    assert.equal(await iconFile(), expected, "the icon stays still across a blink interval");
}

async function setMotion(motion: "auto" | "full" | "reduced") {
    await page.evaluate(
        `(await import('/theme.js')).setPrefs({ motion: ${JSON.stringify(motion)} })`,
    );
    assert.equal(
        await page.evaluate("document.documentElement.dataset.motion"),
        motion === "reduced" ? "reduced" : "full",
    );
}

test("a working session's tab blinks a dot, and stops when it goes idle", real, async () => {
    assert.equal(await iconFile(), PLAIN);
    await setState({ busy: true });
    await until(async () => (await iconFile()) === RUNNING, "the dot");
    await until(async () => (await iconFile()) === PLAIN, "the dot to blink out");
    await setState();
    await stillIcon(PLAIN);
});

test("answer attention is static and overrides running and finished sessions", real, async () => {
    await setState(
        { busy: true },
        { yours: true, dialogs: [{ id: "answer", method: "confirm", title: "Continue?" }] },
        { busy: true, needsAnswer: true },
        { finishedUnread: true },
    );
    await stillIcon(ANSWER);

    // An answer removes the live dialog before the sidebar summary catches up.
    await setState({ busy: true }, { yours: true, dialogs: [] }, { busy: true, needsAnswer: true });
    await until(async () => (await iconFile()) === RUNNING, "blue after answering");
    await until(async () => (await iconFile()) === PLAIN, "blue blinking resumes");
});

test(
    "two waiting sessions stay yellow, even after one resumes or on the home screen",
    real,
    async () => {
        await setState(
            { busy: true },
            { yours: true, dialogs: [{ id: "answer", method: "confirm", title: "Continue?" }] },
            { busy: true, needsAnswer: true },
            { busy: true, needsAnswer: true },
        );
        await stillIcon(ANSWER);
        await setState(
            { busy: true },
            { yours: true, dialogs: [] },
            {},
            { busy: true, needsAnswer: true },
        );
        await stillIcon(ANSWER);
        await page.evaluate(`
        const { store, emptyView } = await import('/store-state.js');
        store.set({ conversationId: null, view: emptyView() });
    `);
        await stillIcon(ANSWER);
    },
);

test("unseen completion is green and static; viewing it clears the dot", real, async () => {
    await setState({}, {}, {}, { finishedUnread: true });
    await stillIcon(FINISHED);
    await setState();
    await stillIcon(PLAIN);
});

test(
    "background running work overrides completion, but archived sessions do not notify",
    real,
    async () => {
        await setState({}, {}, { finishedUnread: true }, { busy: true });
        await until(async () => (await iconFile()) === RUNNING, "background blue dot");
        await until(async () => (await iconFile()) === PLAIN, "background blue blinks");
        await setState(
            {},
            {},
            { finishedUnread: true },
            { archived: true, busy: true, needsAnswer: true },
        );
        await stillIcon(FINISHED);
    },
);

test("another member's dialog is not a question for this member", real, async () => {
    await setState(
        { busy: true },
        { yours: false, dialogs: [{ id: "foreign", method: "confirm", title: "Continue?" }] },
    );
    await until(async () => (await iconFile()) === RUNNING, "foreign question remains running");
    await until(
        async () => (await iconFile()) === PLAIN,
        "foreign question does not stop blinking",
    );
});

test("reduced motion keeps blue still, including when toggled during a run", real, async () => {
    await setState({ busy: true });
    await setMotion("reduced");
    await stillIcon(RUNNING);
    await setMotion("full");
    await until(async () => (await iconFile()) === PLAIN, "blinking resumes without a new run");
    await setMotion("reduced");
    await stillIcon(RUNNING);
    await setState();
    await setMotion("auto");
});

test("the actual SVG dots use distinct blue, yellow and green fills", () => {
    for (const [file, color] of [
        [RUNNING, "#7aa2f7"],
        [ANSWER, "#e0af68"],
        [FINISHED, "#00ff99"],
    ]) {
        const svg = readFileSync(new URL(`../web${file}`, import.meta.url), "utf8");

        assert.match(svg, new RegExp(`<circle[^>]+fill="${color}"`));
        assert.doesNotMatch(svg, /<animate/);
    }
});
