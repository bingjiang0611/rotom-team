// The same image counter must observe older entryImage-only baselines and the shared storedImage path, exactly once.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { probeImages } from "./perf/images.ts";

for (const shared of [false, true]) {
    test(`image probe observes ${shared ? "nested entryImage/storedImage" : "legacy entryImage-only"} decoding once`, async () => {
        const methods = {
            visibleEntry: async () => undefined,
            async entryImage() {
                await this.visibleEntry();

                return { mimeType: "image/png", data: Buffer.from("eA==", "base64"), owner: 1 };
            },
        };
        const transcripts: Parameters<typeof probeImages>[0] = methods;

        if (shared) {
            const decode = methods.entryImage;

            transcripts.storedImage = () => decode.call(methods);
            transcripts.entryImage = (...args) => transcripts.storedImage!(...args);
        }

        const original = transcripts.entryImage;
        const probe = probeImages(transcripts);
        const server = createServer((request, response) =>
            probe.run(request, response, async () => {
                const image = await transcripts.entryImage(1 as ConversationId, 1, 0);

                response.end(image!.data);
            }),
        );

        try {
            server.listen(0, "127.0.0.1");
            await once(server, "listening");
            const port = (server.address() as { port: number }).port;
            const response = await fetch(`http://127.0.0.1:${port}/api/c/1/image/1/0`);

            assert.equal(await response.text(), "x");
            assert.deepEqual(probe.report(1).counts, {
                "image.lookup.calls": 1,
                "image.decode.calls": 1,
                "image.decode.chars": 4,
                "image.decode.bytes": 1,
            });
        } finally {
            probe.restore();
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }

        assert.equal(transcripts.entryImage, original);
        assert.equal(
            "storedImage" in transcripts,
            shared,
            "do not add a method to older implementations",
        );
    });
}
