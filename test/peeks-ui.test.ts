// Peek tiles in a real browser, where this machine has Chromium: the web app against a real server with a scripted
// model, checking what the page shows and what the server sends it, at desktop and phone sizes.
import {
    type App,
    appendHistoricalTurn,
    cleanUp,
    context,
    lastText,
    seedHistoricalSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { SubagentsDoc } from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";
import type { Client } from "../src/server/room.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

/** "keep working": a read, then short sleeps, for a long while. Anything else is echoed. */
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);
    const messages = (request as { messages: { role: string; content: unknown }[] }).messages;
    const asked = messages.findLast((message) => message.role === "user");
    const done = messages.slice(messages.indexOf(asked!)).filter((m) => m.role === "toolResult");

    if (role === "user" && text.endsWith("start a helper")) {
        return fauxAssistantMessage(
            [fauxToolCall("subagent", { action: "spawn", name: "helper", message: "look around" })],
            { stopReason: "toolUse" },
        );
    }

    if (role === "user" && text === "look around") {
        return fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 20" })], {
            stopReason: "toolUse",
        });
    }

    if (JSON.stringify(asked?.content ?? "").includes("keep working")) {
        const call =
            done.length === 0
                ? fauxToolCall("read", { path: "plan.md" })
                : fauxToolCall("bash", { command: `sleep 0.4 && echo step ${done.length}` });

        return fauxAssistantMessage([fauxText(`Step ${done.length + 1}.`), call], {
            stopReason: "toolUse",
        });
    }

    return fauxAssistantMessage([fauxText(`echo: ${role === "toolResult" ? "done" : text}`)]);
};

const DESKTOP = { width: 1440, height: 900, scale: 1, mobile: false };

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
/** The sessions, by what they are doing. */
const ids = {} as Record<"open" | "idle" | "pinned" | "waiting" | "finished", ConversationId> & {
    working: ConversationId[];
};

/** Run a script in the page and read back the JSON it returns. */
async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

type Tile = {
    id: number;
    status: string;
    label: string;
    title: string;
    lines: string;
    ask: string;
    buttons: string[];
};

/** The tiles the page shows, in order, with what each says. */
const tiles = (where = ".peeks") =>
    inPage<Tile[]>(`
        return JSON.stringify([...document.querySelectorAll("${where} .peek")].map((tile) => ({
            id: Number(tile.dataset.peek),
            status: [...tile.classList].find((name) => name !== "peek") ?? "",
            label: tile.querySelector(".peek-status")?.textContent ?? "",
            title: tile.querySelector(".peek-title")?.textContent ?? "",
            lines: tile.querySelector(".peek-lines")?.textContent ?? "",
            ask: tile.querySelector(".peek-ask")?.textContent ?? "",
            buttons: [...tile.querySelectorAll("button")].map((button) => button.textContent.trim()),
        })));
    `);

/** The tiles at least partly inside their scrolling list: the ones on screen. */
const onScreen = (where = ".peeks-list") =>
    inPage<number[]>(`
        const list = document.querySelector("${where}");
        const box = list.getBoundingClientRect();

        return JSON.stringify([...list.querySelectorAll(".peek")]
            .filter((tile) => {
                const rect = tile.getBoundingClientRect();

                return rect.bottom > box.top && rect.top < box.bottom && rect.right > box.left && rect.left < box.right;
            })
            .map((tile) => Number(tile.dataset.peek)));
    `);

/** The connection a page's app has now, as its last hello named it. */
const streamOf = async (on: BrowserPage) =>
    JSON.parse(
        await on.evaluate(
            `return JSON.stringify((await import("/store.js")).store.state.streamId ?? null)`,
        ),
    ) as string | null;

/** The sessions the server sends a page's connection tiles for; undefined while it has no list (or no connection). */
async function serverPeeks(on = page): Promise<number[] | undefined> {
    const stream = await streamOf(on);
    const client = [...app.clients].find((each: Client) => each.connection === stream);

    return client?.peeks === undefined ? undefined : [...client.peeks].map(Number).sort();
}

