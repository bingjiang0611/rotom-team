// The built-in browser: addresses, keys, and plan mode; then, where this machine has Chromium, the page engine, Pi's
// browser tool, and the Browser panel's routes against a real browser and a small local site.
import {
    cleanUp,
    seedHistoricalSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser, profileFolder, snapOf } from "../src/server/browser/discovery.ts";
import { parseKeys } from "../src/server/browser/keys.ts";
import { SHOT_MAX } from "../src/server/browser/page.ts";
import { normalizeUrl } from "../src/server/browser/urls.ts";
import { presetOf, viewportFrom } from "../src/server/browser/viewport.ts";

/** A JPEG's size in pixels, from its first frame header. */
function jpegSize(data: string): { width: number; height: number } {
    const bytes = Buffer.from(data, "base64");

    for (let at = 2; at + 9 < bytes.length; at += 2 + bytes.readUInt16BE(at + 2)) {
        const marker = bytes[at + 1]!;

        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
            return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
        }
    }

    throw new Error("no JPEG frame header");
}

test("addresses as people type them become URLs the browser may open", () => {
    assert.equal(normalizeUrl("localhost:5173"), "http://localhost:5173/");
    assert.equal(normalizeUrl("127.0.0.1:3000/app?x=1"), "http://127.0.0.1:3000/app?x=1");
    assert.equal(normalizeUrl("192.168.1.4:8080"), "http://192.168.1.4:8080/");
    assert.equal(normalizeUrl("myserver:8080"), "http://myserver:8080/");
    assert.equal(normalizeUrl("example.com/docs"), "https://example.com/docs");
    assert.equal(normalizeUrl("https://example.com"), "https://example.com/");
    assert.equal(normalizeUrl("about:blank"), "about:blank");

    for (const refused of [
        "",
        "hello world",
        "word",
        "javascript:alert(1)",
        "chrome://settings",
        "view-source:https://example.com",
        "file:///etc/hosts",
        "/etc/hosts",
        "data:text/html,hi",
    ]) {
        assert.equal(normalizeUrl(refused), undefined, refused);
    }

    // Pi and the owner may open files on this machine.
    assert.equal(normalizeUrl("file:///etc/hosts", { trusted: true }), "file:///etc/hosts");
    assert.equal(
        normalizeUrl("./site/index.html", { trusted: true, cwd: "/work" }),
        "file:///work/site/index.html",
    );
    assert.equal(normalizeUrl("/tmp/a b.html", { trusted: true }), "file:///tmp/a%20b.html");
    assert.equal(normalizeUrl("data:text/html,hi", { trusted: true }), "data:text/html,hi");
    assert.equal(normalizeUrl("javascript:alert(1)", { trusted: true }), undefined);
    assert.equal(
        normalizeUrl("~/site/index.html", { trusted: true, windows: false }),
        `file://${homedir()}/site/index.html`,
    );

    // Backslashes and lone dots make no host.
    for (const refused of [
        ".\\index.html",
        "..\\site",
        "\\\\server\\share",
        ".",
        "..",
        "-bad-.com",
        "a..b.com",
    ]) {
        assert.equal(normalizeUrl(refused, { trusted: true, windows: false }), undefined, refused);
    }
});

test("on Windows, paths as Windows writes them open as files", () => {
    const windows = { trusted: true, windows: true, cwd: "C:\\work" };

    assert.equal(normalizeUrl("C:\\site\\index.html", windows), "file:///C:/site/index.html");
    assert.equal(normalizeUrl("c:/site/a b.html", windows), "file:///c:/site/a%20b.html");
    assert.equal(normalizeUrl(".\\index.html", windows), "file:///C:/work/index.html");
    assert.equal(normalizeUrl("..\\other\\index.html", windows), "file:///C:/other/index.html");
    assert.equal(normalizeUrl("./index.html", windows), "file:///C:/work/index.html");
    assert.equal(
        normalizeUrl("\\\\server\\share\\index.html", windows),
        "file://server/share/index.html",
    );
    assert.equal(normalizeUrl("file:///C:/site/index.html", windows), "file:///C:/site/index.html");
    // Web addresses read the same; only people who may open files get paths.
    assert.equal(normalizeUrl("localhost:5173", windows), "http://localhost:5173/");
    assert.equal(normalizeUrl("C:\\site\\index.html", { windows: true }), undefined);
    assert.equal(normalizeUrl(".\\index.html", { windows: true }), undefined);
});

