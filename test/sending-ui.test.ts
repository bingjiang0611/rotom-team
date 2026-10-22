/**
 * A native message shows as it goes: Enter puts it in the transcript at once, marked as sending, and only the
 * server's entry with the same browser request id takes that row's place. A send the server refuses takes the row away;
 * one whose answer is lost keeps it, marked as of unknown outcome, until its entry comes after all or it is put away.
 * The text stays in the box either way. Real Chromium, real rotom kernel, loopback model, no model account.
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

        for (let index = 0; index < 5; index++) {
            await new Promise((resolve) => setTimeout(resolve, 120));
            emit({ content: ` ${index}:` + "x".repeat(400) });
        }

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
        const room = await app.room(id);
        let livePatches = 0;

        for (const client of room.clients) {
            const send = client.send.bind(client);

            client.send = (name, data: any) => {
                if (name === "view" && data.livePatch) {
                    livePatches++;
                }

                send(name, data);
            };
        }

        // Note every message row marked as sending that ever shows the text.
        await page.evaluate(`window.__sending = [];
            window.__unknown = [];
            new MutationObserver(() => {
                for (const row of document.querySelectorAll(".transcript .user-row.sending")) {
                    if (!window.__sending.includes(row.textContent)) window.__sending.push(row.textContent);
                    if (row.matches(".unknown") && !window.__unknown.includes(row.textContent)) {
                        window.__unknown.push(row.textContent);
                    }
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

        assert.ok(
            livePatches > 0,
            "the actual native browser connection receives live text patches",
        );
        assert.equal(
            await check(
                `document.querySelector('.transcript').textContent.includes(' 4:' + 'x'.repeat(400))`,
            ),
            true,
            "the browser reconstructed the final streamed text",
        );

        const idle = () =>
            until(
                () =>
                    check(
                        `const { store } = await import('/store.js'); !store.state.view.live?.busy`,
                    ),
                "an idle session",
                30_000,
            );
        // Answers each send as `answer` says, after a moment; every other request goes through.
        const sendsAnswer = (answer: string) =>
            page.evaluate(`window.__fetch ??= window.fetch;
                window.fetch = (input, init) => String(input).includes("/submit")
                    ? new Promise((resolve) => setTimeout(resolve, 300)).then(() => ${answer})
                    : window.__fetch(input, init);
                true`);

        // Refused by the server: the row goes, the text stays in the box.
        await sendsAnswer(`new Response(JSON.stringify({ error: "Refused." }), { status: 409 })`);
        await page.type({ selector: box }, "refused-words", { submit: true });
        await until(
            () => check(`window.__sending.some((text) => text.includes("refused-words"))`),
            "the refused send's row",
        );
        await until(
            () => check(`!document.querySelector(".user-row.sending")`),
            "the refused row gone",
        );
        assert.equal(await check(`${rows("refused-words")}.length === 0`), true);
        assert.equal(
            await check(`document.querySelector("${box}").value === "refused-words"`),
            true,
        );

        // Never arrived (the network failed first): the row stays, marked unknown, and is never taken as sent.
        await sendsAnswer(`Promise.reject(new TypeError("offline"))`);
        await page.type({ selector: box }, "lost-words", { submit: true });
        await until(
            () => check(`${rows("lost-words")}.some((row) => row.matches(".sending.unknown"))`),
            "the lost send marked unknown",
        );
        assert.equal(
            await check(`${rows("lost-words")}[0].textContent.includes("outcome unknown")`),
            true,
        );
        assert.equal(await check(`document.querySelector("${box}").value === "lost-words"`), true);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        assert.equal(
            await check(
                `${rows("lost-words")}.length === 1 && ${rows("lost-words")}[0].matches(".sending.unknown")`,
            ),
            true,
            "a send of unknown outcome stays",
        );
        // Put away by its sender, it goes; nothing is sent again.
        await page.evaluate(
            `document.querySelector(".user-row.unknown button.link").click(); true`,
        );
        await until(() => check(`${rows("lost-words")}.length === 0`), "the dismissed row gone");

        // Went, but its answer was lost: marked unknown until its own entry comes and takes its place.
        await sendsAnswer(
            `window.__fetch(input, init).then(() => { throw new TypeError("connection lost"); })`,
        );
        await page.type({ selector: box }, "went-words", { submit: true });
        await until(
            () => check(`window.__sending.some((text) => text.includes("went-words"))`),
            "the row of the send whose answer was lost",
        );
        await until(
            () =>
                check(
                    `${rows("went-words")}.length === 1 && !document.querySelector(".user-row.sending")`,
                ),
            "its entry in place of the row",
            30_000,
        );
        // The server answers once the send is recorded, before the native run writes its entry, so it showed unknown.
        assert.equal(
            await check(`window.__unknown.some((text) => text.includes("went-words"))`),
            true,
            "marked unknown before its entry came",
        );
        await idle();
        await page.evaluate(`window.fetch = window.__fetch; true`);
        assert.equal(
            await check(
                `const { store } = await import('/store.js'); store.state.view.order.filter((id) => store.state.view.entries.get(id)?.text === "went-words").length === 1`,
            ),
            true,
            "sent once",
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