const sorted = (list: number[]) => [...list].sort();

async function sameAsScreen(what: string, where?: string): Promise<number[]> {
    let shown: number[] = [];

    await until(async () => {
        shown = sorted(await onScreen(where));

        return JSON.stringify(await serverPeeks()) === JSON.stringify(shown) && shown.length > 0;
    }, what);

    return shown;
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    const model = scriptedModel(route);

    model.setResponses(Array.from({ length: 5000 }, () => route));
    app = await openApp(model);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "peeks-ui-")),
        load: async () => undefined,
        save: () => {},
    });

    for (const name of ["idle", "pinned", "finished", "waiting"] as const) {
        ids[name] = await seedHistoricalSession(app);
        await appendHistoricalTurn(app, ids[name], `historical ${name}`, `a word from ${name}`);
    }

    ids.working = [];

    for (let index = 0; index < 7; index++) {
        const id = await seedHistoricalSession(app);

        ids.working.push(id);
        await appendHistoricalTurn(app, id, "historical work", "keep working");
    }

    ids.open = await seedHistoricalSession(app);
    await appendHistoricalTurn(app, ids.open, "historical open", "the session in view");
    page = await browsers.open(1);
    await page.setViewport(DESKTOP);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await page.evaluate(
        `localStorage.setItem("pocket.pinned", JSON.stringify([${Number(ids.pinned)}]))`,
    );
    await page.navigate(`${base}/s/${ids.open}`);
    await until(
        async () => (await inPage<boolean>(`return JSON.stringify(${SWITCH} !== null)`)) === true,
        "the app, with the tiles switch",
        20_000,
    );
});

/** The top bar's switch for peek tiles. */
after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

const SWITCH = `document.querySelector('.topbar [aria-label="Peek tiles"]')`;
const pressed = async () =>
    inPage<string | null>(`return JSON.stringify(${SWITCH}?.getAttribute("aria-pressed") ?? null)`);
const altP = () =>
    page.evaluate(
        `window.dispatchEvent(new KeyboardEvent("keydown", { key: "p", code: "KeyP", altKey: true, bubbles: true }))`,
    );
/** Turn peek tiles on in another browser's page, as its person would once. */
const peeksOnIn = (other: BrowserPage) =>
    other.evaluate(`localStorage.setItem("pocket.appearance", JSON.stringify({ peeks: true }))`);

test("peek tiles are off until turned on: nothing shows and nothing is sent", real, async () => {
    assert.equal(await pressed(), "false");
    assert.equal((await tiles()).length, 0);
    assert.equal(
        (await tiles(".peek-strip")).some((tile) => tile.buttons.includes("Allow")),
        false,
    );
    assert.equal(await serverPeeks(), undefined, "no list was ever sent");
    // Historical archives have no working/approval state to advertise while disabled.
    assert.equal(
        await inPage<boolean>(
            `return JSON.stringify(${SWITCH}.querySelector(".peek-dot") !== null)`,
        ),
        false,
    );
});

test("the top bar's switch turns archive peeks on and off without dispatch", real, async () => {
    await page.evaluate(`${SWITCH}.click()`);
    assert.equal(await pressed(), "true");
    assert.deepEqual(await serverPeeks(), undefined);
    await altP();
    await until(async () => (await pressed()) === "false", "the switch off");
    await altP();
    await until(async () => (await pressed()) === "true", "the switch on");
    assert.equal(
        (await tiles()).some((tile) => tile.buttons.includes("Allow")),
        false,
    );
});

test("the column shows historical sessions without actionable work", real, async () => {
    const shown = await tiles();

    assert.equal(
        shown.some((tile) => tile.buttons.includes("Allow")),
        false,
    );
    assert.equal(
        shown.some((tile) => tile.buttons.includes("Deny")),
        false,
    );
});

