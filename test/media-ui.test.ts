// Synthetic kernel-mode history in real Chromium: thumbnail -> full-screen preview -> original URL.
import { cleanUp, context, noInferenceModels, owner, root, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import type { JsonValue } from "@earendil-works/chord";
import { PocketApp } from "../src/server/app.ts";
import { Chromium } from "../src/server/browser/cdp.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { NATIVE_ENTRY } from "../src/server/entry-format.ts";
import { createHandler } from "../src/server/http.ts";
import { imageFixture } from "./perf/images.ts";
import { createListener } from "../src/server/listener.ts";

after(cleanUp);
const executable = findBrowser();

for (const protocol of ["http", "https"]) {
    test(
        `${protocol}: transcript thumbnail, viewer preview, original and real clipboard upload`,
        {
            skip: executable === undefined && "no Chromium available",
            timeout: 30_000,
        },
        async () => {
            const app = await PocketApp.open({
                dataDir: join(realpathSync(root), `media-ui-${protocol}`),
                defaultCwd: realpathSync(work),
                supervised: false,
                kernel: true,
                browser: null,
                log: () => {},
                configureUserModels: noInferenceModels,
            });
            const handler = createHandler({
                app,
                listen: { host: "127.0.0.1", port: 0 },
                restart: () => {},
            });
            const { server, closeAll } = createListener(
                handler,
                protocol === "https"
                    ? {
                          cert: readFileSync(new URL("./fixtures/tls/cert.pem", import.meta.url)),
                          key: readFileSync(new URL("./fixtures/tls/key.pem", import.meta.url)),
                      }
                    : undefined,
            );
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
                                                data: imageFixture(2048, 1280, 1).toString(
                                                    "base64",
                                                ),
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
                const base = `${protocol}://127.0.0.1:${(server.address() as { port: number }).port}`;

                chromium = await Chromium.launch(
                    executable!,
                    join(root, `media-ui-browser-${protocol}`),
                    protocol === "https" ? ["--ignore-certificate-errors"] : [],
                );
                const cdp = chromium.connection;
                const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
                const { sessionId } = await cdp.send("Target.attachToTarget", {
                    targetId,
                    flatten: true,
                });
                let loaded: (() => void) | undefined;
                const imageProtocols = new Set<string>();

                cdp.listen(sessionId, (method, params) => {
                    if (
                        method === "Network.responseReceived" &&
                        String(params.response.url).includes("/image/")
                    ) {
                        imageProtocols.add(params.response.protocol);
                    }

                    if (method === "Page.loadEventFired") {
                        loaded?.();
                    }
                });
                await cdp.send("Page.enable", {}, sessionId);
                await cdp.send("Network.enable", {}, sessionId);

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
                const thumb =
                    await evaluate(`waitForImage('.thumb img[src*="/image/"]').then(img => ({
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
                // Close the viewer before pasting into the real composer. Check both protocols end to end.
                await evaluate(
                    `document.querySelector('.lightbox .icon-button[title="Close"]')?.click(); true`,
                );
                const paste = await evaluate(
                    readFileSync(new URL("./fixtures/paste-check.js", import.meta.url), "utf8"),
                );

                assert.equal(paste.uploads, 1);
                assert.equal(paste.uploadPath.split("?")[0], `/api/c/${id}/upload`);
                assert.ok(paste.bytes < paste.originalBytes);
                assert.deepEqual([...imageProtocols], [protocol === "https" ? "h2" : "http/1.1"]);
            } finally {
                chromium?.kill();

                if (chromium) {
                    await chromium.exited;
                }

                closeAll();
                await new Promise<void>((resolve) => server.close(() => resolve()));
                await app.close();
            }
        },
    );
}
