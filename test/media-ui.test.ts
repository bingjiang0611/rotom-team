// Synthetic kernel-mode history in real Chromium: thumbnail -> full-screen preview -> original URL.
import { cleanUp, context, owner, root, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import type { JsonValue } from "@earendil-works/chord";
import { PocketApp } from "../src/server/app.ts";
import { Chromium } from "../src/server/browser/cdp.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { NATIVE_ENTRY } from "../src/server/entry-format.ts";
import { createHandler } from "../src/server/http.ts";
import { imageFixture } from "./perf/images.ts";

after(cleanUp);
const executable = findBrowser();

test(
    "the transcript requests a thumbnail, the viewer a preview, and Open preserves the original",
    {
        skip: executable === undefined && "no Chromium available",
        timeout: 30_000,
    },
    async () => {
        const app = await PocketApp.open({
            dataDir: join(realpathSync(root), "media-ui"),
            defaultCwd: realpathSync(work),
            supervised: false,
            kernel: true,
            browser: null,
            log: () => {},
            configureUserModels: (models) =>
                models.registerNativeProvider({
                    id: "openai",
                    name: "No-inference image fixture",
                    auth: {
                        apiKey: {
                            name: "Synthetic",
                            resolve: async () => ({
                                auth: { apiKey: "fixture" },
                                source: "test",
                            }),
                        },
                    },
                    getModels: () => [
                        {
                            id: "image-fixture",
                            name: "image-fixture",
                            provider: "openai",
                            api: "openai-completions",
                            baseUrl: "http://127.0.0.1:1/v1",
                            reasoning: false,
                            input: ["text"],
                            contextWindow: 32000,
                            maxTokens: 1024,
                            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                        },
                    ],
                    stream: () => {
                        throw new Error("No inference permitted");
                    },
                    streamSimple: () => {
                        throw new Error("No inference permitted");
                    },
                }),
        });
        const handler = createHandler({
            app,
            listen: { host: "127.0.0.1", port: 0 },
            restart: () => {},
        });
        const server = createServer(handler);
        let chromium: Chromium | undefined;

        try {
            const { id } = await app.commands.createSession(owner(app), { backend: "rotom" });
            const entry = await app.harness.commit(
                (tx) =>
                    tx.appendEntry(id, {
                        kind: NATIVE_ENTRY,
                        data: {
                            entry: {
                                type: "message",
                                id: "image-ui",
                                parentId: null,
                                message: {
                                    role: "user",
                                    timestamp: 0,
                                    content: [
                                        { type: "text", text: "Stored image UI fixture" },
                                        {
                                            type: "image",
                                            mimeType: "image/png",
                                            data: imageFixture(2048, 1280, 1).toString("base64"),
                                        },
                                    ],
                                },
                            },
                        } as JsonValue,
                    }),
                context,
            );

            server.listen(0, "127.0.0.1");
            await once(server, "listening");
            const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

            chromium = await Chromium.launch(executable!, join(root, "media-ui-browser"), []);
            const cdp = chromium.connection;
            const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
            const { sessionId } = await cdp.send("Target.attachToTarget", {
                targetId,
                flatten: true,
            });
            let loaded: (() => void) | undefined;

            cdp.listen(sessionId, (method) => {
                if (method === "Page.loadEventFired") {
                    loaded?.();
                }
            });
            await cdp.send("Page.enable", {}, sessionId);

            const navigate = async (url: string) => {
                const load = new Promise<void>((resolve) => {
                    loaded = resolve;
                });

                await cdp.send("Page.navigate", { url }, sessionId);
                await load;
            };

            await navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
            await navigate(`${base}/s/${id}`);

            const evaluate = async (expression: string) => {
                const answer = await cdp.send(
                    "Runtime.evaluate",
                    {
                        expression,
                        awaitPromise: true,
                        returnByValue: true,
                    },
                    sessionId,
                    20_000,
                );

                assert.equal(answer.exceptionDetails, undefined);

                return answer.result.value;
            };

            await evaluate(`window.waitForImage = selector => new Promise((resolve, reject) => {
            const find = () => {
                const img = document.querySelector(selector);
                if (!img) return;
                observer.disconnect();
                if (img.complete) img.naturalWidth ? resolve(img) : reject(new Error("broken image"));
                else { img.onload = () => resolve(img); img.onerror = () => reject(new Error("image error")); }
            };
            const observer = new MutationObserver(find);
            observer.observe(document, {childList:true, subtree:true, attributes:true});
            find();
        }); true`);
            const thumb = await evaluate(`waitForImage('.thumb img[src*="/image/"]').then(img => ({
            src: img.getAttribute('src'), width: img.naturalWidth, height: img.naturalHeight
        }))`);

            assert.equal(thumb.src, `/api/c/${id}/image/${entry.id}/0?size=thumb`);
            assert.deepEqual(
                [thumb.width, thumb.height],
                process.platform === "darwin" ? [480, 300] : [2048, 1280],
            );
            await evaluate(
                `document.querySelector('.thumb img[src*="/image/"]').parentElement.click(); true`,
            );
            const preview = await evaluate(`waitForImage('.lightbox img').then(img => ({
            src: img.getAttribute('src'), width: img.naturalWidth, href: document.querySelector('.lightbox a').getAttribute('href')
        }))`);

            assert.equal(preview.src, `/api/c/${id}/image/${entry.id}/0?size=preview`);
            assert.equal(preview.width, process.platform === "darwin" ? 1600 : 2048);
            assert.equal(preview.href, `/api/c/${id}/image/${entry.id}/0`);
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
