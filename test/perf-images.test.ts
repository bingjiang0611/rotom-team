// Real HTTP + Durable image retrieval on isolated kernel-mode data. No native prompt or model account is used.
import { cleanUp, context, owner, root, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { crc32, inflateSync } from "node:zlib";
import type { JsonValue } from "@earendil-works/chord";
import { PocketApp } from "../src/server/app.ts";
import { NATIVE_ENTRY } from "../src/server/entry-format.ts";
import { createHandler } from "../src/server/http.ts";
import { sniffImage } from "../src/server/http/assets.ts";
import { imageFixture, probeImages } from "./perf/images.ts";

after(cleanUp);

test("the fixed image fixture is a deterministic valid PNG of the declared dimensions", () => {
    const png = imageFixture(32, 24, 1);

    assert.deepEqual(png, imageFixture(32, 24, 1));
    assert.notDeepEqual(png, imageFixture(32, 24, 2));
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    const kinds: string[] = [];

    for (let at = 8; at < png.length;) {
        const length = png.readUInt32BE(at);
        const kind = png.toString("ascii", at + 4, at + 8);
        const body = png.subarray(at + 8, at + 8 + length);

        kinds.push(kind);
        assert.equal(
            png.readUInt32BE(at + 8 + length),
            crc32(png.subarray(at + 4, at + 8 + length)),
        );

        if (kind === "IHDR") {
            assert.equal(body.readUInt32BE(0), 32);
            assert.equal(body.readUInt32BE(4), 24);
        }

        if (kind === "IDAT") {
            const pixels = inflateSync(body);

            assert.equal(pixels.length, 24 * (1 + 32 * 3));

            for (let row = 0; row < 24; row++) {
                assert.equal(pixels[row * (1 + 32 * 3)], 0);
            }
        }

        at += length + 12;
    }

    assert.deepEqual(kinds, ["IHDR", "IDAT", "IEND"]);
});

test("image probes measure actual concurrent lookup/decode/finish, preserve binary semantics, and reject missing phases", async () => {
    const app = await PocketApp.open({
        dataDir: join(realpathSync(root), "image-probe"),
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
                        resolve: async () => ({ auth: { apiKey: "fixture" }, source: "test" }),
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
    const originalFrom = Buffer.from;
    const originalEntryImage = app.transcripts.entryImage;
    const originalVisibleEntry = app.transcripts.visibleEntry;
    let duplicateDecode = false;

    // A sensitivity control, enabled only after the normal assertions: unchanged response, twice the decode work.
    app.transcripts.entryImage = async function (...args) {
        const image = await originalEntryImage.apply(this, args);

        if (duplicateDecode && image) {
            Buffer.from(image.data.toString("base64"), "base64");
        }

        return image;
    };

    const controlledEntryImage = app.transcripts.entryImage;
    const probe = probeImages(app.transcripts);
    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });
    const server = createServer((request, response) =>
        probe.run(request, response, () => handler(request, response)),
    );

    try {
        const user = owner(app);
        const { id } = await app.commands.createSession(user, { backend: "rotom" });
        const foreign = await app.commands.createSession(user, { backend: "rotom" });
        const bytes = [imageFixture(32, 24, 1), imageFixture(16, 16, 2)];
        const content: JsonValue[] = [
            { type: "text", text: "before" },
            { type: "image", mimeType: "image/png", data: bytes[0]!.toString("base64") },
            { type: "text", text: "between images" },
            { type: "image", mimeType: "image/png", data: bytes[1]!.toString("base64") },
        ];
        const entry = await app.harness.commit(
            (tx) =>
                tx.appendEntry(id, {
                    kind: NATIVE_ENTRY,
                    data: {
                        entry: {
                            type: "message",
                            id: "fixture",
                            parentId: null,
                            message: { role: "user", content, timestamp: 0 },
                        },
                    } as JsonValue,
                }),
            context,
        );
        const token = app.config.addDevice(user.id).token;

        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const get = (path: string, authenticated = true) =>
            fetch(`${base}/api/c/${path}`, {
                headers: authenticated ? { authorization: `Bearer ${token}` } : {},
            });
        const indices = [0, 1, 0];

        await Promise.all(
            indices.map(async (index) => {
                const response = await get(`${id}/image/${entry.id}/${index}`);

                assert.equal(response.status, 200);
                assert.equal(response.headers.get("content-type"), "image/png");
                assert.equal(
                    response.headers.get("cache-control"),
                    "private, max-age=31536000, immutable",
                );
                assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes[index]);
            }),
        );
        Buffer.from("dW5yZWxhdGVk", "base64");
        const measured = probe.report(3);

        assert.deepEqual(measured.counts, {
            "image.lookup.calls": 3,
            "image.decode.calls": 3,
            "image.decode.chars": indices.reduce(
                (sum, index) => sum + bytes[index]!.toString("base64").length,
                0,
            ),
            "image.decode.bytes": indices.reduce((sum, index) => sum + bytes[index]!.length, 0),
        });
        assert.ok(
            Object.values(measured.timings).every((value) => Number.isFinite(value) && value >= 0),
        );
        assert.ok(
            measured.timings.imageLookupMs +
                measured.timings.imageDecodeMs +
                measured.timings.imageSendFinishMs <=
                measured.timings.imageServerMs,
        );
        assert.throws(() => probe.report(4), /every image request/);

        probe.reset();
        duplicateDecode = true;
        const injected = await get(`${id}/image/${entry.id}/0`);

        assert.deepEqual(Buffer.from(await injected.arrayBuffer()), bytes[0]);
        const regression = probe.report(1).counts;

        assert.equal(regression["image.lookup.calls"], 1);
        assert.equal(regression["image.decode.calls"], 2);
        assert.equal(regression["image.decode.bytes"], 2 * bytes[0]!.length);
        assert.throws(
            () => assert.equal(regression["image.decode.calls"], 1),
            assert.AssertionError,
        );
        duplicateDecode = false;

        for (const path of [
            `${id}/image/${entry.id}/-1`,
            `${id}/image/${entry.id}/0.5`,
            `${id}/image/${entry.id}/2`,
            `${id}/image/999999/0`,
            `${foreign.id}/image/${entry.id}/0`,
        ]) {
            probe.reset();
            const response = await get(path);

            assert.equal(response.status, 404);
            await response.arrayBuffer();
            assert.throws(() => probe.report(1), /error response/);
        }

        probe.reset();
        const denied = await get(`${id}/image/${entry.id}/0`, false);

        assert.equal(denied.status, 401);
        await denied.arrayBuffer();
        assert.throws(() => probe.report(1), /error response/);

        // Smaller copies (`?size=`): a large image gets one; a small one is sent as it is; visibility still holds.
        const large = imageFixture(1024, 640, 3);
        const largeEntry = await app.harness.commit(
            (tx) =>
                tx.appendEntry(id, {
                    kind: NATIVE_ENTRY,
                    data: {
                        entry: {
                            type: "message",
                            id: "large",
                            parentId: "fixture",
                            message: {
                                role: "user",
                                content: [
                                    {
                                        type: "image",
                                        mimeType: "image/png",
                                        data: large.toString("base64"),
                                    },
                                ],
                                timestamp: 1,
                            },
                        },
                    } as JsonValue,
                }),
            context,
        );

        for (const attempt of ["first", "kept"]) {
            const thumb = await get(`${id}/image/${largeEntry.id}/0?size=thumb`);
            const body = Buffer.from(await thumb.arrayBuffer());

            assert.equal(thumb.status, 200, attempt);
            assert.equal(thumb.headers.get("content-type"), sniffImage(body));
            assert.equal(
                thumb.headers.get("cache-control"),
                "private, max-age=31536000, immutable",
            );

            if (process.platform === "darwin") {
                assert.ok(body.length < large.length / 10, `${attempt}: ${body.length} bytes`);
            } else {
                assert.deepEqual(body, large);
            }

            const foreignThumb = await get(`${foreign.id}/image/${largeEntry.id}/0?size=thumb`);

            assert.equal(foreignThumb.status, 404, attempt);
            await foreignThumb.arrayBuffer();
        }

        const small = await get(`${id}/image/${entry.id}/0?size=preview`);

        assert.equal(small.headers.get("content-type"), "image/png");
        assert.deepEqual(Buffer.from(await small.arrayBuffer()), bytes[0]);

        for (const [path, status] of [
            [`${id}/image/${largeEntry.id}/0?size=huge`, 400],
            [`${id}/image/${largeEntry.id}/1?size=thumb`, 404],
        ] as const) {
            const response = await get(path);

            assert.equal(response.status, status, path);
            await response.arrayBuffer();
        }

        const deniedThumb = await get(`${id}/image/${largeEntry.id}/0?size=thumb`, false);

        assert.equal(deniedThumb.status, 401);
        await deniedThumb.arrayBuffer();

        // Deterministic lifecycle control: an observed request with neither finish nor a valid body cannot become
        // a measured zero, including when close arrives before finish. No timeout or artificial timing delay.
        probe.reset();
        const unfinished = new IncomingMessage(new Socket());
        const closed = new ServerResponse(unfinished);

        unfinished.url = `/api/c/${id}/image/${entry.id}/0`;
        probe.run(unfinished, closed, () => {});
        assert.throws(() => probe.report(1), /unfinished\/aborted/);
        closed.emit("close");
        assert.throws(() => probe.report(1), /unfinished\/aborted/);
        unfinished.destroy();
    } finally {
        server.closeAllConnections();
        server.close();
        probe.restore();
        assert.equal(Buffer.from, originalFrom);
        assert.equal(app.transcripts.entryImage, controlledEntryImage);
        assert.equal(app.transcripts.visibleEntry, originalVisibleEntry);
        app.transcripts.entryImage = originalEntryImage;
        await app.close();
    }
});
