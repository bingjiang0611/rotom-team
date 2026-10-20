// A real browser opens a long session with only its newest entries, shows earlier ones as the reader scrolls up, and
// reads the whole history for find and for a jump to a message it does not hold.
import { cleanUp, context, newSession, openApp, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { createHandler } from "../src/server/http.ts";

after(cleanUp);
const executable = findBrowser();
const COUNT = 400;
const label = (index: number) => `LONG-${String(index).padStart(4, "0")}`;

test(
    "Chromium opens a long session from its newest entries, loads earlier ones on scrolling up, and finds in all of it",
    {
        skip: executable === undefined && "no Chromium available",
        timeout: 90_000,
    },
    async () => {
        const app = await openApp(scriptedModel(), join(root, "view-tail"));
        const server = createServer(
            createHandler({
                app,
                listen: { host: "127.0.0.1", port: 0 },
                restart: () => {},
            }),
        );
        const browsers = new Browsers({
            dataDir: join(root, "view-tail-browser"),
            load: async () => undefined,
            save: () => {},
        });

        try {
            const id = await newSession(app);

            await app.harness.commit(async (tx) => {
                for (let index = 1; index <= COUNT; index++) {
                    await tx.appendEntry(id, {
                        kind: "pi.user",
                        model: [{ role: "user", content: label(index), timestamp: index }],
                    });
                }
            }, context);

            await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
            const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
            const page = await browsers.open(1);
            const evaluate = async (expression: string) =>
                JSON.parse(await page.evaluate(expression));
            const shown = (text: string) =>
                evaluate(
                    `return JSON.stringify(document.body.textContent.includes(${JSON.stringify(text)}))`,
                );
            const pages = () =>
                evaluate(`return JSON.stringify(performance.getEntriesByType('resource')
                    .filter(each => each.name.includes('/entries?before=')).length)`);
            const held = () =>
                evaluate(`
                    const view = (await import('/store.js')).store.state.view;
                    return JSON.stringify({ order: view.order.length, held: view.order.filter(id => view.entries.has(id)).length });
                `);

            await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
            await page.navigate(`${base}/s/${id}`);
            await until(async () => shown(label(COUNT)), "the newest message");

            const TRANSCRIPT_TAIL = (await evaluate(
                `return JSON.stringify((await import('/store.js')).TRANSCRIPT_TAIL)`,
            )) as number;

            assert.ok(TRANSCRIPT_TAIL < COUNT);

            assert.deepEqual(
                await held(),
                { order: COUNT, held: TRANSCRIPT_TAIL },
                "only the newest",
            );
            assert.equal(await pages(), 0);
            assert.equal(await shown(label(1)), false);

            // Scroll up, as a reader does, until the first message shows.
            for (let step = 0; step < 40 && !(await shown(label(1))); step++) {
                await evaluate(`
                    const element = document.querySelector('main.scroller');
                    element.scrollTop = Math.min(element.scrollHeight, 400);
                    await new Promise(requestAnimationFrame);
                    element.scrollTop = 0;
                    await new Promise(resolve => setTimeout(resolve, 150));
                    return JSON.stringify(true);
                `);
            }

            assert.equal(await shown(label(1)), true, "scrolling up reaches the first message");
            assert.ok((await pages()) >= 1, "earlier entries came a page at a time");
            assert.deepEqual(await held(), { order: COUNT, held: COUNT });
            assert.deepEqual(
                await evaluate(`
                    const view = (await import('/store.js')).store.state.view;
                    return JSON.stringify(view.order.map(id => view.entries.get(id).text));
                `),
                Array.from({ length: COUNT }, (_, index) => label(index + 1)),
                "every entry, in order",
            );

            // A fresh open: find reads the whole session first.
            await page.navigate(`${base}/s/${id}`);
            await until(async () => shown(label(COUNT)), "the newest message again");
            assert.equal((await held()).held, TRANSCRIPT_TAIL);
            await evaluate(`
                (await import('/store.js')).openSheet({ type: 'find', query: '${label(2)}' });
                return JSON.stringify(true);
            `);
            await until(
                async () =>
                    evaluate(`return JSON.stringify(
                        [...document.querySelectorAll('.find-results button')].some(each => each.textContent.includes('${label(2)}')))`),
                "find lists a message the view did not send",
            );
            assert.deepEqual(await held(), { order: COUNT, held: COUNT });

            // A fresh open: jumping to a message the tab does not hold reads it, then shows it.
            await page.navigate(`${base}/s/${id}`);
            await until(async () => shown(label(COUNT)), "the newest message a third time");
            await evaluate(`
                const { store } = await import('/store.js');
                const { jumpToEntry } = await import('/chat.js');
                jumpToEntry(store.state.view.order[2]);
                return JSON.stringify(true);
            `);
            await until(async () => shown(label(3)), "the jumped-to message");
        } finally {
            await browsers.closeAll({ final: true });
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await app.close();
        }
    },
);
