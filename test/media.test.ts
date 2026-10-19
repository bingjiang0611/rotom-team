// Smaller copies of stored message images: made once, kept as files, visibility checked on every request.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { deflateSync, crc32 } from "node:zlib";
import { sniffImage } from "../src/server/http/assets.ts";
import {
    EDGE,
    type ImageSource,
    MediaStore,
    type Resize,
    type Resized,
    sipsResize,
} from "../src/server/media.ts";
import { imageFixture } from "./perf/images.ts";

const dirs: string[] = [];

after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const tempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "rotom-media-"));

    dirs.push(dir);

    return dir;
};

/** Session 1 owns entry 10, which session 2 (a fork) inherits; session 3 sees nothing. */
function fixture(mimeType = "image/png") {
    const calls = { stored: 0, visible: 0, resize: 0 };
    const data = imageFixture(64, 40, 7);
    const sees = (id: number) => id === 1 || id === 2;
    const source: ImageSource = {
        stored: async (id, entryId, index) => {
            calls.stored++;

            return sees(id) && entryId === 10 && index === 0
                ? { owner: 1, mimeType, data }
                : undefined;
        },
        visible: async (id, entryId, owner) => {
            calls.visible++;

            return sees(id) && entryId === 10 && owner === 1;
        },
    };
    let answer: () => ReturnType<Resize> = async () => ({
        data: Buffer.from("small copy"),
        mimeType: "image/jpeg",
    });

    const resize: Resize = (input, type, edge) => {
        calls.resize++;
        assert.deepEqual(input, data);
        assert.equal(type, mimeType);
        assert.ok(edge === EDGE.thumb || edge === EDGE.preview);

        return answer();
    };

    return { calls, source, resize, answer: (next: typeof answer) => (answer = next) };
}

test("a copy is made once, then served from its file after only a visibility check", async () => {
    const dir = tempDir();
    const { calls, source, resize } = fixture();
    const store = new MediaStore(dir, source, resize);

    const first = await store.image(1, 10, 0, "thumb");

    assert.deepEqual(first, { data: Buffer.from("small copy"), mimeType: "image/jpeg" });
    assert.deepEqual(calls, { stored: 1, visible: 0, resize: 1 });

    const again = await store.image(1, 10, 0, "thumb");

    assert.deepEqual(again, first);
    assert.deepEqual(calls, { stored: 1, visible: 1, resize: 1 }, "the original is not read again");

    // A fork that inherits the entry gets it too, still checked; a session that cannot see it gets nothing.
    assert.deepEqual(await store.image(2, 10, 0, "thumb"), first);
    assert.equal(await store.image(3, 10, 0, "thumb"), undefined);
    assert.deepEqual(calls, { stored: 1, visible: 3, resize: 1 });

    // Kept on disk: another process (a restart) reads the record, not the image.
    const restarted = fixture();
    const reopened = new MediaStore(dir, restarted.source, restarted.resize);

    assert.deepEqual(await reopened.image(1, 10, 0, "thumb"), first);
    assert.equal(await reopened.image(3, 10, 0, "thumb"), undefined);
    assert.deepEqual(restarted.calls, { stored: 0, visible: 2, resize: 0 });
    assert.deepEqual(readdirSync(join(dir, "tmp")), [], "no temporary files are left");
});

test("each size is its own copy, and an image with no smaller copy sends the original", async () => {
    const { calls, source, resize, answer } = fixture();
    const store = new MediaStore(tempDir(), source, resize);

    await store.image(1, 10, 0, "thumb");
    answer(async () => "original");
    assert.equal(await store.image(1, 10, 0, "preview"), "original");
    assert.equal(await store.image(1, 10, 0, "preview"), "original");
    assert.deepEqual(
        await store.image(1, 10, 0, "thumb"),
        { data: Buffer.from("small copy"), mimeType: "image/jpeg" },
        "the second size is added to the first's record",
    );
    assert.equal(calls.resize, 2);
});

