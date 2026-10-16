/** Actual pinned context measurements through Team's gate, no real model accounts or terminal UI. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RotomExecutions } from "../src/server/rotom-executions.ts";
import { verifyRotomKernel } from "../src/server/rotom-kernel.ts";

process.umask(0o077);
const root = realpathSync(mkdtempSync(join(tmpdir(), "rotom-context-proof-"))),
    data = join(root, "data"),
    home = join(data, "kernel-homes/alice"),
    workspace = join(root, "workspace");
let requests = 0;
const server = createServer(async (req, res) => {
    let body = "";

    for await (const chunk of req) {
        body += chunk;
    }

    const input = JSON.parse(body);

    assert.equal(input.model, "context-model");
    requests++;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: input.model, choices: [{ index: 0, delta: { role: "assistant", content: "DONE" }, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
});

server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = (server.address() as { port: number }).port;

mkdirSync(join(home, ".pi/agent"), { recursive: true });
mkdirSync(join(data, "team-agent"), { recursive: true });
mkdirSync(workspace, { recursive: true });
writeFileSync(join(data, "team-agent/APPEND_SYSTEM.md"), "PRIVATE_CONTEXT_TEXT_MUST_NOT_LEAK");
writeFileSync(
    join(data, "team-agent/settings.json"),
    JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }),
);
writeFileSync(
    join(home, ".pi/agent/models.json"),
    JSON.stringify({
        providers: {
            "context-fixture": {
                baseUrl: `http://127.0.0.1:${port}/v1`,
                api: "openai-completions",
                apiKey: "synthetic-only",
                models: [
                    {
                        id: "context-model",
                        contextWindow: 32000,
                        maxTokens: 1024,
                        reasoning: false,
                        input: ["text"],
                    },
                ],
            },
        },
    }),
);
const executions = new RotomExecutions(data, async () => {});

try {
    executions.journal.bind("context", {
        memberId: "alice",
        kernelVersion: verifyRotomKernel().version,
        accountGeneration: "synthetic-only",
        provider: "context-fixture",
        model: "context-model",
        configurationDigest: "context-fixture",
        home,
        workspace,
    });

    const command = async (requestId: string, text: string) => {
        let result: any;
        const receipt = await executions.run("context", requestId, text, {
            onNativeResult: (value) => {
                result = value;
            },
        });

        assert.equal(receipt.status, "handled");
        assert.equal(result.context.type, "native-context");
        assert.ok(!JSON.stringify(result).includes("PRIVATE_CONTEXT_TEXT_MUST_NOT_LEAK"));
        assert.ok(!JSON.stringify(result).includes('"text":'));
        assert.ok(!JSON.stringify(result).includes('"entries":'));

        return result.context;
    };

    const empty = await command("empty-context", "/context");

    assert.equal(requests, 0, "empty-session context does not run a model probe");
    assert.equal(empty.captured, false);
    assert.ok(empty.estimatedTokens > 0);
    assert.ok(
        empty.categories.some((category: { label: string }) => category.label === "System Prompt"),
    );
    const prompt = await executions.run("context", "ordinary-prompt", "Say DONE.");

    assert.equal(prompt.status, "settled");
    assert.equal(requests, 1);
    const usage = await command("context-usage", "/context usage");
    const injections = await command("context-injections", "/context injections");

    assert.equal(usage.captured, true);
    assert.equal(usage.reported.contextWindow, 32000);
    assert.ok(usage.estimatedTokens > 0);
    assert.equal(injections.captured, true);
    assert.ok(injections.groups.some((group: { native: boolean }) => group.native));
    assert.equal(requests, 1, "opening either view does not make additional inference");
    assert.equal(executions.journal.usage("context").length, 1, "context is not billed");
    const segment = executions.journal.session("context");
    const before = readFileSync(segment.sessionFile!, "utf8");
    const duplicate = await executions.run("context", "context-usage", "/context usage");

    assert.equal(duplicate.status, "handled");
    assert.equal(
        readFileSync(segment.sessionFile!, "utf8"),
        before,
        "duplicate does not execute again",
    );
    console.log(
        JSON.stringify({
            version: verifyRotomKernel().version,
            passed: true,
            realProvider: false,
            emptyContextNoProbe: true,
            usageAndInjections: true,
            rawTextNotReturned: true,
            requests,
        }),
    );
} finally {
    await executions.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
}
