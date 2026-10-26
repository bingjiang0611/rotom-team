// The same image counter must observe older entryImage-only baselines and the shared storedImage path, exactly once.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
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
            await probe.settled();
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

for (const terminal of ["finish", "close"] as const) {
    test(`image probe waits for every response and preserves ${terminal} evidence`, async () => {
        const probe = probeImages({
            visibleEntry: async () => undefined,
            entryImage: async () => undefined,
        });
        const requests = [new IncomingMessage(new Socket()), new IncomingMessage(new Socket())];
        const responses = requests.map((request) => {
            request.url = "/api/c/1/image/1/0";
            const response = new ServerResponse(request);

            probe.run(request, response, () => response.end("body"));

            return response;
        });

        try {
            assert.throws(() => probe.report(2), /unfinished\/aborted/);
            let completed = false;
            const waiting = probe.settled().then(() => {
                completed = true;
            });

            responses[0]!.emit("finish");
            // Drain promise reactions too: an immediate no-op wait must fail this assertion.
            await new Promise<void>((resolve) => queueMicrotask(resolve));
            assert.equal(completed, false, "one finished response cannot complete the batch");
            responses[1]!.emit(terminal);
            await waiting;
            assert.equal(completed, true);

            if (terminal === "finish") {
                assert.equal(probe.report(2).counts["image.decode.calls"], 0);
            } else {
                assert.throws(() => probe.report(2), /unfinished\/aborted/);
            }
        } finally {
            probe.restore();

            for (const request of requests) {
                request.destroy();
            }
        }
    });
}
