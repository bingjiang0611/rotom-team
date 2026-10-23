import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import { requestAsset } from "./perf/static-assets.ts";

test("static asset requests preserve raw gzip bodies and validators", async () => {
    const body = Buffer.from("synthetic static asset\n");
    const encoded = gzipSync(body);
    const server = createServer((request, response) => {
        if (request.headers["if-none-match"] === '"asset"') {
            response.writeHead(304, { etag: '"asset"', "content-encoding": "gzip" });
            response.end();

            return;
        }

        response.writeHead(200, { etag: '"asset"', "content-encoding": "gzip" });
        response.end(encoded);
    });

    server.listen(0, "127.0.0.1");

    try {
        await once(server, "listening");
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const first = await requestAsset(base);
        const validated = await requestAsset(base, first.etag);

        assert.equal(first.status, 200);
        assert.deepEqual(first.body, encoded);
        assert.equal(first.etag, '"asset"');
        assert.equal(validated.status, 304);
        assert.equal(validated.body.length, 0);
    } finally {
        server.close();
        await once(server, "close");
    }
});
