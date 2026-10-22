// Warming in real Chromium: opening one's own idle native session asks the server, once, to start its native process,
// before composer focus or any send. Focusing the composer afterwards asks nothing more.
import { cleanUp, noInferenceModels, owner, root, until, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { PocketApp } from "../src/server/app.ts";
import { Chromium } from "../src/server/browser/cdp.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { createHandler } from "../src/server/http.ts";

after(cleanUp);
const executable = findBrowser();

test(
    "opening one's own native session warms it once before composer focus",
    { skip: executable === undefined && "needs Chromium", timeout: 60_000 },
    async () => {
        const app = await PocketApp.open({
            dataDir: join(realpathSync(root), "native-warm-ui-data"),
            defaultCwd: realpathSync(work),
            supervised: false,
            kernel: true,
            browser: null,
            log: () => {},
            configureUserModels: noInferenceModels,
        });
        const server = createServer(
            createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
        );
        let chromium: Chromium | undefined;

        try {
            const { id } = await app.commands.createSession(owner(app), {
                backend: "rotom",
                cwd: realpathSync(work),
            });

            server.listen(0, "127.0.0.1");
            await once(server, "listening");
            const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

            chromium = await Chromium.launch(executable!, join(root, "native-warm-ui-browser"), []);
            const cdp = chromium.connection;
            const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
            const { sessionId } = await cdp.send("Target.attachToTarget", {
                targetId,
                flatten: true,
            });
            let loaded: (() => void) | undefined;
            let warms = 0;

            cdp.listen(sessionId, (method, params) => {
                if (
                    method === "Network.requestWillBeSent" &&
                    new URL(String(params.request.url)).pathname === `/api/c/${id}/warm`
                ) {
                    warms++;
                }

                if (method === "Page.loadEventFired") {
                    loaded?.();
                }
            });
            await cdp.send("Page.enable", {}, sessionId);
            await cdp.send("Network.enable", {}, sessionId);

            const navigate = async (url: string) => {
                const load = new Promise<void>((resolve) => (loaded = resolve));

                await cdp.send("Page.navigate", { url }, sessionId);
                await load;
            };

            const evaluate = async (expression: string) => {
                const answer = await cdp.send(
                    "Runtime.evaluate",
                    { expression, awaitPromise: true, returnByValue: true },
                    sessionId,
                    20_000,
                );

                assert.equal(answer.exceptionDetails, undefined, JSON.stringify(answer));

                return answer.result.value;
            };

            const focus = () =>
                evaluate(`new Promise((resolve, reject) => {
                    const end = Date.now() + 8000;
                    const look = () => {
                        const box = document.querySelector('.composer textarea');
                        if (box && !box.disabled) { box.blur(); box.focus(); return resolve(true); }
                        if (Date.now() > end) return reject(new Error('no message box'));
                        setTimeout(look, 50);
                    };
                    look();
                })`);
            const unused = () => app.kernel!.executions.unusedWarm().length;

            await navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
            await cdp.send("Target.activateTarget", { targetId });
            await navigate(`${base}/s/${id}`);
            await until(() => unused() === 1, "the warm process before composer focus", 30_000);
            assert.equal(warms, 1);
            // Focusing again soon after asks nothing more.
            await focus();
            await new Promise((resolve) => setTimeout(resolve, 500));
            assert.equal(warms, 1);
            assert.equal(unused(), 1);
        } finally {
            chromium?.kill();

            if (chromium) {
                await chromium.exited;
            }

            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await app.close();
        }
    },
);
