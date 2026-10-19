/** A large synthetic pasted PNG: browser preparation plus real upload on a 4 Mbit/s uplink. No model call. */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { Chromium } from "../../src/server/browser/cdp.ts";
import { findBrowser } from "../../src/server/browser/discovery.ts";
import { since, snapshot, type Counts } from "./counters.ts";

export async function measurePasteNetwork(options: {
    base: string;
    token: string;
    conversation: number;
    profile: string;
    quiet: () => Promise<void>;
}): Promise<{ ms: number; counts: Counts } | { unavailable: string }> {
    const executable = findBrowser();

    if (!executable) {
        return { unavailable: "no Chromium-based browser on this machine" };
    }

    mkdirSync(options.profile, { recursive: true });
    const chromium = await Chromium.launch(executable, options.profile, []);
    const cdp = chromium.connection;

    try {
        const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
        const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
        let loaded!: () => void;
        const load = new Promise<void>((r) => (loaded = r));

        cdp.listen(sessionId, (method) => {
            if (method === "Page.loadEventFired") {
                loaded();
            }
        });
        await cdp.send("Page.enable", {}, sessionId);
        await cdp.send("Network.enable", {}, sessionId);
        await cdp.send(
            "Network.setExtraHTTPHeaders",
            { headers: { Authorization: `Bearer ${options.token}` } },
            sessionId,
        );
        await cdp.send("Page.navigate", { url: `${options.base}/api/sessions` }, sessionId);
        await load;
        cdp.unlisten(sessionId);
        const setup = await cdp.send(
            "Runtime.evaluate",
            {
                expression: `(async () => {
            // No helper in older revisions means today's unchanged paste behavior, not a skipped benchmark.
            const response = await fetch('/pasted-image.js', {cache:'no-store'});
            window.preparePaste = response.ok ? (await import('/pasted-image.js')).preparePastedImage : file => file;
            const canvas = new OffscreenCanvas(3000, 1500), ctx = canvas.getContext('2d');
            const pixels = ctx.createImageData(3000, 1500);
            let state = 137;
            for (let i = 0; i < pixels.data.length; i += 4) {
                for (let j = 0; j < 3; j++) {
                    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
                    pixels.data[i+j] = state & 255;
                }
                pixels.data[i+3] = 255;
            }
            ctx.putImageData(pixels,0,0);
            window.pasteFixture = new File([await canvas.convertToBlob({type:'image/png'})], 'clipboard.png', {type:'image/png'});
            return true;
        })()`,
                awaitPromise: true,
                returnByValue: true,
            },
            sessionId,
            60_000,
        );

        assert.equal(setup.exceptionDetails, undefined);
        await cdp.send(
            "Network.emulateNetworkConditions",
            { offline: false, latency: 40, downloadThroughput: 500_000, uploadThroughput: 500_000 },
            sessionId,
        );
        await options.quiet();
        const before = snapshot();
        const answer = await cdp.send(
            "Runtime.evaluate",
            {
                expression: `(async () => {
            const start = performance.now();
            const file = await preparePaste(pasteFixture);
            const response = await fetch('/api/c/${options.conversation}/upload?name=' + encodeURIComponent(file.name), {
                method: 'POST', headers: {'x-pocket':'1', 'content-type':file.type}, body:file
            });
            if (!response.ok) throw new Error('upload status ' + response.status);
            const attachment = await response.json();
            if (attachment.size !== file.size) throw new Error('upload size mismatch');
            const bitmap = await createImageBitmap(file);
            const result = {ms: performance.now()-start, bytes:file.size, originalBytes:pasteFixture.size, width:bitmap.width, height:bitmap.height};
            bitmap.close();
            return result;
        })()`,
                awaitPromise: true,
                returnByValue: true,
            },
            sessionId,
            120_000,
        );

        assert.equal(answer.exceptionDetails, undefined, "prepare, upload and decode must succeed");
        const value = answer.result.value as {
            ms: number;
            bytes: number;
            originalBytes: number;
            width: number;
            height: number;
        };

        assert.ok(value.bytes > 0 && value.bytes <= value.originalBytes);
        assert.ok(value.width > 0 && value.height > 0);
        assert.ok(value.ms > 0 && Number.isFinite(value.ms));
        await options.quiet();

        return { ms: value.ms, counts: { ...since(before), "http.upload.bytes": value.bytes } };
    } finally {
        chromium.kill();
        await chromium.exited;
    }
}
