/** Real Chromium downloads and decodes four stored images on a CDP-emulated 4 Mbit/s, 40 ms link. */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { Chromium } from "../../src/server/browser/cdp.ts";
import { findBrowser } from "../../src/server/browser/discovery.ts";
import { raw, since, snapshot, type Counts } from "./counters.ts";

export async function measureImageNetwork(options: {
    base: string;
    token: string;
    paths: string[];
    profile: string;
    quiet: () => Promise<void>;
}): Promise<{ ms: number; counts: Counts } | { unavailable: string }> {
    const executable = findBrowser();

    if (executable === undefined) {
        return { unavailable: "no Chromium-based browser on this machine" };
    }

    mkdirSync(options.profile, { recursive: true });
    const chromium = await Chromium.launch(executable, options.profile, []);
    const cdp = chromium.connection;

    try {
        const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
        const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
        let loaded!: () => void;
        const load = new Promise<void>((resolve) => {
            loaded = resolve;
        });

        cdp.listen(sessionId, (method) => {
            if (method === "Page.loadEventFired") {
                loaded();
            }
        });

        await cdp.send("Page.enable", {}, sessionId);
        await cdp.send("Network.enable", {}, sessionId);
        await cdp.send(
            "Network.setExtraHTTPHeaders",
            {
                headers: { Authorization: `Bearer ${options.token}` },
            },
            sessionId,
        );
        // Establish the origin with an API document, not the app (no background streams or asset traffic).
        await cdp.send("Page.navigate", { url: `${options.base}/api/sessions` }, sessionId);
        await load;
        cdp.unlisten(sessionId);
        await cdp.send("Network.setCacheDisabled", { cacheDisabled: true }, sessionId);
        await cdp.send(
            "Network.emulateNetworkConditions",
            {
                offline: false,
                latency: 40,
                downloadThroughput: 500_000,
                uploadThroughput: 500_000,
                connectionType: "cellular4g",
            },
            sessionId,
        );
        await options.quiet();
        const before = snapshot();
        const answer = await cdp.send(
            "Runtime.evaluate",
            {
                expression: `(async () => {
                const start = performance.now();
                const images = await Promise.all(${raw.stringify(options.paths)}.map(async path => {
                    const response = await fetch(path, { cache: "no-store" });
                    if (!response.ok) throw new Error("image status " + response.status);
                    const blob = await response.blob();
                    const image = await createImageBitmap(blob);
                    const result = { bytes: blob.size, width: image.width, height: image.height };
                    image.close();
                    return result;
                }));
                return { ms: performance.now() - start, images };
            })()`,
                awaitPromise: true,
                returnByValue: true,
            },
            sessionId,
            60_000,
        );

        assert.equal(
            answer.exceptionDetails,
            undefined,
            "download and browser decode must succeed",
        );
        const value = answer.result.value as {
            ms: number;
            images: { bytes: number; width: number; height: number }[];
        };

        assert.ok(value.ms > 0 && Number.isFinite(value.ms));
        assert.equal(value.images.length, options.paths.length);
        assert.ok(
            value.images.every((image) => image.bytes > 0 && image.width > 0 && image.height > 0),
        );
        await options.quiet();

        return {
            ms: value.ms,
            counts: {
                ...since(before),
                "http.body.bytes": value.images.reduce((sum, image) => sum + image.bytes, 0),
            },
        };
    } finally {
        chromium.kill();
        await chromium.exited;
    }
}
