import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import {
    attachmentImages,
    attachmentText,
    uploadedAttachments,
} from "../src/server/attachments.ts";
import { cleanUp, root } from "./helpers.ts";

const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
);

after(cleanUp);

test("native attachments accept only completed conversation uploads and send images to the model", async () => {
    const directory = join(root, "uploads", "1");
    const path = join(directory, "image.png");

    mkdirSync(directory, { recursive: true });
    writeFileSync(path, PNG);
    const files = uploadedAttachments(directory, [
        { path, name: "pasted image.png", mime: "image/png", size: PNG.length },
    ]);

    assert.match(attachmentText("describe it", files), /pasted image\.png/);
    const images = await attachmentImages(files, true);

    assert.equal(images.length, 1);
    assert.equal(images[0]?.type, "image");
    assert.equal(images[0]?.mimeType, "image/png");
    assert.ok(images[0]?.data);
    await assert.rejects(attachmentImages(files, false), /does not accept images/);
    assert.throws(
        () =>
            uploadedAttachments(directory, [
                { path, name: "image.png", mime: "image/png", size: PNG.length + 1 },
            ]),
        /Invalid uploaded attachment/,
    );
});