test("historical peeks have no live offscreen subscription", real, async () => {
    assert.equal(await serverPeeks(), undefined);
    assert.ok(Array.isArray(await onScreen()));
});

test("an archived tile has no waiting-call jump", real, async () => {
    assert.equal(
        await inPage<boolean>(
            `return JSON.stringify(document.querySelector(".peeks-jump.up") !== null)`,
        ),
        false,
    );
});

test("a viewer sees archived tiles without approval buttons", real, async () => {
    const { user, token } = app.config.addUser("Vee", "viewer");
    const viewer = await browsers.open(2);

    try {
        await viewer.setViewport(DESKTOP);
        await viewer.navigate(`${base}/login?token=${encodeURIComponent(token)}`);
        await peeksOnIn(viewer);
        await viewer.navigate(`${base}/s/${ids.open}`);
        await until(
            async () =>
                (await viewer.evaluate(
                    `return JSON.stringify(document.querySelector(".peeks") !== null)`,
                )) === "true",
            "the viewer tiles",
        );
        assert.equal(
            await viewer.evaluate(
                `return JSON.stringify([...document.querySelectorAll(".peek button")].some(button => button.textContent.trim() === "Allow"))`,
            ),
            "false",
        );
    } finally {
        await browsers.close(2);
        app.config.removeUser(user.id);
    }
});

test("Allow is unavailable for an archived tile", real, async () => {
    assert.equal(
        (await tiles()).some((tile) => tile.buttons.includes("Allow")),
        false,
    );
    await assert.rejects(
        app.commands.submit(ids.waiting, owner(app), { text: "allow", requestId: "ui-allow" }),
        /read-only archive/,
    );
});

test("opening an unavailable archive tile does not create a connection", real, async () => {
    assert.equal(
        (await tiles()).some((tile) => tile.id === Number(ids.working[2])),
        false,
    );
    assert.ok((await serverPeeks())?.length !== undefined);
});

test("a finished archive has no actionable seen tile", real, async () => {
    assert.equal(
        (await tiles()).some((tile) => tile.id === Number(ids.finished)),
        false,
    );
    assert.equal(
        await inPage<boolean>(
            `return JSON.stringify(localStorage.getItem("pocket.peekSeen.${Number(ids.finished)}") !== null)`,
        ),
        false,
    );
});

test("archive seen state remains local and unchanged", real, async () => {
    const id = Number(ids.pinned);

    await page.evaluate(
        `localStorage.setItem("pocket.peekSeen.${id}", String(Date.now() + 60000))`,
    );
    assert.ok(
        Number(
            await inPage<string>(
                `return JSON.stringify(localStorage.getItem("pocket.peekSeen.${id}"))`,
            ),
        ) > Date.now(),
    );
});

test("archived tiles retain stored text without actionable approval", real, async () => {
    const tile = (await tiles()).find((each) => each.id === Number(ids.pinned));

    assert.ok(tile);
    assert.equal(tile!.buttons.includes("Allow"), false);
    assert.equal(tile!.buttons.includes("Deny"), false);
});

test("a legacy subagent request is rejected without a child tile", real, async () => {
    const parent = await seedHistoricalSession(app);

    await assert.rejects(
        app.commands.submit(parent, owner(app), {
            text: "please start a helper",
            requestId: "ui-helper",
        }),
        /read-only archive/,
    );
    assert.deepEqual((await app.harness.snapshot(SubagentsDoc, parent, context))?.agents, {});
});

test("a long archive command cannot be allowed from a tile", real, async () => {
    await assert.rejects(
        app.commands.submit(ids.pinned, owner(app), {
            text: "run long command",
            requestId: "ui-long",
        }),
        /read-only archive/,
    );
    assert.equal(
        (await tiles()).some((tile) => tile.buttons.includes("Allow")),
        false,
    );
});

