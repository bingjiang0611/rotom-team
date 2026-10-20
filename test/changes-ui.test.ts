// Changes in real Chromium: the open Changes tab follows the folder by itself when the server watches it, and does not
// read Changes again for entries that edited nothing.
import { cleanUp, context, noInferenceModels, owner, root } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import type { JsonValue } from "@earendil-works/chord";
import { PocketApp } from "../src/server/app.ts";
import { Chromium } from "../src/server/browser/cdp.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { NATIVE_ENTRY } from "../src/server/entry-format.ts";
import { createHandler } from "../src/server/http.ts";

after(cleanUp);
const executable = findBrowser();
const watched = process.platform === "darwin" || process.platform === "win32";

test(
    "an open Changes tab shows a person's edit without entries, and entries that edit nothing do not read it again",
    {
        skip: (executable === undefined || !watched) && "needs Chromium and a watched folder",
        timeout: 40_000,
    },
    async () => {
        const repo = join(realpathSync(root), "changes-ui-repo");

        mkdirSync(repo, { recursive: true });
        execFileSync("git", ["init", "-q"], { cwd: repo });
        writeFileSync(join(repo, "first.txt"), "first\n");

        const app = await PocketApp.open({
            dataDir: join(realpathSync(root), "changes-ui-data"),
            defaultCwd: repo,
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
                cwd: repo,
            });
            const append = (text: string) =>
                app.harness.commit(
                    (tx) =>
                        tx.appendEntry(id, {
                            kind: NATIVE_ENTRY,
                            data: {
                                entry: {
                                    type: "message",
                                    id: `note-${text}`,
                                    parentId: null,
                                    message: { role: "user", timestamp: 0, content: text },
                                },
                            } as JsonValue,
                        }),
                    context,
                );

            server.listen(0, "127.0.0.1");
            await once(server, "listening");
            const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

            chromium = await Chromium.launch(executable!, join(root, "changes-ui-browser"), []);
            const cdp = chromium.connection;
            const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
            const { sessionId } = await cdp.send("Target.attachToTarget", {
                targetId,
                flatten: true,
            });
            let loaded: (() => void) | undefined;
            let reads = 0;

            cdp.listen(sessionId, (method, params) => {
                if (
                    method === "Network.requestWillBeSent" &&
                    new URL(String(params.request.url)).pathname === `/api/c/${id}/changes`
                ) {
                    reads++;
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

            /** The count on the Changes tab, once it is `count`. */
            const countIs = (count: number) =>
                evaluate(`new Promise((resolve, reject) => {
                    const end = Date.now() + 8000;
                    const look = () => {
                        const shown = document.querySelector('.files-tabs .files-count')?.textContent ?? '0';
                        if (shown === ${JSON.stringify(String(count))}) return resolve(true);
                        if (Date.now() > end) return reject(new Error('count is ' + shown));
                        setTimeout(look, 50);
                    };
                    look();
                })`);
            const settle = (ms: number) => new Promise((done) => setTimeout(done, ms));

            await navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
            await navigate(`${base}/s/${id}`);
            await evaluate(`new Promise((resolve, reject) => {
                const end = Date.now() + 8000;
                const open = () => {
                    const button = document.querySelector('[title="Files and changes (Alt+E)"]');
                    if (button) { button.click(); return tab(); }
                    if (Date.now() > end) return reject(new Error('no Files button'));
                    setTimeout(open, 50);
                };
                const tab = () => {
                    const changes = document.querySelectorAll('.files-tabs [role="tab"]')[1];
                    if (changes) { changes.click(); return resolve(true); }
                    if (Date.now() > end) return reject(new Error('no Changes tab'));
                    setTimeout(tab, 50);
                };
                open();
            })`);
            await countIs(1);
            // Past the read a panel makes a moment after it is shown.
            await settle(2000);

            // A person adds a file: no entry, no timer short enough; only the server's event can make the tab read.
            const beforeEdit = reads;

            writeFileSync(join(repo, "second.txt"), "second\n");
            await countIs(2);
            assert.ok(reads - beforeEdit >= 1 && reads - beforeEdit <= 2, `${reads - beforeEdit}`);

            // Entries that edit nothing: the view moves, and Changes is not read again.
            await settle(1500);
            const beforeEntries = reads;

            for (let index = 0; index < 4; index++) {
                await append(`message ${index}`);
                await settle(400);
            }

            await settle(2000);
            assert.equal(
                await evaluate(`document.body.innerText.includes("message 3")`),
                true,
                "the entries reached the tab",
            );
            assert.equal(
                reads,
                beforeEntries,
                "entries that edit nothing are not a reason to read",
            );
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
