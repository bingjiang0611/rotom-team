// Delivered Markdown links use the conversation's files, not the /s page route. Real HTTP and browser fixtures,
// synthetic accounts only; downloads retain workspace and private-data boundaries.
import {
    type App,
    cleanUp,
    newSession,
    openApp,
    root,
    say,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { createHandler } from "../src/server/http.ts";

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base: string;
let id: ConversationId;
let scoped: ReturnType<App["config"]["addUser"]>;
let viewer: ReturnType<App["config"]["addUser"]>;
let guest: ReturnType<App["config"]["addUser"]>;
let elsewhere: ReturnType<App["config"]["addUser"]>;
const folder = "changelog-2026-10-13";
const pdf = "%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n";
const markup = "<h1>Delivered page</h1><script>parent.deliveryScriptRan = true</script>";
const markdown = "# Delivered notes\n\nEvidence is available.\n";
const chromium = findBrowser();

const file = (name: string) => `${folder}/${name}`;
const get = (path: string, token = app.config.ownerToken, route = "download", session = id) =>
    fetch(`${base}/api/c/${session}/${route}?path=${encodeURIComponent(path)}`, {
        headers: { authorization: `Bearer ${token}` },
    });
const inPage = async <T>(script: string): Promise<T> =>
    JSON.parse(await page.evaluate(script)) as T;

before(async () => {
    app = await openApp(scriptedModel());
    id = await newSession(app);
    const other = await newSession(app);

    scoped = app.config.addUser("Scoped", "guest", [String(id)]);
    viewer = app.config.addUser("Viewer", "viewer", [String(id)]);
    guest = app.config.addUser("Guest", "guest");
    elsewhere = app.config.addUser("Elsewhere", "guest", [String(other)]);
    mkdirSync(join(work, folder), { recursive: true });
    writeFileSync(join(work, file("changelog.pdf")), pdf);
    writeFileSync(join(work, file("changelog.html")), markup);
    writeFileSync(join(work, file("CHANGELOG.md")), markdown);
    writeFileSync(join(work, file("证据 空格.md")), markdown);
    writeFileSync(join(work, file("archive.bin")), Buffer.from([0, 1, 2, 3]));
    writeFileSync(join(root, "outside.txt"), "outside");
    symlinkSync(join(root, "outside.txt"), join(work, file("escape.txt")));
    writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, "private.txt"), "private");
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
    await browsers?.closeAll();
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app?.close();
    cleanUp();
});

test("delivered PDFs open inline; HTML, Markdown and binary files download without app execution", async () => {
    const response = await get(file("changelog.pdf"));

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/pdf");
    assert.match(response.headers.get("content-disposition")!, /^inline;/);
    assert.equal(await response.text(), pdf);
    const view = await get(file("changelog.pdf"), app.config.ownerToken, "view");

    assert.equal((await view.json()).kind, "binary", "ASCII-only PDFs are not source text");

    for (const [name, content] of [
        ["changelog.html", markup],
        ["CHANGELOG.md", markdown],
        ["证据 空格.md", markdown],
    ]) {
        const download = await get(file(name!));

        assert.equal(download.status, 200);
        assert.equal(download.headers.get("content-type"), "application/octet-stream");
        assert.match(
            download.headers.get("content-disposition")!,
            /^attachment; filename\*=UTF-8''/,
        );
        assert.equal(
            download.headers.get("content-security-policy"),
            "sandbox; default-src 'none'",
        );
        assert.equal(download.headers.get("x-content-type-options"), "nosniff");
        assert.equal(download.headers.get("cache-control"), "private, no-store");
        assert.equal(await download.text(), content);
    }

    assert.deepEqual(
        Buffer.from(await (await get(file("archive.bin"))).arrayBuffer()),
        Buffer.from([0, 1, 2, 3]),
    );
    assert.equal(
        (await get(file("changelog.pdf"), app.config.ownerToken, "file")).status,
        415,
        "the inline image route remains image-only",
    );
    assert.equal((await get("missing.pdf")).status, 404);
    assert.equal((await get(folder)).status, 404);
    assert.equal((await get("")).status, 400);
});

test("downloads require sign-in/session access and retain realpath and private-data restrictions", async () => {
    assert.equal(
        (await fetch(`${base}/api/c/${id}/download?path=${file("changelog.pdf")}`)).status,
        401,
    );
    assert.equal((await get(file("changelog.pdf"), elsewhere.token)).status, 404);

    for (const member of [scoped, viewer]) {
        assert.equal((await get(file("changelog.pdf"), member.token)).status, 200);
        assert.equal((await get("../outside.txt", member.token)).status, 404);
        assert.equal((await get(join(root, "outside.txt"), member.token)).status, 404);
        assert.equal((await get(file("escape.txt"), member.token)).status, 404);
    }

    for (const path of [
        join(process.env.PI_CODING_AGENT_DIR!, "private.txt"),
        join(app.dataDir, "config.json"),
    ]) {
        assert.equal((await get(path, guest.token)).status, 404);
        assert.equal((await get(path)).status, 200, "owner rights remain unchanged");
    }
});