test("a snap browser comes last, and keeps its profile where a snap may write", () => {
    const dir = mkdtempSync(join(root, "snap-"));

    {
        const snapBin = join(dir, "snap", "bin");
        const bin = join(dir, "bin");
        const other = join(dir, "other");

        for (const folder of [snapBin, bin, other]) {
            mkdirSync(folder, { recursive: true });
        }

        const executable = (path: string, text: string) => {
            writeFileSync(path, text);
            chmodSync(path, 0o755);
        };

        // Ubuntu's chromium-browser: a script that runs the snap.
        executable(
            join(bin, "chromium-browser"),
            `#!/bin/sh\nif ! [ -x ${snapBin}/chromium ]; then echo "install the snap" >&2; exit 1; fi\nexec ${snapBin}/chromium "$@"\n`,
        );
        executable(join(snapBin, "chromium"), "\u007fELF");
        executable(join(other, "google-chrome-stable"), "\u007fELF");
        const env = (path: string) => ({ PATH: path });
        const only = { snapBin, places: [] };

        assert.deepEqual(snapOf(join(bin, "chromium-browser"), snapBin), {
            name: "chromium",
            command: join(snapBin, "chromium"),
        });
        assert.deepEqual(snapOf(join(snapBin, "chromium"), snapBin), {
            name: "chromium",
            command: join(snapBin, "chromium"),
        });
        assert.equal(snapOf(join(other, "google-chrome-stable"), snapBin), undefined);

        if (process.platform === "linux") {
            // Chrome installed otherwise wins, though the snap's script comes first on the PATH.
            assert.equal(
                findBrowser(env(`${bin}:${other}`), only),
                join(other, "google-chrome-stable"),
            );
            // Only the snap: its own command, not the script.
            const onlySnap = findBrowser(env(bin), only);

            assert.ok(
                onlySnap === join(snapBin, "chromium") || onlySnap?.includes("ms-playwright"),
                String(onlySnap),
            );
        }

        // Its profile: in the snap's own folder, one per data folder, and never in a hidden folder of the home folder.
        const profile = profileFolder(
            join(snapBin, "chromium"),
            join(homedir(), ".pi-pocket"),
            snapBin,
        );

        assert.match(
            profile,
            new RegExp(`^${homedir()}/snap/chromium/common/pi-pocket/[0-9a-f]{12}$`),
        );
        assert.notEqual(
            profile,
            profileFolder(join(snapBin, "chromium"), join(homedir(), ".pi-pocket-other"), snapBin),
        );
        assert.equal(
            profileFolder(join(other, "google-chrome-stable"), "/data", snapBin),
            "/data/browser/profile",
        );
    }
});

test("viewports and keys are read the way people and Pi write them", () => {
    assert.deepEqual(viewportFrom("mobile"), { width: 390, height: 844, scale: 2, mobile: true });
    assert.deepEqual(viewportFrom(" Desktop "), {
        width: 1280,
        height: 800,
        scale: 1,
        mobile: false,
    });
    assert.deepEqual(viewportFrom("1024x768"), {
        width: 1024,
        height: 768,
        scale: 1,
        mobile: false,
    });
    assert.deepEqual(viewportFrom("360×640"), { width: 360, height: 640, scale: 1, mobile: true });
    assert.deepEqual(viewportFrom({ width: 99999, height: 10, scale: 9, mobile: true }), {
        width: 3840,
        height: 240,
        scale: 3,
        mobile: true,
    });
    assert.equal(viewportFrom("huge"), undefined);
    assert.equal(viewportFrom({ width: "1" }), undefined);
    assert.equal(presetOf(viewportFrom("tablet")!), "tablet");
    assert.equal(presetOf(viewportFrom("1024x768")!), undefined);

    assert.deepEqual(parseKeys("Enter"), { key: "Enter", modifiers: 0 });
    assert.deepEqual(parseKeys("esc"), { key: "Escape", modifiers: 0 });
    assert.deepEqual(parseKeys("Control+Shift+a"), { key: "a", modifiers: 10 });
    assert.deepEqual(parseKeys("Meta+Enter"), { key: "Enter", modifiers: 4 });
    assert.deepEqual(parseKeys("Shift++"), { key: "+", modifiers: 8 });
    assert.throws(() => parseKeys("Hyper+a"), /Unknown modifier/);
    assert.throws(() => parseKeys("Launch"), /Unknown key/);
});