test(
    "a hidden tab keeps nothing live, and says again what is on screen when it shows",
    real,
    async () => {
        await sameAsScreen("the tiles live to start with");
        await page.evaluate(`
        Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
        document.dispatchEvent(new Event("visibilitychange"));
    `);
        await until(async () => (await serverPeeks())?.length === 0, "nothing live while hidden");
        await page.evaluate(`
        delete document.visibilityState;
        document.dispatchEvent(new Event("visibilitychange"));
    `);
        await sameAsScreen("the tiles live again");
    },
);

test("a missing archive peek list is retried without a live tile", real, async () => {
    assert.ok((await serverPeeks())?.length !== undefined);
    assert.equal(
        (await tiles()).some((tile) => tile.buttons.includes("Allow")),
        false,
    );
});

test("a duplicated archive tab keeps its own empty tile list", real, async () => {
    const tab = await inPage<string>(`return JSON.stringify(sessionStorage.getItem("pocket.tab"))`);
    const twin = await browsers.open(3);

    try {
        await twin.setViewport(VIEWPORTS.mobile);
        await twin.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
        assert.notEqual(
            JSON.parse(
                await twin.evaluate(`return JSON.stringify(sessionStorage.getItem("pocket.tab"))`),
            ),
            tab,
        );
        assert.equal(await serverPeeks(twin), undefined);
    } finally {
        await browsers.close(3);
    }
});

test("People and phone layout remain available with no archive tiles", real, async () => {
    await page.evaluate(`document.querySelector(".people-button").click()`);
    await until(
        async () =>
            (await inPage<boolean>(
                `return JSON.stringify(!!document.querySelector(".peek-strip"))`,
            )) === true,
        "the people strip",
    );
    await page.setViewport(VIEWPORTS.mobile);
    assert.equal(
        (await tiles(".peek-strip")).some((tile) => tile.buttons.includes("Allow")),
        false,
    );
    await page.setViewport(DESKTOP);
});

test("an archived session has no live tile to archive", real, async () => {
    assert.equal(
        (await tiles()).some((tile) => tile.id === Number(ids.working.at(-1))),
        false,
    );
    await assert.rejects(
        app.commands.updateSession(ids.working.at(-1)!, owner(app), { archived: true }),
        /read-only archive/,
    );
});

test("a reconnect does not revive archive execution tiles", real, async () => {
    assert.ok((await serverPeeks())?.length !== undefined);
    server.closeAllConnections();
    assert.equal(await serverPeeks(), undefined);
});

test("archive mode stays empty when peeks are toggled", real, async () => {
    await page.evaluate(`${SWITCH}.click()`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(
        (await tiles()).some((tile) => tile.buttons.includes("Allow")),
        false,
    );
    await page.evaluate(`${SWITCH}.click()`);
    await new Promise((resolve) => setTimeout(resolve, 300));
});

test("turned on with nothing to show, the column says what will show there", real, async () => {
    const { user, token } = app.config.addUser("Solo", "guest", [String(ids.open)]);
    const solo = await browsers.open(4);

    try {
        await solo.setViewport(DESKTOP);
        await solo.navigate(`${base}/login?token=${encodeURIComponent(token)}`);
        await peeksOnIn(solo);
        await solo.navigate(`${base}/s/${ids.open}`);
        await until(
            async () =>
                JSON.parse(
                    await solo.evaluate(
                        `return JSON.stringify(document.querySelector(".peeks .peeks-empty")?.textContent ?? "")`,
                    ),
                ).includes("Other sessions show here"),
            "the empty column's note",
        );
    } finally {
        await browsers.close(4);
        app.config.removeUser(user.id);
    }
});

test("nothing went wrong in the page", real, async () => {
    // The event stream the reconnect test cut off is the one error expected.
    const errors = page
        .logs()
        .filter(
            (entry) =>
                entry.level === "error" &&
                !(
                    entry.source?.includes("/api/events?") === true &&
                    entry.text.includes("ERR_INCOMPLETE_CHUNKED_ENCODING")
                ),
        );

    assert.deepEqual(errors, []);
});
