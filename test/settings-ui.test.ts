// Settings, in a real browser where this machine has Chromium: everything app-wide has one way in, the settings window,
// from the sidebar's foot or the folded rail; any of its sheets opened from elsewhere opens there; the session menu keeps
// only the session's own actions.
import { type App, cleanUp, newSession, openApp, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
/** Where to keep screenshots for a person to look at, when set. */
const shots = process.env.SETTINGS_SHOTS;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let session: ConversationId;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const present = (selector: string) =>
    inPage<boolean>(
        `return JSON.stringify(document.querySelector(${JSON.stringify(selector)}) !== null)`,
    );

const tap = async (selector: string) => {
    await until(() => present(selector), selector);
    await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
};

/** Click the button whose own text starts with `label`, inside `scope`. */
const press = async (scope: string, label: string) => {
    const script = `[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((each) => each.textContent.trim().startsWith(${JSON.stringify(label)}))`;

    await until(async () => (await page.evaluate(`Boolean(${script})`)) === "true", label);
    await page.evaluate(`${script}.click()`);
};

type Seen = {
    sheet: string | null;
    layers: number;
    dialogs: number;
    title: string | null;
    page: string | null;
    current: string | null;
    nav: string[];
};

const seen = () =>
    inPage<Seen>(`
        const { store } = await import("/store.js");
        const text = (selector) => document.querySelector(selector)?.textContent.trim() ?? null;

        return JSON.stringify({
            sheet: store.state.sheet?.type ?? null,
            layers: history.state?.pocket?.layers ?? 0,
            dialogs: document.querySelectorAll('.sheet-host:not(.leaving) [role="dialog"]').length,
            title: text('.sheet-host:not(.leaving) [role="dialog"] > .sheet-head h2'),
            page: text(".settings-page > .sheet-head h2"),
            current: text('.settings-link[aria-current="page"] > span'),
            nav: [...document.querySelectorAll(".settings-link")].map((each) => each.textContent.trim()),
        });
    `);

async function reach(expected: Partial<Seen>, what: string): Promise<Seen> {
    let last: Seen | undefined;

    try {
        await until(async () => {
            last = await seen();

            return Object.entries(expected).every(
                ([key, value]) =>
                    JSON.stringify(last![key as keyof Seen]) === JSON.stringify(value),
            );
        }, what);
    } catch {
        assert.fail(`${what}: ${JSON.stringify(last)}`);
    }

    return last!;
}

async function shot(name: string): Promise<void> {
    if (shots) {
        writeFileSync(
            join(shots, `${name}.jpg`),
            Buffer.from((await page.screenshot()).data, "base64"),
        );
    }
}

async function home(viewport: (typeof VIEWPORTS)[keyof typeof VIEWPORTS]): Promise<void> {
    await page.setViewport(viewport);
    await page.navigate(`${base}/`);
    await until(() => present(".session-row"), "the session list", 20_000);
    await page.evaluate(`(await import("/store.js")).closeSheet()`);
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "settings-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    session = await newSession(app);
    page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.desktop);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await until(() => present(".session-row"), "signed in", 20_000);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "the sidebar's foot is one way into settings, which lists every app-wide page",
    real,
    async () => {
        await home(VIEWPORTS.desktop);
        assert.equal(await present(".foot-tile"), false, "no tiles beside it");
        assert.equal(await present('.sessions-head [aria-label="Open the launcher"]'), false);

        // The home screen's list and the sidebar each have a foot: one button in each.
        for (const foot of await inPage<string[][]>(
            `return JSON.stringify([...document.querySelectorAll(".sessions-foot")].map((foot) => [...foot.querySelectorAll("button")].map((each) => each.title)))`,
        )) {
            assert.deepEqual(foot, ["Settings"]);
        }

        await until(() => present(".splash-actions"), "the home screen");
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify([...document.querySelectorAll(".splash-actions button")].some((each) => /Appearance/.test(each.textContent)))`,
            ),
            false,
            "the home screen has no Appearance button",
        );

        await tap('.sessions-foot .me-row[title="Settings"]');
        const open = await reach(
            {
                sheet: "running",
                dialogs: 1,
                title: "Settings",
                page: "Running now",
                current: "Running now",
            },
            "settings, at Running now",
        );

        for (const label of [
            "Your name",
            "My model accounts",
            "Configuration & skills",
            "Appearance",
            "People",
            "Projects & access",
            "Spend",
            "Running now",
            "Extensions",
            "Sign out",
        ]) {
            assert.ok(
                open.nav.some((each) => each.startsWith(label)),
                `${label} is in settings: ${open.nav}`,
            );
        }

        // Only a supervised server restarts itself; this one is not.
        assert.ok(!open.nav.some((each) => each.startsWith("Restart server")), `${open.nav}`);
        await shot("settings-desktop");
        await press(".settings-nav", "Appearance");
        await reach(
            {
                sheet: "appearance",
                dialogs: 1,
                title: "Settings",
                page: "Appearance",
                current: "Appearance",
            },
            "the Appearance page, in the same window",
        );
        await press(".settings-nav", "Spend");
        await reach(
            { sheet: "spend", page: "Spend", layers: 1 },
            "pages swap in place: one step back",
        );
        await page.evaluate(`history.back()`);
        await reach({ sheet: null, dialogs: 0 }, "back closes settings");
    },
);

test("a settings sheet opened from anywhere opens in settings", real, async () => {
    await home(VIEWPORTS.desktop);
    await page.evaluate(`(await import("/store.js")).openSheet({ type: "providers" })`);
    await reach(
        { title: "Settings", page: "My model accounts", current: "My model accounts", dialogs: 1 },
        "My model accounts, as a settings page",
    );
    // The window takes the focus in the same effects that listen for Escape: past that, Escape is heard.
    await until(
        async () =>
            (await page.evaluate(`String(document.activeElement?.matches(".settings-window"))`)) ===
            "true",
        "the settings window has the focus",
    );
    await page.press("Escape");
    await reach({ sheet: null, dialogs: 0 }, "Escape closes settings");
});

test("the session menu keeps only the session's actions", real, async () => {
    await home(VIEWPORTS.desktop);
    await page.navigate(`${base}/s/${session}`);
    await tap('.topbar [aria-label="Menu"]');
    await reach({ sheet: "menu" }, "the menu");
    const labels = await inPage<string[]>(
        `return JSON.stringify([...document.querySelectorAll(".sheet .list-item")].map((each) => each.textContent.trim()))`,
    );

    assert.ok(
        labels.some((each) => each.startsWith("Copy link")),
        `${labels}`,
    );

    for (const gone of [
        "Appearance",
        "Your name",
        "Running now",
        "Spend",
        "Sign out",
        "Extensions",
    ]) {
        assert.ok(
            !labels.some((each) => each.startsWith(gone)),
            `${gone} left the menu: ${labels}`,
        );
    }
});

test("the folded rail has the same one way in", real, async () => {
    await home(VIEWPORTS.desktop);
    await page.evaluate(`(await import("/theme.js")).setPrefs({ sidebar: "rail" })`);
    await until(() => present(".rail"), "the rail");
    assert.equal(
        await present(
            '.rail [title="Running now"], .rail [title="Appearance"], .rail [title="Launcher"]',
        ),
        false,
    );
    await shot("settings-rail");
    await tap('.rail [title="Settings"]');
    await reach(
        { title: "Settings", dialogs: 1, layers: 1 },
        "settings from the rail, a step back",
    );
    await page.evaluate(`history.back()`);
    await reach({ sheet: null }, "closed");
    await page.evaluate(`(await import("/theme.js")).setPrefs({ sidebar: "open" })`);
});

test("on a phone, settings lists its pages in a row above the open one", real, async () => {
    await home(VIEWPORTS.mobile);
    await tap('.home-list .me-row[title="Settings"]');
    await reach({ title: "Settings", dialogs: 1 }, "settings on a phone");
    const layout = await inPage<{ direction: string; navBottom: number; pageTop: number }>(`
        const nav = document.querySelector(".settings-nav");

        return JSON.stringify({
            direction: getComputedStyle(nav).flexDirection,
            navBottom: nav.getBoundingClientRect().bottom,
            pageTop: document.querySelector(".settings-page").getBoundingClientRect().top,
        });
    `);

    assert.equal(layout.direction, "row");
    assert.ok(layout.pageTop >= layout.navBottom - 1, JSON.stringify(layout));
    await shot("settings-phone");
    await press(".settings-nav", "Appearance");
    await reach({ page: "Appearance" }, "another page, on a phone");
});
