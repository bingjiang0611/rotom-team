/**
 * A native message shows as it goes: Enter puts it in the transcript at once, marked as sending, and only the
 * server's entry with the same browser request id takes that row's place. A send that fails takes the row away and
 * leaves the text in the box. Real Chromium, real rotom kernel, loopback model, no model account.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { PocketApp } from "../src/server/app.ts";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { createHandler } from "../src/server/http.ts";
import { cleanUp, owner, root, until, work } from "./helpers.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "Chromium not installed" : false,
    timeout: 90_000,
};

after(cleanUp);

test("a native message shows at once, and its own entry takes its place", real, async () => {
    // Waits before its answer, so the sending row is on screen before the entry can be.
    const model = createServer(async (request, response) => {
        for await (const _ of request) {
            // Read the request before answering.
        }

        const emit = (delta: object, finish: string | null = null) =>
            response.write(
                `data: ${JSON.stringify({ id: "sending", object: "chat.completion.chunk", created: 1, model: "sending", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
            );

        response.writeHead(200, { "Content-Type": "text/event-stream" });
        await new Promise((resolve) => setTimeout(resolve, 300));
        emit({ role: "assistant" });
        emit({ content: "Received." });
        emit({}, "stop");
        response.end("data: [DONE]\n\n");
    });

    model.listen(0, "127.0.0.1");
    await once(model, "listening");
    const baseUrl = `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`;
    const cwd = realpathSync(work);
    const app = await PocketApp.open({
        dataDir: join(realpathSync(root), "sending-ui-data"),
        defaultCwd: cwd,
        kernel: true,
        supervised: false,
        browser: null,
        log: () => {},
        configureUserModels: (models, user) =>
            models.registerNativeProvider({
                id: "openai",
                name: "Loopback sending model",
                auth: {
                    apiKey: {
                        name: "Synthetic",
                        resolve: async () => ({
                            auth: { apiKey: `sending:${user.id}` },
                            source: "test",
                        }),
                    },
                },
                getModels: () => [
                    {
                        id: "sending",
                        name: "sending",
                        api: "openai-completions",
                        provider: "openai",
                        baseUrl,
                        reasoning: false,
                        input: ["text"],
                        contextWindow: 200_000,
                        maxTokens: 4096,
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    },
                ],
                stream: () => {
                    throw new Error("rotom sessions never run on the Durable path");
                },
                streamSimple: () => {
                    throw new Error("rotom sessions never run on the Durable path");
                },
            }),
    });
    const server: Server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "sending-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    const box = ".composer textarea";

    try {
        await app.hello(owner(app));
        const { id } = await app.commands.createSession(owner(app), {
            backend: "rotom",
            cwd,
        });
        const page = await browsers.open(1);
        const check = async (expression: string) => (await page.evaluate(expression)) === "true";
        const rows = (text: string) =>
            `[...document.querySelectorAll(".transcript .user-row")].filter((row) => row.textContent.includes("${text}"))`;

        await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
        await page.navigate(`${base}/s/${id}`);
        await until(
            () => check(`Boolean(document.querySelector("${box}:not([disabled])"))`),
            "session",
            30_000,
        );
        // Note every message row marked as sending that ever shows the text.
        await page.evaluate(`window.__sending = [];
            new MutationObserver(() => {
                for (const row of document.querySelectorAll(".transcript .user-row.sending")) {
                    if (!window.__sending.includes(row.textContent)) window.__sending.push(row.textContent);
                }
            }).observe(document, { subtree: true, childList: true, characterData: true }); true`);

        await page.type({ selector: box }, "first-words", { submit: true });
        await until(
            () => check(`window.__sending.some((text) => text.includes("first-words"))`),
            "the sending row",
        );
        await until(
            () =>
                check(
                    `${rows("first-words")}.length === 1 && !document.querySelector(".user-row.sending")`,
                ),
            "the entry in place of the sending row",
            30_000,
        );
        assert.equal(
            await check(
                `const { store } = await import('/store.js'); store.state.view.order.some((id) => { const entry = store.state.view.entries.get(id); return entry?.kind === 'user' && entry.text === 'first-words' && typeof entry.requestId === 'string'; })`,
            ),
            true,
            "the native entry carries the browser request id",
        );
        // The entry replaced the row in place: it does not slide in a second time.
        assert.equal(await check(`!${rows("first-words")}[0].classList.contains("enter")`), true);
        await until(
            () =>
                check(
                    `const { store } = await import('/store.js'); !store.state.view.live?.busy && store.state.view.order.some((id) => store.state.view.entries.get(id)?.kind === 'assistant')`,
                ),
            "the answer",
            30_000,
        );

        // A send that fails (here the network, after a moment): the row goes, the text stays in the box.
        await page.evaluate(`const original = window.fetch;
            window.fetch = (input, init) => String(input).includes("/submit")
                ? new Promise((_, reject) => setTimeout(() => reject(new TypeError("offline")), 300))
                : original(input, init);
            true`);
        await page.type({ selector: box }, "second-words", { submit: true });
        await until(
            () => check(`window.__sending.some((text) => text.includes("second-words"))`),
            "the failed send's row",
        );
        await until(
            () => check(`!document.querySelector(".user-row.sending")`),
            "the failed row gone",
        );
        assert.equal(await check(`${rows("second-words")}.length === 0`), true);
        assert.equal(
            await check(`document.querySelector("${box}").value === "second-words"`),
            true,
        );
    } finally {
        await browsers.closeAll({ final: true });
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        model.closeAllConnections();
        await new Promise<void>((resolve) => model.close(() => resolve()));
        await app.close();
    }
});
