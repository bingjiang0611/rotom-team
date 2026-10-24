// Isolated real Chromium and production web modules: no app data, account or model process.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Chromium } from "../../src/server/browser/cdp.ts";
import { findBrowser } from "../../src/server/browser/discovery.ts";
import { serveFile, VENDOR, WEB } from "../../src/server/http/assets.ts";

export async function withMarkdownPage<T>(
    task: (evaluate: (expression: string) => Promise<any>) => Promise<T>,
): Promise<T> {
    const executable = findBrowser();

    assert.ok(executable, "Markdown browser measurement unavailable: Chromium not installed");
    const directory = mkdtempSync(join(tmpdir(), "rotom-markdown-"));
    const importMap = readFileSync(join(WEB, "index.html"), "utf8").match(
        /<script type="importmap">[\s\S]*?<\/script>/,
    )![0];
    const server = createServer((request, response) => {
        const path = new URL(request.url!, "http://fixture.local").pathname;

        if (path === "/") {
            response.setHeader("content-type", "text/html");
            response.end(`<!doctype html><html><head>${importMap}</head><body></body></html>`);

            return;
        }

        const file =
            path === "/fixture.js"
                ? fileURLToPath(new URL("./markdown-page.js", import.meta.url))
                : path.startsWith("/vendor/")
                  ? VENDOR[path.slice(8)]
                  : /^\/[\w-]+\.js$/.test(path)
                    ? join(WEB, path.slice(1))
                    : undefined;

        if (!file) {
            response.writeHead(404).end();

            return;
        }

        void serveFile(request, response, file).catch((error) => {
            response.writeHead(500).end(String(error));
        });
    });
    let browser: Chromium | undefined;

    try {
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        browser = await Chromium.launch(executable, directory, []);
        const cdp = browser.connection;
        const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
        const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
        const loaded = new Promise<void>((resolve) => {
            cdp.listen(sessionId, (method) => {
                if (method === "Page.loadEventFired") {
                    resolve();
                }
            });
        });

        await cdp.send("Page.enable", {}, sessionId);
        await cdp.send(
            "Page.navigate",
            { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/` },
            sessionId,
        );
        await loaded;

        const evaluate = async (expression: string) => {
            const answer = await cdp.send(
                "Runtime.evaluate",
                { expression, awaitPromise: true, returnByValue: true },
                sessionId,
                20_000,
            );

            assert.equal(
                answer.exceptionDetails,
                undefined,
                JSON.stringify(answer.exceptionDetails),
            );

            return answer.result.value;
        };

        await evaluate("import('/fixture.js').then(() => true)");

        return await task(evaluate);
    } finally {
        browser?.kill();
        await browser?.exited;
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(directory, { recursive: true, force: true });
    }
}