// ─── With a real browser ────────────────────────────────────────────────

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

const PAGE = `<!doctype html><html><head><title>Smoke test</title><meta name="viewport" content="width=device-width"></head><body>
<header><nav><a href="/two">Second page</a> <a href="/two" target="_blank">Popup</a></nav></header>
<main><h1>Hello</h1><p>Some intro text for the page.</p>
<form onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'Sent ' + document.getElementById('email').value + ' ' + document.getElementById('pick').value">
<label for="email">Email</label><input id="email" type="email" placeholder="you@example.com" value="old@example.com">
<select id="pick"><option value="a">Apple</option><option value="b">Banana</option></select>
<button type="submit">Send</button></form>
<div id="out"></div>
<div id="fancy" style="cursor:pointer" onclick="this.textContent='clicked div'">Fancy div</div>
<button id="confirm" onclick="this.textContent = confirm('Sure?') ? 'yes' : 'no'">Ask</button>
<div style="height:3000px"></div><p id="bottom">The end</p>
</main><script>console.log("hello", {a: 1}); console.error("boom"); setTimeout(() => { throw new Error("late failure") }, 10);</script></body></html>`;

let site: Server;
let base = "";

before(async () => {
    site = createServer((request, response) => {
        // A request that never ends, as some pages have (a stream, a stuck image).
        if (request.url === "/never") {
            return;
        }

        response.writeHead(200, { "content-type": "text/html" });

        if (request.url === "/hang") {
            response.end(
                `<title>Hang</title><img src="/never"><button onclick="this.textContent='pressed'">Press</button>`,
            );
        } else {
            response.end(request.url === "/two" ? "<title>Two</title><h1>Second</h1>" : PAGE);
        }
    });
    await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
});

after(() => {
    site.close();
    cleanUp();
});

