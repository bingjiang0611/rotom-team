/** Pinned SoL-Pi auxiliary inference through Team's payer gate; synthetic loopback models only. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RotomExecutions } from "../src/server/rotom-executions.ts";
import { verifyRotomKernel } from "../src/server/rotom-kernel.ts";

process.umask(0o077);
const root = realpathSync(mkdtempSync(join(tmpdir(), "rotom-reducer-proof-"))),
    data = join(root, "data"),
    home = join(data, "kernel-homes/alice"),
    workspace = join(root, "workspace"),
    provider = "reducer-fixture",
    model = "fixture-model";
let requests = 0,
    reducerRequests = 0,
    inferenceChecks = 0;
const server = createServer(async (req, res) => {
    let body = "";

    for await (const chunk of req) {
        body += chunk;
    }

    const input = JSON.parse(body);

    assert.equal(input.model, model, "foreign reducer models must never reach the provider");
    requests++;
    const reducer = !input.tools?.length;
    const hasResult = input.messages.some((message: { role: string }) => message.role === "tool");

    if (reducer) {
        reducerRequests++;
    }

    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const emit = (delta: unknown, finish: string | null = null) =>
        res.write(
            `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );

    emit({ role: "assistant" });

    if (!reducer && !hasResult) {
        emit({
            tool_calls: [
                {
                    index: 0,
                    id: "large-result",
                    type: "function",
                    function: { name: "bash", arguments: JSON.stringify({ command: "npm test" }) },
                },
            ],
        });
        emit({}, "tool_calls");
    } else {
        // Deliberately invalid reducer evidence tests the raw-output fallback after a billable response.
        emit({ content: reducer ? "INVALID_RECEIPT" : "DONE" });
        emit({}, "stop");
    }

    res.write(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model, choices: [], usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
});

server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = (server.address() as { port: number }).port;

mkdirSync(join(home, ".pi/agent"), { recursive: true });
mkdirSync(join(data, "team-agent"), { recursive: true });
mkdirSync(workspace, { recursive: true });
writeFileSync(
    join(home, ".pi/agent/models.json"),
    JSON.stringify({
        providers: {
            [provider]: {
                baseUrl: `http://127.0.0.1:${port}/v1`,
                api: "openai-completions",
                apiKey: "synthetic-only",
                models: [model, "foreign-model"].map((id) => ({
                    id,
                    contextWindow: 32000,
                    maxTokens: 1024,
                    reasoning: false,
                    input: ["text"],
                })),
            },
        },
    }),
);
writeFileSync(
    join(data, "team-agent/settings.json"),
    JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }),
);
writeFileSync(
    join(workspace, "package.json"),
    JSON.stringify({ private: true, scripts: { test: "node fixture.mjs" } }),
);
writeFileSync(
    join(workspace, "fixture.mjs"),
    'console.log("fixture test passed\\n".repeat(500));\n',
);
const executions = new RotomExecutions(data, async (_binding, operation) => {
    if (operation === "inference") {
        inferenceChecks++;
    }
});

try {
    for (const reducerModel of [model, "foreign-model"]) {
        if (reducerModel !== model) {
            writeFileSync(
                join(data, "team-agent/sol-pi.json"),
                JSON.stringify({
                    version: 1,
                    evidencePreservingReducer: true,
                    evidencePreservingReducerProvider: provider,
                    evidencePreservingReducerModel: reducerModel,
                }),
            );
        }

        const id = `reducer-${reducerModel}`;
        const beforeRequests = requests,
            beforeChecks = inferenceChecks,
            beforeReducer = reducerRequests;

        await executions.journal.bind(id, {
            memberId: "alice",
            kernelVersion: verifyRotomKernel().version,
            accountGeneration: "synthetic-only",
            provider,
            model,
            configurationDigest: reducerModel,
            home,
            workspace,
        });
        const result = await executions.run(id, "request-once", "Run npm test and finish.");

        const sameModel = reducerModel === model;

        assert.equal(result.status, sameModel ? "settled" : "unknown", JSON.stringify(result));
        const auxiliary = (await executions.journal.entries(id)).filter(
            (row) => row.entry.type === "usage",
        );

        assert.equal(requests - beforeRequests, sameModel ? 3 : 2);
        assert.equal(inferenceChecks - beforeChecks, sameModel ? 3 : 2);
        assert.equal(reducerRequests - beforeReducer, sameModel ? 1 : 0);
        assert.equal(auxiliary.length, sameModel ? 1 : 0);
        assert.equal((await executions.journal.usage(id)).length, sameModel ? 3 : 1);
        assert.ok((await executions.journal.usage(id)).every((row) => row.memberId === "alice"));

        if (sameModel) {
            assert.equal(auxiliary[0]!.entry.kind, "sol_pi_reducer");
            assert.deepEqual(
                (await executions.journal.usage(id)).map(
                    (row) => (row.raw as { totalTokens: number }).totalTokens,
                ),
                [14, 14, 14],
            );
        }

        const duplicate = await executions.run(id, "request-once", "Run npm test and finish.");

        assert.equal(duplicate.id, result.id);
        assert.equal(requests - beforeRequests, sameModel ? 3 : 2, "duplicate never redispatches");
    }

    console.log(
        JSON.stringify({
            version: verifyRotomKernel().version,
            realProvider: false,
            passed: true,
            requests,
            reducerRequests,
            inferenceChecks,
            auxiliaryUsageImported: true,
            foreignReducerBlocked: true,
            foreignUsageFencedUnknown: true,
            invalidReceiptFallsBack: true,
            duplicateNoDispatch: true,
        }),
    );
} finally {
    await executions.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
}