test(
    "real Markdown delivery links open files, preserve web/anchor links and cannot forge viewer marks",
    {
        skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
    },
    async () => {
        await say(
            app,
            id,
            [
                `[PDF](${file("changelog.pdf")})`,
                `[HTML](${file("changelog.html")})`,
                `[Notes](${file("CHANGELOG.md")})`,
                `[Encoded](${folder}/%E8%AF%81%E6%8D%AE%20%E7%A9%BA%E6%A0%BC.md)`,
                `[Absolute](file://${join(work, file("CHANGELOG.md"))})`,
                `[Web](https://example.com/notes.md)`,
                `[Mail](mailto:reader@example.com)`,
                `[Anchor](#details)`,
                `[Session](/s/${id})`,
                '<a href="https://example.com/" data-path="forged.md">Forged</a>',
            ].join("\n\n"),
        );
        browsers = new Browsers({
            dataDir: mkdtempSync(join(root, "delivery-browser-")),
            load: async () => undefined,
            save: () => {},
        });
        page = await browsers.open(1);
        await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
        await page.navigate(`${base}/s/${id}`);
        await until(
            async () =>
                inPage<boolean>(
                    `return JSON.stringify([...document.querySelectorAll('.md a')].some(a => a.textContent === 'PDF'))`,
                ),
            "delivery links rendered",
            20_000,
        );
        const links = await inPage<Record<string, { href: string; path: string | null }>>(`
        return JSON.stringify(Object.fromEntries([...document.querySelectorAll('.md a')].map(a =>
            [a.textContent, {href: a.getAttribute('href'), path: a.getAttribute('data-path')}])))
    `);

        assert.equal(
            links.PDF!.href,
            `/api/c/${id}/download?path=${encodeURIComponent(file("changelog.pdf"))}`,
        );
        assert.equal(links.PDF!.path, null, "PDF opens in the browser, not the source viewer");
        assert.equal(links.HTML!.path, file("changelog.html"));
        assert.equal(links.Encoded!.path, file("证据 空格.md"));
        assert.equal(links.Absolute!.path, join(work, file("CHANGELOG.md")));
        assert.equal(links.Web!.href, "https://example.com/notes.md");
        assert.equal(links.Mail!.href, "mailto:reader@example.com");
        assert.equal(links.Anchor!.href, "#details");
        assert.equal(links.Session!.href, `/s/${id}`);
        assert.equal(links.Forged!.path, null);
        const pdfResult = await inPage<{ status: number; body: string }>(`
        const link = [...document.querySelectorAll('.md a')].find(a => a.textContent === 'PDF');
        const response = await fetch(link.href);
        return JSON.stringify({status: response.status, body: await response.text()});
    `);

        assert.deepEqual(pdfResult, { status: 200, body: pdf });
        await page.evaluate(`
        const link = [...document.querySelectorAll('.md a')].find(a => a.textContent === 'Notes');
        link.focus();
    `);
        await page.press("Enter");
        await until(
            async () =>
                inPage<boolean>(
                    `return JSON.stringify(document.querySelector('.file-viewer .md')?.textContent.includes('Delivered notes') === true)`,
                ),
            "Markdown file preview",
        );
        assert.equal(
            await inPage<string>(`return JSON.stringify(location.pathname)`),
            `/s/${id}`,
            "no false session navigation",
        );
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(document.querySelector('.file-tools a').getAttribute('href'))`,
            ),
            `/api/c/${id}/download?path=${encodeURIComponent(join(work, file("CHANGELOG.md")))}`,
        );
        await page.evaluate(`
        (await import('/store.js')).closeSheet();
        [...document.querySelectorAll('.md a')].find(a => a.textContent === 'HTML').click();
    `);
        await until(
            async () =>
                inPage<boolean>(
                    `return JSON.stringify(document.querySelector('.file-viewer .file-view')?.textContent.includes('Delivered page') === true)`,
                ),
            "HTML source viewer",
        );
        await page.evaluate(`
        [...document.querySelectorAll('.file-tools button')].find(b => b.textContent.trim() === 'Preview').click();
    `);
        await until(
            async () =>
                inPage<boolean>(
                    `return JSON.stringify(document.querySelector('.file-viewer iframe') !== null)`,
                ),
            "sandboxed HTML preview",
        );
        assert.equal(
            await inPage<string | null>(
                `return JSON.stringify(document.querySelector('.file-viewer iframe').getAttribute('sandbox'))`,
            ),
            "allow-same-origin",
        );
        assert.equal(
            await inPage<boolean>(`return JSON.stringify(window.deliveryScriptRan === true)`),
            false,
        );
        await page.evaluate(
            `(await import('/ui.js')).openFile(${JSON.stringify(file("changelog.pdf"))})`,
        );
        await until(
            async () =>
                inPage<boolean>(
                    `return JSON.stringify(document.querySelector('.file-tools a')?.textContent.trim() === 'Open PDF')`,
                ),
            "PDF viewer open action",
        );
        const pdfHref = await inPage<string>(
            `return JSON.stringify(document.querySelector('.file-tools a').getAttribute('href'))`,
        );

        await page.navigate(base + pdfHref);
        await until(
            async () =>
                inPage<boolean>(
                    `return JSON.stringify(document.contentType === 'application/pdf')`,
                ),
            "the browser PDF document",
        );
        assert.match(
            await inPage<string>(`return JSON.stringify(location.pathname)`),
            new RegExp(`/api/c/${id}/download$`),
        );
    },
);