test(
    "the engine reads, clicks, types in, and streams a real page, and opens it again where it was",
    real,
    async () => {
        const saved = new Map<number, { url?: string }>();
        const browsers = new Browsers({
            dataDir: mkdtempSync(join(root, "engine-")),
            load: async (id) => saved.get(id),
            save: (id, value) => saved.set(id, value),
        });
        const states: { url: string }[] = [];

        browsers.subscribe((_, state) => states.push(state));

        try {
            const page = await browsers.open(1);

            assert.deepEqual(await page.navigate(`${base}/`), { status: 200 });
            await until(() => page.title === "Smoke test", "the title");
            // Force a non-overlay gutter: CDP excludes it from captures regardless of OS preferences.
            await page.evaluate(
                "const style=document.createElement('style'); style.textContent='html { overflow-y:scroll; } ::-webkit-scrollbar { width:17px; height:17px; }'; document.head.append(style); 'ready'",
            );

            const outline = await page.snapshot();

            for (const line of [
                'link "Second page" -> /two',
                "# Hello",
                'textbox "Email" = "old@example.com" [email]',
                'combobox = "Apple" options: Apple | Banana',
                'button "Send"',
                'clickable "Fancy div"',
            ]) {
                assert.ok(
                    outline.lines.includes(line),
                    `the snapshot has ${line}:\n${outline.lines}`,
                );
            }

            assert.match(outline.lines, /Some intro text for the page\./);
            assert.ok(outline.scrollHeight > 3000);

            // Typing replaces what a field holds, also in an email field a script cannot select.
            assert.equal(
                await page.type({ label: "Email" }, "tanner@example.com"),
                'input#email "old@example.com"',
                "a label finds its field",
            );
            assert.equal(await page.select({ selector: "#pick" }, "banana"), "Banana");
            const ref = /\[(e\d+)\] button "Send"/.exec(outline.lines)![1]!;

            assert.equal((await page.click({ ref })).label, 'button "Send"');
            assert.equal(
                await page.evaluate("document.getElementById('out').textContent"),
                "Sent tanner@example.com b",
            );
            await page.click({ label: "Fancy div" });
            assert.equal(
                await page.evaluate("return document.getElementById('fancy').textContent"),
                "clicked div",
            );
            // Dialogs are accepted, and said so.
            await page.click({ selector: "#confirm" });
            assert.equal(
                await page.evaluate("document.getElementById('confirm').textContent"),
                "yes",
            );

            assert.equal(
                await page.evaluate("const r = await Promise.resolve(4); return r * 2"),
                "8",
            );
            assert.equal(await page.evaluate("let n = 1; n"), "1");
            assert.equal(
                await page.evaluate("let n = 2; n"),
                "2",
                "names can be declared again, as in DevTools",
            );
            assert.match(
                await page.evaluate("({ h1: document.querySelector('h1') })"),
                /"h1": "<h1>Hello<\/h1>"/,
            );
            await assert.rejects(page.evaluate("nope()"), /ReferenceError: nope is not defined/);
            await assert.rejects(
                page.click({ ref: "e999" }),
                /No element e999 on the page now: take a new snapshot/,
            );

            const logs = page.logs().map((entry) => `${entry.level}: ${entry.text}`);

            for (const line of [
                "log: hello {a: 1}",
                "error: boom",
                "error: Uncaught Error: late failure",
                "dialog: confirm: Sure?",
            ]) {
                assert.ok(logs.includes(line), `${line} in ${logs.join(" | ")}`);
            }

            assert.equal(browsers.state(1).errors, 2);
            // Clearing is a change the panel sees, so it fetches the empty console.
            const before = browsers.state(1).logs;

            page.clearLogs();
            assert.deepEqual(
                [page.logs(), browsers.state(1).errors, browsers.state(1).logs > before],
                [[], 0, true],
            );

            // The panel's frames are JPEGs, and its taps land where they are shown.
            const frame = (await page.frame(0))!;

            assert.deepEqual([...frame.data.subarray(0, 3)], [0xff, 0xd8, 0xff]);
            const viewportGeometry = JSON.parse(
                await page.evaluate(
                    "JSON.stringify({innerWidth,innerHeight,clientWidth:document.documentElement.clientWidth,visualWidth:visualViewport.width,visualHeight:visualViewport.height,scale:visualViewport.scale})",
                ),
            );

            assert.deepEqual(
                [frame.width, frame.height],
                [1263, 800],
                JSON.stringify({ viewportGeometry, jpeg: jpegSize(frame.data.toString("base64")) }),
            );
            assert.equal(viewportGeometry.innerWidth, 1280);
            assert.equal(viewportGeometry.visualWidth, 1263);
            assert.deepEqual(jpegSize(frame.data.toString("base64")), {
                width: frame.width,
                height: frame.height,
            });
            await page.evaluate(
                "document.getElementById('fancy').textContent = 'Fancy div'; scrollTo(0, 0)",
            );
            const box = JSON.parse(
                await page.evaluate(
                    "JSON.stringify(document.getElementById('fancy').getBoundingClientRect())",
                ),
            ) as { x: number; y: number; width: number; height: number };

            await page.input([{ type: "click", x: box.x + 5, y: box.y + box.height / 2 }]);
            assert.equal(
                await page.evaluate("document.getElementById('fancy').textContent"),
                "clicked div",
            );
            await page.input([{ type: "wheel", x: 100, y: 100, dx: 0, dy: 400 }]);
            await until(async () => Number(await page.evaluate("scrollY")) > 0, "the scroll");

            const edge = JSON.parse(
                await page.evaluate(
                    "const edge=document.createElement('button'); edge.id='capture-edge'; edge.style.cssText='position:fixed;right:20px;top:20px;width:12px;height:24px;padding:0'; edge.onclick=()=>edge.dataset.clicked='yes'; document.body.append(edge); const r=edge.getBoundingClientRect(); JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})",
                ),
            );
            const shot = await page.screenshot();

            assert.deepEqual([shot.width, shot.height], [1263, 800]);
            assert.deepEqual(jpegSize(shot.data), {
                width: Math.round(shot.width * shot.scale),
                height: Math.round(shot.height * shot.scale),
            });
            assert.ok(
                Buffer.from(shot.data, "base64")
                    .subarray(0, 2)
                    .equals(Buffer.from([0xff, 0xd8])),
            );
            assert.equal(jpegSize(shot.data).height, 800);
            assert.equal(shot.scale, 1);
            const pixels = jpegSize(shot.data);

            // The panel maps a displayed image point through its declared dimensions.
            await page.input([
                {
                    type: "click",
                    x: (edge.x / pixels.width) * shot.width,
                    y: (edge.y / pixels.height) * shot.height,
                },
            ]);
            assert.equal(
                await page.evaluate("document.getElementById('capture-edge').dataset.clicked"),
                "yes",
            );
            await page.setViewport({ width: 1280, height: 800, scale: 2, mobile: false });
            const dense = await page.screenshot();

            assert.deepEqual([dense.width, dense.height, dense.scale], [1263, 800, 1]);
            assert.deepEqual(jpegSize(dense.data), { width: 1263, height: 800 });
            await page.setViewport({ width: 1280, height: 800, scale: 1, mobile: false });
            await page.evaluate(
                "const noGutter=document.createElement('style'); noGutter.textContent='::-webkit-scrollbar { width:0px; height:0px; }'; document.head.append(noGutter); 'ready'",
            );
            const noGutter = await page.screenshot();

            assert.deepEqual([noGutter.width, noGutter.height], [1280, 800]);
            assert.deepEqual(jpegSize(noGutter.data), { width: 1280, height: 800 });

            await page.setViewport({ width: 2800, height: 800, scale: 1, mobile: false });
            const wide = await page.screenshot();

            assert.equal(wide.width, 2800);
            assert.equal(jpegSize(wide.data).width, 2000);
            assert.equal(Math.round(wide.width * wide.scale), 2000);
            await page.setViewport({ width: 1280, height: 800, scale: 1, mobile: false });

            // A huge page comes back small enough for a model to take: too large an image breaks the conversation.
            await page.evaluate("document.body.style.cssText = 'width: 2600px; height: 6000px'; 1");
            const whole = await page.screenshot({ fullPage: true });
            const image = jpegSize(whole.data);

            assert.ok(
                whole.width >= 2600 && whole.height >= 6000,
                `${whole.width}×${whole.height}`,
            );
            assert.ok(Math.max(image.width, image.height) <= SHOT_MAX, JSON.stringify(image));
            assert.ok(image.height > SHOT_MAX * 0.95, JSON.stringify(image));
            assert.equal(Math.round(whole.height * whole.scale), image.height);
            await page.evaluate("document.body.style.cssText = ''; scrollTo(0, 0); 1");

            // A link to a new tab opens in this page: there is one page per conversation.
            await page.click({ label: "Popup" });
            await until(() => page.url === `${base}/two`, "the popup's page");
            assert.equal(await page.go(-1), true);
            await until(() => page.url === `${base}/`, "going back");
            // A web page cannot use a new tab to open a file here, which it could not open itself.
            await page.evaluate("window.open('file:///etc/hosts'); 1");
            // Chromium refuses it by itself; the page's own rule refuses it too, should a tab open anyway.
            await until(
                () =>
                    page
                        .logs()
                        .some((entry) =>
                            /^(Not allowed to load local resource: |A new tab for )file:\/\/\/etc\/hosts/.test(
                                entry.text,
                            ),
                        ),
                "the refused tab",
            );
            await new Promise((done) => setTimeout(done, 500));
            assert.equal(page.url, `${base}/`);

            await page.setViewport(viewportFrom("mobile")!);
            assert.equal(await page.evaluate("innerWidth"), "390");
            assert.match(await page.evaluate("navigator.userAgent"), /Mobile Safari/);
            assert.equal(browsers.state(1).preset, "mobile");

            // A click on a page still loading something that never ends waits for nothing the click did not start.
            assert.equal((await page.navigate(`${base}/hang`, { timeoutMs: 1000 })).slow, true);
            const started = Date.now();

            await page.click({ label: "Press" });
            assert.ok(Date.now() - started < 3000, `the click took ${Date.now() - started} ms`);
            assert.equal(
                await page.evaluate("document.querySelector('button').textContent"),
                "pressed",
            );

            // A tab that asks with a frame number from before a restart gets the newest frame, not a long wait.
            const fresh = await page.frame(Number.MAX_SAFE_INTEGER);

            assert.ok(fresh !== undefined && fresh.seq > 0);

            // A server that never answers keeps the browser from answering too: the wait ends at its time, and says so.
            const silent = Date.now();

            assert.deepEqual(await page.navigate(`${base}/never`, { timeoutMs: 1000 }), {
                slow: true,
            });
            await page.stop();
            assert.deepEqual(await page.navigate(`${base}/never`, { wait: false }), {});
            assert.ok(Date.now() - silent < 6000, `took ${Date.now() - silent} ms`);
            await page.stop();

            const refused = await page.navigate("http://127.0.0.1:9/");

            assert.match(refused.error ?? "", /ERR_CONNECTION_REFUSED|ERR_UNSAFE_PORT/);

            await page.navigate(`${base}/two`);
            await until(() => saved.get(1)?.url === `${base}/two`, "the address saved");
            await browsers.close(1);
            assert.equal(browsers.state(1).open, false);
            const again = await browsers.open(1);

            assert.equal(again.url, `${base}/two`, "a page opens again where it was");
            assert.equal(again.viewport.width, 390, "at the size it had");
            // Opened to go elsewhere, it skips loading the old address, but keeps the size.
            await browsers.close(1);
            const blank = await browsers.open(1, { restore: false });

            assert.deepEqual([blank.url, blank.viewport.width], ["about:blank", 390]);
            assert.ok(
                states.some((state) => state.url === `${base}/two`),
                "changes were announced",
            );
        } finally {
            await browsers.closeAll({ final: true });
        }
    },
);

