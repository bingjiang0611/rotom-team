import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { stream } from "../node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js";
test("OpenAI SDK does not redispatch rate-limit or server failures", async () => {
    let count = 0,
        status = 429;
    const server = createServer((request, response) => {
        count++;
        request.resume();
        response.writeHead(status, { "content-type": "application/json" });
        response.end(
            JSON.stringify({ error: { message: "Injected failure", type: "test_error" } }),
        );
    });

    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const model = {
        ...openaiProvider()
            .getModels()
            .find((model) => model.api === "openai-responses")!,
        baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    };

    try {
        for (const code of [429, 503]) {
            status = code;
            const before = count;
            const result = await stream(model, normalizeContext({ messages: [] }), {
                apiKey: "sk-fake",
            }).result();

            assert.equal(result.stopReason, "error");
            assert.equal(count - before, 1);
        }
    } finally {
        server.closeAllConnections();
        await new Promise<void>((done) => server.close(() => done()));
    }
});
