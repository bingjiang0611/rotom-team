// Actual browser deltas, intentional loss and full recovery on the same connection; long polling uses the same protocol.
import {
    cleanUp,
    openApp,
    owner,
    root,
    scriptedModel,
    seedHistoricalSession,
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
    "Chromium applies session rows and preserves an archived list without reconnecting",
    {
        skip: executable === undefined && "no Chromium available",
        timeout: 40_000,
    },
    async () => {
        const app = await openApp(scriptedModel());
        const server = createServer(
            createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
        );
        const browsers = new Browsers({
            dataDir: join(root, "list-browser"),
            load: async () => undefined,
            save: () => {},
        });

        try {
            const id = await seedHistoricalSession(app);

            await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
            const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
            const page = await browsers.open(1);

            await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
            await page.navigate(base);
            await until(
                async () =>
                    (await page.evaluate(
                        `return JSON.stringify(document.body.innerText.includes("Historical test session"))`,
                    )) === "true",
                "initial session list",
            );
            await assert.rejects(
                app.commands.updateSession(id, owner(app), { title: "Archived rename" }),
                /read-only archive/,
            );
            assert.equal(
                (await app.sessions(owner(app))).find((row) => row.id === Number(id))?.title,
                "Historical test session",
            );
        } finally {
            await browsers.closeAll({ final: true });
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await app.close();
        }
    },
);

test("polling preserves the full historical list and rejects archive deltas", async () => {
    const app = await openApp(scriptedModel(), join(root, "poll-data"));
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    try {
        const id = await seedHistoricalSession(app);

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const response = await fetch(`${base}/api/poll?sessions=delta`, {
            headers: {
                authorization: `Bearer ${app.config.ownerToken}`,
                "x-pocket": "1",
            },
        });

        assert.equal(response.status, 200);
        assert.match(await response.text(), /Historical test session/);
        await assert.rejects(
            app.commands.updateSession(id, owner(app), { title: "Polling delta" }),
            /read-only archive/,
        );
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await app.close();
    }
});
