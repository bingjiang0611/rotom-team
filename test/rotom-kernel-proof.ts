/** Opt-in: actual pinned rotom product and native tools against a loopback scripted model, no real accounts. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { startRotomKernel, verifyRotomKernel } from "../src/server/rotom-kernel.ts";
import { RotomExecutions } from "../src/server/rotom-executions.ts";

process.umask(0o077);
const root = realpathSync(mkdtempSync(join(tmpdir(), "rotom-kernel-proof-"))),
    home = join(root, "home"),
    workspace = join(root, "workspace");

mkdirSync(home, { mode: 0o700 });
mkdirSync(workspace, { mode: 0o700 });
mkdirSync(join(home, ".pi/agent"), { recursive: true, mode: 0o700 });
let requests = 0,
    toolReadObserved = false,
    rejectStatus = 0;
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

        if (rejectStatus) {
            res.writeHead(rejectStatus, { "Content-Type": "application/json" });
            res.end(
                JSON.stringify({ error: { message: "scripted rejection", type: "server_error" } }),
            );

            return;
        }

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
    await kernel.close();
    kernel = undefined;

    const data = join(root, "team-data"),
        memberHome = join(data, "kernel-homes", "alice");

    mkdirSync(data, { mode: 0o700 });
    mkdirSync(join(memberHome, ".pi/agent"), { recursive: true, mode: 0o700 });

    for (const name of ["models.json", "settings.json"]) {
        writeFileSync(
            join(memberHome, ".pi/agent", name),
            readFileSync(join(home, ".pi/agent", name)),
            { mode: 0o600 },
        );
    }

    let allowed = true,
        inferenceChecks = 0;

    let admissionBarrier: { sessionId: string; wait: Promise<void> } | undefined;

    const authorize = async (_binding: unknown, operation: string, scope: string) => {
        if (operation === "admission" && admissionBarrier?.sessionId === scope) {
            const barrier = admissionBarrier;

            admissionBarrier = undefined;
            await barrier.wait;
        }

        if (operation === "inference") {
            inferenceChecks++;
        }

        if (!allowed) {
            throw new Error("membership revoked");
        }
    };

    let executions = new RotomExecutions(data, authorize);
    const binding = {
        memberId: "alice",
        kernelVersion: "0.1.14",
        accountGeneration: "isolated-fixture-1",
        provider: "kernel-fixture",
        model: "kernel-fixture",
        configurationDigest: "fixture-snapshot",
        home: memberHome,
        workspace,
    };

    try {
        executions.journal.bind("team-conversation", binding);
        const before = requests;
        const first = await executions.run(
            "team-conversation",
            "request-once",
            "Write and read proof.txt, then finish.",
        );

        assert.equal(first.status, "settled");
        assert.equal(requests, before + 3);
        assert.equal(inferenceChecks, 3);
        assert.equal(executions.journal.usage("team-conversation").length, 3);
        assert.ok(
            executions.journal
                .usage("team-conversation")
                .every((row) => row.memberId === "alice" && row.costStatus === "unknown"),
        );
        executions.close();
        executions = new RotomExecutions(data, authorize);
        const duplicate = await executions.run(
            "team-conversation",
            "request-once",
            "Write and read proof.txt, then finish.",
        );

        assert.equal(duplicate.id, first.id);
        assert.equal(requests, before + 3);
        const resumed = await executions.run(
            "team-conversation",
            "next-request",
            "Continue from the existing public test history, do not rewrite the file.",
        );

        assert.equal(resumed.status, "settled");
        assert.equal(requests, before + 4, "resumed context already contains both tool results");
        assert.equal(
            executions.journal.usage("team-conversation").length,
            4,
            "old usage is not attributed to the latest attempt again",
        );
        executions.journal.bind("revocation-conversation", binding);
        const beforeRevocation = requests;
        const revoked = await executions.run(
            "revocation-conversation",
            "revoke-after-tool",
            "Write and read proof.txt.",
            (event) => {
                if (event.type === "tool_execution_end" && event.toolName === "write") {
                    allowed = false;
                }
            },
        );

        assert.equal(
            revoked.status,
            "settled",
            "transport settlement is not a successful business outcome",
        );
        assert.equal(
            requests,
            beforeRevocation + 1,
            "second inference must be denied at native dispatch after permission revocation",
        );
        assert.ok(
            executions.journal
                .entries("revocation-conversation")
                .some(
                    (row) =>
                        (row.entry.message as { stopReason?: string } | undefined)?.stopReason ===
                        "error",
                ),
        );
        allowed = true;
        assert.equal(
            (
                await executions.run(
                    "revocation-conversation",
                    "revoke-after-tool",
                    "Write and read proof.txt.",
                )
            ).id,
            revoked.id,
        );
        assert.equal(
            requests,
            beforeRevocation + 1,
            "known failed model response is not automatically retried as a new submission",
        );

        for (const status of [429, 503]) {
            rejectStatus = status;
            const id = `http-${status}`;
            const beforeRejected: number = requests;

            executions.journal.bind(id, binding);
            assert.equal(
                (await executions.run(id, `request-${status}`, "One dispatch only.")).status,
                "settled",
            );
            assert.equal(
                requests,
                beforeRejected + 1,
                "native SDK must not redispatch HTTP failures",
            );
            assert.ok(
                executions.journal
                    .entries(id)
                    .some(
                        (row) =>
                            (row.entry.message as { stopReason?: string } | undefined)
                                ?.stopReason === "error",
                    ),
            );
        }

        rejectStatus = 0;
        executions.journal.bind("oversized-first", binding);
        const beforeOversized: number = requests;
        const oversized = await executions.run(
            "oversized-first",
            "oversized",
            "x".repeat(1024 * 1024),
        );

        assert.equal(oversized.status, "rejected");
        assert.equal(requests, beforeOversized);
        const validAfterRejection = await executions.run(
            "oversized-first",
            "valid",
            "Write and read proof.txt.",
        );

        assert.equal(validAfterRejection.status, "settled");
        assert.equal(requests, beforeOversized + 3);

        executions.journal.bind("delayed-admission", binding);
        let release!: () => void;

        admissionBarrier = {
            sessionId: "delayed-admission",
            wait: new Promise<void>((resolve) => {
                release = resolve;
            }),
        };
        const beforeConcurrent: number = requests;
        const delayed = executions.run(
            "delayed-admission",
            "later",
            "Continue existing history without redoing tools.",
        );
        const earlier = executions
            .run("delayed-admission", "earlier", "Write and read proof.txt.")
            .finally(() => release());
        const both = await Promise.allSettled([earlier, delayed]);

        for (const result of both) {
            assert.equal(result.status, "fulfilled");
            assert.equal(
                (result as PromiseFulfilledResult<{ status: string }>).value.status,
                "settled",
            );
        }

        assert.equal(
            requests,
            beforeConcurrent + 4,
            "late admission must resume the newly materialized session, not start a fresh one",
        );
        assert.equal(executions.journal.usage("delayed-admission").length, 4);
        report.guardedExecution = {
            immutablePayer: true,
            atomicEntryUsageImport: true,
            restartDuplicateNoDispatch: true,
            nativeSessionResume: true,
            revokedBeforeSecondInference: true,
            nativeHttp429And503NoRetry: true,
            rejectedUnmaterializedThenValid: true,
            delayedAdmissionResumesLatestSession: true,
            inferenceChecks,
        };
    } finally {
        executions.close();
    }

    report.status = "passed";
} finally {
    await kernel?.close();
    server.close();
    writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ ...report, evidence: join(root, "report.json") }));
}