test("requests for the same copy at once share one resize; other sessions are checked for themselves", async () => {
    const { calls, source, resize } = fixture();
    const store = new MediaStore(tempDir(), source, resize);
    const results = await Promise.all([
        store.image(1, 10, 0, "thumb"),
        store.image(1, 10, 0, "thumb"),
        store.image(1, 10, 0, "thumb"),
        store.image(3, 10, 0, "thumb"),
    ]);

    assert.equal(results[3], undefined);
    assert.deepEqual(results[0], results[1]);
    assert.deepEqual(results[0], results[2]);
    assert.equal(calls.resize, 1);
});

test("a failed resize sends the original, is not retried in this process, and is not remembered", async () => {
    const dir = tempDir();
    const { calls, source, resize, answer } = fixture();
    const store = new MediaStore(dir, source, resize);
    const logged = console.error;

    answer(async () => {
        throw new Error("sips failed");
    });

    console.error = () => {};

    try {
        assert.equal(await store.image(1, 10, 0, "thumb"), "original");
        assert.equal(await store.image(1, 10, 0, "thumb"), "original");
    } finally {
        console.error = logged;
    }

    assert.equal(calls.resize, 1);
    assert.deepEqual(readdirSync(join(dir, "entries")), []);
});

test("without a resizer, or for bad requests, nothing is made", async () => {
    const { calls, source, resize } = fixture("image/svg+xml");

    assert.equal(
        await new MediaStore(tempDir(), source, null).image(1, 10, 0, "thumb"),
        "original",
    );
    const store = new MediaStore(tempDir(), source, resize);

    assert.equal(await store.image(1, 10, 0, "thumb"), undefined, "a type the app does not serve");
    assert.equal(await store.image(1, 10, -1, "thumb"), undefined);
    assert.equal(await store.image(1, 10.5, 0, "thumb"), undefined);
    assert.equal(calls.resize, 0);
});

/** An RGBA PNG of noise with transparency, stored uncompressed so a smaller copy is worth making. */
function transparentPng(width: number, height: number): Buffer {
    const pixels = Buffer.alloc(height * (1 + width * 4));
    let value = 1;

    for (let row = 0; row < height; row++) {
        for (let column = 1; column <= width * 4; column++) {
            value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
            pixels[row * (1 + width * 4) + column] = value >>> 24;
        }
    }

    const chunk = (kind: string, body: Buffer) => {
        const frame = Buffer.alloc(4);
        const checksum = Buffer.alloc(4);

        frame.writeUInt32BE(body.length);
        checksum.writeUInt32BE(crc32(Buffer.concat([Buffer.from(kind), body])));

        return Buffer.concat([frame, Buffer.from(kind), body, checksum]);
    };

    const header = Buffer.alloc(13);

    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 6;

    return Buffer.concat([
        Buffer.from("89504e470d0a1a0a", "hex"),
        chunk("IHDR", header),
        chunk("IDAT", deflateSync(pixels, { level: 0 })),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

const smaller = (resized: Resized) => {
    assert.notEqual(resized, "original");

    return resized as Exclude<Resized, "original">;
};

const pngSize = (png: Buffer) => [png.readUInt32BE(16), png.readUInt32BE(20)];

test(
    "sips makes a smaller JPEG, keeps PNG for transparency, and never upscales",
    {
        skip: process.platform !== "darwin" && "sips is macOS only",
    },
    async () => {
        const dir = tempDir();
        const photo = imageFixture(1024, 640, 3);
        const thumb = smaller(await sipsResize(photo, "image/png", 480, dir));

        assert.equal(thumb.mimeType, "image/jpeg");
        assert.equal(sniffImage(thumb.data), "image/jpeg");
        assert.ok(thumb.data.length < photo.length / 10);

        const clear = smaller(await sipsResize(transparentPng(1200, 300), "image/png", 480, dir));

        assert.equal(clear.mimeType, "image/png");
        assert.deepEqual(pngSize(clear.data), [480, 120]);

        assert.equal(
            await sipsResize(imageFixture(300, 200, 1), "image/png", 480, dir),
            "original",
        );
        assert.equal(await sipsResize(photo, "image/gif", 480, dir), "original");
        assert.deepEqual(readdirSync(dir), []);
    },
);
