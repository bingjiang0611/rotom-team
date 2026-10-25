// Actual browser deltas, intentional loss and full recovery on the same connection; long polling uses the same protocol.
import { cleanUp, newSession, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
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
    "Chromium applies session rows and recovers a lost delta without reconnecting",
    {
        skip: executable === undefined && "no Chromium available",
        timeout: 40_000,
    },
    async () => {
        const app = await openApp(scriptedModel());
        const server = createServer(
            createHandler({
                app,
                listen: { host: "127.0.0.1", port: 0 },
                restart: () => {},
            }),
        );
        const browsers = new Browsers({
            dataDir: join(root, "list-browser"),
            load: async () => undefined,
            save: () => {},
        });

        try {
            const first = await newSession(app);
            const second = await newSession(app);

            await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
            const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
            const page = await browsers.open(1);
            const evaluate = async (expression: string) =>
                JSON.parse(await page.evaluate(expression));

            await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
            await page.navigate(base);
            await until(
                async () =>
                    evaluate(
                        `return JSON.stringify(!!(await import('/store.js')).store.state.sessionListVersion)`,
                    ),
                "initial version",
            );
            // Intercept browser event delivery, not the server: drop one delta, then let a later delta reveal the gap.
            await evaluate(`
            window.listFrames = { full: 0, deltas: 0, syncs: 0, dropped: 0, dropNext: false };
            const Original = window.EventSource;
            window.EventSource = class extends Original {
                addEventListener(name, callback, options) {
                    if (name === 'sessions' || name === 'sessions-delta') {
                        super.addEventListener(name, event => {
                            if (name === 'sessions') window.listFrames.full++;
                            else {
                                window.listFrames.deltas++;
                                if (window.listFrames.dropNext) {
                                    window.listFrames.dropNext = false;
                                    window.listFrames.dropped++;
                                    return;
                                }
                            }
                            callback(event);
                        }, options);
                    } else super.addEventListener(name, callback, options);
                }
            };
            const fetchBefore = window.fetch;
            window.fetch = (input, options) => {
                if (String(input).includes('/api/sessions/sync')) window.listFrames.syncs++;
                return fetchBefore(input, options);
            };
            (await import('/store.js')).connect();
            return JSON.stringify(true);
        `);
            await until(
                async () => evaluate(`return JSON.stringify(window.listFrames.full === 1)`),
                "new stream snapshot",
            );
            const stream = await evaluate(
                `return JSON.stringify((await import('/store.js')).store.state.streamId)`,
            );
            const titleIs = async (id: number, title: string) =>
                until(
                    async () =>
                        evaluate(`
            return JSON.stringify((await import('/store.js')).store.state.sessions.some(
                row => row.id === ${id} && row.title === ${JSON.stringify(title)}));
        `),
                    title,
                );

            await app.commands.updateSession(first, owner(app), {
                title: "Delta arrives in sidebar",
            });
            await titleIs(first, "Delta arrives in sidebar");
            assert.ok(
                await evaluate(
                    `return JSON.stringify(document.body.innerText.includes('Delta arrives in sidebar'))`,
                ),
            );
            assert.equal(
                await evaluate(`return JSON.stringify(window.listFrames.full)`),
                1,
                "rename was not a snapshot",
            );

            await evaluate(`window.listFrames.dropNext = true; return JSON.stringify(true);`);
            await app.commands.updateSession(second, owner(app), { title: "This frame is lost" });
            await until(
                async () => evaluate(`return JSON.stringify(window.listFrames.dropped === 1)`),
                "delta deliberately dropped",
            );
            assert.equal(
                await evaluate(
                    `return JSON.stringify((await import('/store.js')).store.state.sessions.some(row => row.title === 'This frame is lost'))`,
                ),
                false,
            );
            await app.commands.updateSession(first, owner(app), {
                title: "Gap triggers full recovery",
            });
            await titleIs(first, "Gap triggers full recovery");
            await titleIs(second, "This frame is lost");
            assert.equal(await evaluate(`return JSON.stringify(window.listFrames.syncs)`), 1);
            assert.equal(await evaluate(`return JSON.stringify(window.listFrames.full)`), 2);
            assert.equal(
                await evaluate(
                    `return JSON.stringify((await import('/store.js')).store.state.streamId)`,
                ),
                stream,
                "same stream",
            );
            assert.deepEqual(
                await evaluate(
                    `return JSON.stringify((await import('/store.js')).store.state.sessions)`,
                ),
                await app.sessions(owner(app)),
            );

            // Reconnect starts a new version namespace and a fresh full snapshot.
            await evaluate(`(await import('/store.js')).connect(); return JSON.stringify(true);`);
            await until(
                async () => evaluate(`return JSON.stringify(window.listFrames.full === 3)`),
                "reconnect snapshot",
            );
            assert.notEqual(
                await evaluate(
                    `return JSON.stringify((await import('/store.js')).store.state.streamId)`,
                ),
                stream,
            );
        } finally {
            await browsers.closeAll({ final: true });
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await app.close();
        }
    },
);

test("polling replays unacknowledged deltas, and resync sends a full list on that poll connection", async () => {
    const app = await openApp(scriptedModel(), join(root, "poll-data"));
    const server = createServer(
        createHandler({
            app,
            listen: { host: "127.0.0.1", port: 0 },
            restart: () => {},
        }),
    );
    let closePoll: (() => Promise<unknown>) | undefined;

    try {
        const id = await newSession(app);

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const headers = {
            authorization: `Bearer ${app.config.ownerToken}`,
            "x-pocket": "1",
            "content-type": "application/json",
        };

        const get = async (query: string) => {
            const response = await fetch(`${base}/api/poll?${query}`, { headers });

            assert.equal(response.status, 200);

            return response.json();
        };

        const first = await get("sessions=delta");
        const full = first.events.find((each: any) => each.event === "sessions");
        const hello = first.events.find((each: any) => each.event === "hello");
        const ack = Math.max(...first.events.map((each: any) => each.seq));

        assert.ok(full.data.version.startsWith(hello.data.connection));
        closePoll = () => get(`session=${first.session}&close=1`);
        await app.commands.updateSession(id, owner(app), { title: "Polling delta" });
        const next = await get(`session=${first.session}&ack=${ack}`);
        const delta = next.events.find((each: any) => each.event === "sessions-delta");

        assert.equal(delta.data.from, full.data.version);
        assert.equal(delta.data.upsert[0].title, "Polling delta");
        const replay = await get(`session=${first.session}&ack=${ack}`);

        assert.deepEqual(
            replay.events,
            next.events,
            "a lost HTTP answer is replayed with the same version",
        );
        const response = await fetch(`${base}/api/sessions/sync`, {
            method: "POST",
            headers,
            body: JSON.stringify({ connection: hello.data.connection }),
        });

        assert.equal(response.status, 200);
        const restored = await get(`session=${first.session}&ack=${delta.seq}`);
        const snapshot = restored.events.find((each: any) => each.event === "sessions");

        assert.deepEqual(snapshot.data.items, await app.sessions(owner(app)));
        assert.notEqual(snapshot.data.version, full.data.version);
    } finally {
        await closePoll?.();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await app.close();
    }
});
