/**
 * Browser waits reach the daily performance journal: a real page opens a session, sends a message through the composer,
 * and switches to another session; its timings arrive at `POST /api/perf` and are journaled without any of the text.
 * Scripted model, no model account.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { createHandler } from "../src/server/http.ts";
import { type PerformanceRecord, startPerformanceJournal } from "../src/server/perf-journal.ts";
import { cleanUp, newSession, openApp, root, scriptedModel, until } from "./helpers.ts";

const chromium = findBrowser();
const real = { skip: chromium === undefined ? "Chromium not installed" : false };

after(cleanUp);

test(
    "a tab journals how long opening, sending, the first reply, and switching took on screen",
    real,
    async () => {
        const app = await openApp(scriptedModel(), join(root, "perf-web-data"));
        const id = Number(await newSession(app));
        const other = Number(await newSession(app));
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

            await journal.journal.flush();
            await until(async () => {
                await journal.journal.flush();

                return web().length >= 8;
            }, "the tab's report");

            const waits = web();

            // Signing in lands on the session list: that page's open, sent as the page was left.
            assert.deepEqual(waits.map((each) => each.name).sort(), [
                "open.home",
                "open.session",
                "reply.arrived",
                "reply.first",
                "send.answered",
                "send.arrived",
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
            // This scripted backend has no optimistic row: an echo would be a false display measurement.
            assert.ok(ms("send.arrived") <= ms("send.shown"), JSON.stringify(waits));
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
        }
    },
);
