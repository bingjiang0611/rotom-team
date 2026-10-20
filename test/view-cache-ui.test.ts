// A real browser keeps a saved copy of a session it opened, shows it marked as checking when coming back, claims it so
// the server sends only what is missing, and forgets every copy on sign-out or a change of person or access.
import {
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { createHandler } from "../src/server/http.ts";

after(cleanUp);
const executable = findBrowser();

test(
    "Chromium shows a saved session at once, confirms it with only the missing entries, and forgets it on sign-out",
    {
        skip: executable === undefined && "no Chromium available",
        timeout: 60_000,
    },
    async () => {
        const app = await openApp(scriptedModel(), join(root, "saved-views"));
        const server = createServer(
            createHandler({
                app,
                listen: { host: "127.0.0.1", port: 0 },
                restart: () => {},
            }),
        );
        const browsers = new Browsers({
            dataDir: join(root, "saved-views-browser"),
            load: async () => undefined,
            save: () => {},
        });

        try {
            const id = await newSession(app);
            const append = (text: string) =>
                app.harness.commit(
                    (tx) =>
                        tx.appendEntry(id, {
                            kind: "pi.user",
                            model: [{ role: "user", content: text, timestamp: 1 }],
                        }),
                    context,
                );

            for (const text of ["SAVED-ONE", "SAVED-TWO", "SAVED-THREE"]) {
                await append(text);
            }

            await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
            const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
            const page = await browsers.open(1);
            const evaluate = async (expression: string) =>
                JSON.parse(await page.evaluate(expression));
            const state = (path: string) =>
                evaluate(`return JSON.stringify((await import('/store.js')).store.state.${path})`);
            const saved = () =>
                evaluate(
                    `return JSON.stringify(await (await import('/view-cache.js')).readView(${id}))`,
                );

            await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
            await page.navigate(`${base}/s/${id}`);
            await until(
                async () =>
                    (await state("view.order.length")) === 3 && !(await state("view.checking")),
                "the server's view",
            );
            await until(async () => (await saved())?.order?.length === 3, "a saved copy", 15_000);

            // Back on the list, hold this document's view events so the saved copy is seen before the server's view.
            await page.navigate(base);
            await until(async () => (await state("me"))?.id !== undefined, "signed in");
            await evaluate(`
                window.held = []; window.views = []; window.urls = [];
                const Original = window.EventSource;
                window.EventSource = class extends Original {
                    constructor(url, options) { super(url, options); window.urls.push(String(url)); }
                    addEventListener(name, callback, options) {
                        if (name !== 'view') return super.addEventListener(name, callback, options);
                        super.addEventListener(name, (event) => {
                            const data = JSON.parse(event.data);
                            window.views.push({ full: data.full, kept: data.kept ?? null, entries: data.entries.length });
                            if (window.held) window.held.push(() => callback(event)); else callback(event);
                        }, options);
                    }
                };
                window.releaseViews = () => { const held = window.held; window.held = null; held.forEach(run => run()); };
                (await import('/store.js')).navigate(${id});
                return JSON.stringify(true);
            `);
            await until(async () => (await state("view.checking")) === true, "the saved copy");
            assert.equal(await state("view.order.length"), 3);
            await until(
                async () =>
                    evaluate(`return JSON.stringify(
                        document.body.textContent.includes('SAVED-THREE') &&
                        !!document.querySelector('[data-view-checking]') &&
                        !document.querySelector('.composer'))`),
                "the copy on screen, marked, with no message box",
            );
            assert.match(
                (await evaluate(`return JSON.stringify(window.urls.at(-1))`)) as string,
                /&have=/,
            );
            await until(
                async () => evaluate(`return JSON.stringify(window.views.length > 0)`),
                "the server's full view arrived (held)",
            );
            assert.equal(await state("view.checking"), true, "still the copy until applied");
            await evaluate(`window.releaseViews(); return JSON.stringify(true);`);
            await until(async () => (await state("view.checking")) === false, "confirmed");
            await until(
                async () =>
                    evaluate(`return JSON.stringify(
                        !document.querySelector('[data-view-checking]') && !!document.querySelector('.composer'))`),
                "the message box once confirmed",
            );

            const first = (await evaluate(`return JSON.stringify(window.views[0])`)) as {
                full: boolean;
                kept: { count: number } | null;
                entries: number;
            };

            assert.equal(first.full, true);
            assert.equal(first.kept?.count, 3, "the server kept the whole claimed run");
            assert.equal(first.entries, 0, "and sent none of those entries again");
            assert.deepEqual(
                await evaluate(`
                    const view = (await import('/store.js')).store.state.view;
                    return JSON.stringify(view.order.map(id => view.entries.get(id)?.text));
                `),
                ["SAVED-ONE", "SAVED-TWO", "SAVED-THREE"],
            );

            // Something new while away: the copy shows without it; the server's view adds just that.
            await evaluate(`window.held = []; window.views = []; return JSON.stringify(true);`);
            await evaluate(
                `(await import('/store.js')).navigate(null); return JSON.stringify(true);`,
            );
            await append("SAVED-FOUR");
            await evaluate(
                `(await import('/store.js')).navigate(${id}); return JSON.stringify(true);`,
            );
            await until(
                async () => evaluate(`return JSON.stringify(window.views.length > 0)`),
                "second full view",
            );
            await evaluate(`window.releaseViews(); return JSON.stringify(true);`);
            await until(async () => (await state("view.order.length")) === 4, "the new entry");
            assert.deepEqual(await evaluate(`return JSON.stringify(window.views[0])`), {
                full: true,
                kept: { first: (await state("view.order"))[0], count: 3 },
                entries: 1,
            });
            await until(async () => (await saved())?.order?.length === 4, "copy updated", 15_000);

            // Should the tab not hold the whole run the server kept (a stale claim), it connects again claiming nothing.
            await evaluate(`
                window.held = []; window.views = [];
                const { navigate } = await import('/store.js');
                navigate(null); navigate(${id});
                return JSON.stringify(true);
            `);
            await until(
                async () => evaluate(`return JSON.stringify(window.views.length > 0)`),
                "held full view",
            );
            await evaluate(`
                const { store } = await import('/store.js');
                const view = store.state.view;
                const entries = new Map(view.entries);
                entries.delete(view.order[1]);
                store.set({ view: { ...view, entries } });
                window.releaseViews();
                return JSON.stringify(true);
            `);
            await until(
                async () =>
                    evaluate(`
                        const view = (await import('/store.js')).store.state.view;
                        const last = window.views.at(-1);
                        return JSON.stringify(!window.urls.at(-1).includes('&have=') && last.kept === null &&
                            last.entries === 4 && view.order.length === 4 &&
                            view.order.every(id => view.entries.has(id)));
                    `),
                "a fresh view after an incomplete claim",
            );

            // Another person's or other access's copy is never shown, and clears every copy.
            assert.equal(
                await evaluate(`
                    const cache = await import('/view-cache.js');
                    return JSON.stringify(await cache.loadView(${id}, { id: 'someone-else', role: 'member' }));
                `),
                null,
            );
            assert.equal(await saved(), null);

            // Signed out (as after a 401): every copy goes.
            await evaluate(
                `(await import('/store.js')).navigate(null); (await import('/store.js')).navigate(${id}); return JSON.stringify(true);`,
            );
            await until(async () => (await saved())?.order?.length === 4, "saved again", 15_000);
            await evaluate(
                `(await import('/store.js')).store.set({ me: null }); return JSON.stringify(true);`,
            );
            await until(async () => (await saved()) === null, "cleared on sign-out");

            // The Settings sign-out stops saving before clearing.
            await evaluate(`
                const cache = await import('/view-cache.js');
                const { store, forgetSavedViews } = await import('/store.js');
                await cache.saveView(store.state.view, { id: 'owner', role: 'owner' });
                await forgetSavedViews();
                return JSON.stringify(true);
            `);
            assert.equal(await saved(), null);
        } finally {
            await browsers.closeAll({ final: true });
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await app.close();
        }
    },
);
