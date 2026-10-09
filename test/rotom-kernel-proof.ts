/** Opt-in: actual pinned rotom product and native tools against a loopback scripted model, no real accounts. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { startRotomKernel, verifyRotomKernel } from "../src/server/rotom-kernel.ts";

process.umask(0o077);
const root = realpathSync(mkdtempSync(join(tmpdir(), "rotom-kernel-proof-"))),
    home = join(root, "home"),
    workspace = join(root, "workspace");

mkdirSync(home, { mode: 0o700 });
mkdirSync(workspace, { mode: 0o700 });
mkdirSync(join(home, ".pi/agent"), { recursive: true, mode: 0o700 });
let requests = 0,
    toolReadObserved = false;
const server = createServer(async (req, res) => {
    try {
        assert.equal(req.url, "/v1/chat/completions");
        let body = "";

        for await (const chunk of req) {
            body += chunk;
        }

        const input = JSON.parse(body);

        assert.equal(input.model, "kernel-fixture");
        requests++;
        const messages = input.messages as {
            role: string;
            content?: string;
            tool_call_id?: string;
        }[];
        const hasWrite = messages.some(
            (m) => m.role === "tool" && m.tool_call_id === "write-proof",
        );
        const hasRead = messages.some((m) => m.role === "tool" && m.tool_call_id === "read-proof");

        toolReadObserved ||= messages.some(
            (m) =>
                m.role === "tool" &&
                m.tool_call_id === "read-proof" &&
                String(m.content).includes("ROTOM_KERNEL_OK"),
        );
        const tool = !hasWrite
            ? {
                  id: "write-proof",
                  name: "write",
                  arguments: JSON.stringify({ path: "proof.txt", content: "ROTOM_KERNEL_OK\n" }),
              }
            : !hasRead
              ? { id: "read-proof", name: "read", arguments: JSON.stringify({ path: "proof.txt" }) }
              : undefined;

        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const emit = (delta: unknown, finish: string | null = null) =>
            res.write(
                `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
            );

        emit({ role: "assistant" });

        if (tool) {
            emit({
                tool_calls: [
                    {
                        index: 0,
                        id: tool.id,
                        type: "function",
                        function: { name: tool.name, arguments: tool.arguments },
                    },
                ],
            });
            emit({}, "tool_calls");
        } else {
            emit({ content: "KERNEL_FINISHED" });
            emit({}, "stop");
        }

        res.end("data: [DONE]\n\n");
    } catch {
        res.writeHead(400);
        res.end();
    }
});

server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = (server.address() as { port: number }).port;

writeFileSync(
    join(home, ".pi/agent/models.json"),
    JSON.stringify({
        providers: {
            "kernel-fixture": {
                baseUrl: `http://127.0.0.1:${port}/v1`,
                api: "openai-completions",
                apiKey: "fixture-not-secret",
                models: [
                    {
                        id: "kernel-fixture",
                        contextWindow: 32000,
                        maxTokens: 1024,
                        reasoning: false,
                        input: ["text"],
                    },
                ],
            },
        },
    }),
    { mode: 0o600 },
);
writeFileSync(
    join(home, ".pi/agent/settings.json"),
    JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }),
    { mode: 0o600 },
);
const report: Record<string, unknown> = {
    version: verifyRotomKernel().version,
    realProvider: false,
    status: "not-verified",
};
let kernel: Awaited<ReturnType<typeof startRotomKernel>> | undefined;

try {
    kernel = await startRotomKernel({
        home,
        workspace,
        provider: "kernel-fixture",
        model: "kernel-fixture",
    });
    const events: { type: string; toolName?: unknown }[] = [];

    kernel.onEvent((e) =>
        events.push({ type: e.type, ...(e.toolName ? { toolName: e.toolName } : {}) }),
    );
    const commands = (await kernel.request({ type: "get_commands" })) as {
        commands: { name: string }[];
    };

    assert.ok(
        commands.commands.some((c) => c.name === "qoder-credits"),
        "Product extensions must load; raw upstream Pi is not sufficient",
    );
    assert.equal(
        await kernel.prompt(
            "Write ROTOM_KERNEL_OK to proof.txt, read it back, then reply KERNEL_FINISHED.",
        ),
        "settled",
    );
    assert.equal(readFileSync(join(workspace, "proof.txt"), "utf8"), "ROTOM_KERNEL_OK\n");
    assert.equal(toolReadObserved, true);
    assert.equal(requests, 3);
    const entries = (await kernel.request({ type: "get_entries" })) as {
        entries: {
            type: string;
            message?: { role: string; content?: unknown; stopReason?: string };
        }[];
    };
    const saved = entries.entries.filter((e) => e.type === "message");

    assert.ok(saved.some((e) => e.message?.role === "toolResult"));
    assert.ok(
        saved.some(
            (e) =>
                e.message?.role === "assistant" &&
                e.message.stopReason === "stop" &&
                JSON.stringify(e.message.content).includes("KERNEL_FINISHED"),
        ),
    );
    const state = (await kernel.request({ type: "get_state" })) as { sessionFile: string };
    const disk = readFileSync(state.sessionFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

    assert.ok(disk.some((e) => e.type === "message" && e.message?.role === "toolResult"));
    Object.assign(report, {
        status: "passed",
        productExtensionLoaded: true,
        nativeWriteAndRead: true,
        loopbackRequests: requests,
        settledObserved: events.some((e) => e.type === "agent_settled"),
        sessionFileReadback: true,
        events: events.filter(
            (e) => e.type.startsWith("tool_execution") || e.type === "agent_settled",
        ),
        teamBackendMigrated: false,
    });
} finally {
    await kernel?.close();
    server.close();
    writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ ...report, evidence: join(root, "report.json") }));
}
