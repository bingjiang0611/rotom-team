/** The tab's icon says Pi is working in this tab: a dot that blinks, and only while the run is busy. */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { createHandler } from "../src/server/http.ts";
import { cleanUp, newSession, openApp, root, scriptedModel, until } from "./helpers.ts";

const chromium = findBrowser();
const real = { skip: chromium === undefined ? "Chromium not installed" : false };
const PLAIN = "/icon.svg";
const RUNNING = "/icon-running.svg";
/** Longer than one blink: a still icon stays put across it. */
const STILL_MS = 1_200;
let app: Awaited<ReturnType<typeof openApp>>;
let browsers: Browsers;
let server: Server;
let page: Awaited<ReturnType<Browsers["open"]>>;

before(async () => {
    if (!chromium) {
        return;
    }

    app = await openApp(scriptedModel(), join(root, "tab-icon-data"));
    const id = Number(await newSession(app));

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

/** Put the real store in the busy state Pi's run gives it, without a model run. */
async function setBusy(busy: boolean) {
    await page.evaluate(`
        const { store } = await import('/store.js');
        store.set({ view: { ...store.state.view, live: { busy: ${busy} } } });
    `);
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

    await setBusy(true);
    await until(async () => (await iconFile()) === RUNNING, "the dot");
    await until(async () => (await iconFile()) === PLAIN, "the dot to blink out");

    await setBusy(false);
    await new Promise((resolve) => setTimeout(resolve, STILL_MS));
    assert.equal(await iconFile(), PLAIN, "an idle tab keeps the plain icon");
});

test("reduced motion keeps the dot still", real, async () => {
    await setMotion("reduced");
    await setBusy(true);
    await until(async () => (await iconFile()) === RUNNING, "the dot");
    await new Promise((resolve) => setTimeout(resolve, STILL_MS));
    assert.equal(await iconFile(), RUNNING, "the dot is not blinking");

    await setBusy(false);
    await setMotion("auto");
});
