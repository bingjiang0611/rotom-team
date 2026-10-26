/**
 * Browser waits reach the daily performance journal: a real page opens a session, sends a message through the composer,
 * and switches to another session; its timings arrive at `POST /api/perf` and are journaled without any of the text.
 * Scripted model, no model account.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { PocketApp } from "../src/server/app.ts";
import { createHandler } from "../src/server/http.ts";
import { type PerformanceRecord, startPerformanceJournal } from "../src/server/perf-journal.ts";
import { cleanUp, owner, root, until, work } from "./helpers.ts";

const chromium = findBrowser();
const real = { skip: chromium === undefined ? "Chromium not installed" : false };

after(cleanUp);

test(
    "a tab journals how long opening, sending, the first reply, and switching took on screen",
    real,
    async () => {
        const model: Server = createServer(async (request, response) => {
            for await (const _chunk of request) {
                // Consume the request body before returning a deterministic loopback answer.
            }

            response.writeHead(200, { "Content-Type": "text/event-stream" });
            response.end(
                `data: ${JSON.stringify({ id: "perf-web", object: "chat.completion.chunk", created: 1, model: "perf-web", choices: [{ index: 0, delta: { role: "assistant", content: "Loopback reply" }, finish_reason: null }] })}\\n\\ndata: ${JSON.stringify({ id: "perf-web", object: "chat.completion.chunk", created: 1, model: "perf-web", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\\n\\ndata: [DONE]\\n\\n`,
            );
        });

        model.listen(0, "127.0.0.1");
        await once(model, "listening");
        const modelBase = `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`;
        const app = await PocketApp.open({
            dataDir: join(realpathSync(root), "perf-web-data"),
            defaultCwd: realpathSync(work),
            kernel: true,
            supervised: false,
            browser: null,
            log: () => {},
            configureUserModels: (models, user) =>
                models.registerNativeProvider({
                    id: "openai",
                    name: "Loopback web performance model",
                    auth: {
                        apiKey: {
                            name: "Synthetic",
                            resolve: async () => ({
                                auth: { apiKey: `perf-web:${user.id}` },
                                source: "test",
                            }),
                        },
                    },
                    getModels: () => [
                        {
                            id: "perf-web",
                            name: "perf-web",
                            api: "openai-completions",
                            provider: "openai",
                            baseUrl: modelBase,
                            reasoning: false,
                            input: ["text"],
                            contextWindow: 200_000,
                            maxTokens: 4096,
                            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                        },
                    ],
                    stream: () => {
                        throw new Error("native loopback stream is selected by the kernel");
                    },
                    streamSimple: () => {
                        throw new Error("native loopback stream is selected by the kernel");
                    },
                }),
        });
        const id = Number((await app.commands.createSession(owner(app), { backend: "rotom" })).id);
        const other = Number(
            (await app.commands.createSession(owner(app), { backend: "rotom" })).id,
        );
        const server: Server = createServer(
            createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
        );

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const directory = mkdtempSync(join(root, "perf-web-journal-"));
        const journal = await startPerformanceJournal({
            directory,
            server,
            openMs: 1,
            kernel: false,
            log: () => assert.fail("the journal failed"),
        });
        const browsers = new Browsers({
            dataDir: mkdtempSync(join(root, "perf-web-ui-")),
            load: async () => undefined,
            save: () => {},
        });

        try {
            const page = await browsers.open(1);

            await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
            await page.navigate(`${base}/s/${id}`);
            await until(
                async () =>
                    (await page.evaluate(
                        `Boolean(document.querySelector("textarea[placeholder^='Message Pi']"))`,
                    )) === "true",
                "session loaded",
                20_000,
            );
            await page.type({ selector: "textarea[placeholder^='Message Pi']" }, "private-words", {
                submit: true,
            });
            await until(
                async () =>
                    (await page.evaluate(
                        `const { store } = await import('/store.js'); store.state.view.order.some((id) => store.state.view.entries.get(id)?.kind === 'assistant')`,
                    )) === "true",
                "the reply on screen",
                20_000,
            );
            // Store arrival precedes paint. Let perf.shown's frame/task record reply.first before
            // navigation cancels the previous conversation's outstanding waits.
            await page.evaluate(
                `await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)))`,
            );
            await page.evaluate(`(await import('/store.js')).navigate(${other})`);
            await until(
                async () =>
                    (await page.evaluate(
                        `(await import('/store.js')).store.state.view.conversation?.id === ${other}`,
                    )) === "true",
                "the other session on screen",
            );
            // Leaving the page sends what the tab has queued.
            await page.navigate("about:blank");

            const web = () =>
                readFileSync(join(directory, "performance-0.jsonl"), "utf8")
                    .trim()
                    .split("\n")
                    .map((line) => (JSON.parse(line) as PerformanceRecord).observation)
                    .filter((each) => each.kind === "web");

            await until(async () => {
                await journal.journal.flush();

                return web().length >= 9;
            }, "the tab's complete report");
            const waits = web();

            // Signing in lands on the session list: that page's open, sent as the page was left.
            assert.deepEqual(waits.map((each) => each.name).sort(), [
                "open.home",
                "open.session",
                "reply.arrived",
                "reply.first",
                "send.answered",
                "send.arrived",
                "send.echoed",
                "send.shown",
                "switch",
            ]);

            for (const wait of waits) {
                assert.equal(wait.transport, "stream");
                assert.ok("ms" in wait && wait.ms > 0, JSON.stringify(wait));
            }

            const ms = (name: string) => {
                const wait = waits.find((each) => each.name === name)!;

                return "ms" in wait ? wait.ms : NaN;
            };

            // The message shows before its answer can.
            assert.ok(ms("send.shown") <= ms("reply.first"), JSON.stringify(waits));
            // The native loopback records an explicit echoed composer row before the answer arrives.
            assert.ok(ms("send.echoed") <= ms("send.shown"), JSON.stringify(waits));
            assert.ok(ms("reply.arrived") <= ms("reply.first"), JSON.stringify(waits));
            assert.doesNotMatch(
                readFileSync(join(directory, "performance-0.jsonl"), "utf8"),
                /private-words/,
            );
        } finally {
            await browsers.closeAll({ final: true });
            await journal.stop();
            server.closeAllConnections();
            server.close();
            await app.close();
            model.close();
        }
    },
);