test("a command sent while a navigation swaps the page waits for it", real, async () => {
    const browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "swap-")),
        load: async () => undefined,
        save: () => {},
    });

    try {
        const page = await browsers.open(1, { restore: false });

        // Across sites (to the test site and back to about:blank), Chromium moves the page to a new process and for a
        // moment refuses commands. A reload or stop sent right then used to fail: "Not attached to an active page".
        for (let round = 0; round < 3; round++) {
            await page.navigate("about:blank");
            await page.navigate(`${base}/`);
            await page.go(-1, { wait: false });
            await page.reload({ wait: false });
            await page.navigate(`${base}/two`, { wait: false });
            await page.stop();
        }
    } finally {
        await browsers.closeAll({ final: true });
    }
});

test("legacy archive rejects browser tool dispatch without opening a page", async () => {
    const app = await openApp(scriptedModel(), join(root, "browser-archive"));

    try {
        const id = await seedHistoricalSession(app);

        assert.equal(app.browsers.page(Number(id)), undefined);
        await assert.rejects(
            app.commands.submit(id, owner(app), {
                text: "open the test page",
                requestId: "browser-archive",
            }),
            /read-only archive/,
        );
        assert.equal(app.browsers.page(Number(id)), undefined);
    } finally {
        await app.close();
    }
});

test("archive browser requests are rejected without probing browser availability", async () => {
    const app = await openApp(scriptedModel(), join(root, "browser-none-"));

    try {
        const id = await seedHistoricalSession(app);

        await assert.rejects(
            app.commands.submit(id, owner(app), { text: "look", requestId: "browser-none" }),
            /read-only archive/,
        );
        assert.equal(app.browsers.page(Number(id)), undefined);
    } finally {
        await app.close();
    }
});
