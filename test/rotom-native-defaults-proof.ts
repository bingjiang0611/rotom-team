/** Actual pinned native recovery with synthetic loopback inference only; no real accounts or desktop actions. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RotomExecutions } from "../src/server/rotom-executions.ts";
import { verifyRotomKernel } from "../src/server/rotom-kernel.ts";
import type { RpcRecord } from "../src/server/rotom-rpc.ts";

process.umask(0o077);
const root = realpathSync(mkdtempSync(join(tmpdir(), "rotom-native-recovery-")));
const home = join(root, "kernel-homes/alice"),
    workspace = join(root, "workspace"),
    shared = join(root, "team-agent");

for (const path of [join(home, ".pi/agent"), workspace, shared]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
}

let phase = "agent-retry";
const requests = new Map<string, number>();
const gates = new Map<string, number>();
const server = createServer(async (request, response) => {
    let body = "";

    for await (const chunk of request) {
        body += chunk;
    }

    const input = JSON.parse(body);
    const count = (requests.get(phase) ?? 0) + 1;

    requests.set(phase, count);
    assert.equal(input.model, "native-fixture");

    if (
        (phase === "agent-retry" && count === 1) ||
        phase === "retry-budget" ||
        (phase === "provider-retry" && count <= 2)
    ) {
        response.writeHead(503, { "Content-Type": "application/json", "retry-after-ms": "1" });
        response.end(
            JSON.stringify({ error: { message: "synthetic server_error", type: "server_error" } }),
        );

        return;
    }

    const isSummary = phase === "compaction" && count > 1;
    const usage =
        phase === "compaction" && count === 1
            ? { prompt_tokens: 7900, completion_tokens: 100, total_tokens: 8000 }
            : { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 };

    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: input.model, choices: [{ index: 0, delta: { role: "assistant", content: isSummary ? "SUMMARY_OK" : "DONE_OK" }, finish_reason: null }] })}\n\n`,
    );
    response.write(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: input.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
});

server.listen(0, "127.0.0.1");
await once(server, "listening");
const model = {
    id: "native-fixture",
    name: "Synthetic native fixture",
    provider: "native-fixture",
    api: "openai-completions",
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    contextWindow: 8192,
    maxTokens: 1024,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const executions = new RotomExecutions(
    root,
    async (binding, operation) => {
        assert.equal(binding.memberId, "alice");
        assert.equal(binding.model, "native-fixture");

        if (operation === "inference") {
            gates.set(phase, (gates.get(phase) ?? 0) + 1);

            return { apiKey: "synthetic-not-secret" };
        }
    },
    () => ({ modelDefinition: model }),
);
const binding = {
    memberId: "alice",
    kernelVersion: verifyRotomKernel().version,
    provider: model.provider,
    model: model.id,
    accountGeneration: "synthetic-only",
    configurationDigest: "native-layers-v1",
    home,
    workspace,
};
const events = new Map<string, RpcRecord[]>();

async function run(name: string, settings: Record<string, unknown> = {}) {
    phase = name;
    writeFileSync(join(shared, "settings.json"), JSON.stringify(settings));
    await executions.journal.bind(name, binding);
    const observed: RpcRecord[] = [];

    events.set(name, observed);
    const result = await executions.run(name, "once", "Explain this synthetic test context.", {
        onEvent: (event) => {
            observed.push(event);
        },
    });

    assert.equal(result.status, "settled", JSON.stringify(result));

    return result;
}

try {
    await run("agent-retry");
    assert.equal(requests.get(phase), 2, "native Agent retries a 503 then succeeds");
    assert.equal(gates.get(phase), 2, "each Agent retry rechecks the fixed payer gate");
    assert.ok(events.get(phase)!.some((event) => event.type === "auto_retry_start"));
    assert.ok(
        events
            .get(phase)!
            .some((event) => event.type === "auto_retry_end" && event.success === true),
    );

    await run("retry-budget");
    assert.equal(
        requests.get(phase),
        4,
        "native default allows initial request plus three retries",
    );
    assert.equal(gates.get(phase), 4);
    assert.equal(
        (await executions.run(phase, "once", "Explain this synthetic test context.")).status,
        "settled",
    );
    assert.equal(
        requests.get(phase),
        4,
        "receipt readback does not restart a known failed request",
    );

    await run("provider-retry", { retry: { enabled: false, provider: { maxRetries: 2 } } });
    assert.equal(requests.get(phase), 3, "native provider retries are no longer forced to zero");
    assert.equal(
        gates.get(phase),
        1,
        "provider retry stays inside the same authorized native stream",
    );
    assert.ok(!events.get(phase)!.some((event) => event.type === "auto_retry_start"));

    // Smaller token settings are fixture-only; production uses the native defaults and model metadata.
    const compact = await run("compaction", {
        compaction: { reserveTokens: 1024, keepRecentTokens: 1 },
    });
    const summaries = (await executions.journal.entries(phase)).filter(
        ({ entry }) => entry.type === "compaction",
    );

    assert.equal(summaries.length, 1, "native threshold actually persisted a compaction");
    assert.equal(
        gates.get(phase),
        requests.get(phase),
        "summary inference uses the same payer gate",
    );
    assert.ok(
        events
            .get(phase)!
            .some((event) => event.type === "compaction_start" && event.reason === "threshold"),
    );
    assert.ok(
        events
            .get(phase)!
            .some((event) => event.type === "compaction_end" && event.aborted === false),
    );
    const usage = await executions.journal.usage(phase);

    assert.ok(usage.every((row) => row.memberId === "alice" && row.attemptId === compact.id));
    assert.equal(usage.length, 2, "assistant and automatic summary both have usage rows");
    assert.deepEqual(usage[1]!.raw, summaries[0]!.entry.usage);
    assert.ok((usage[1]!.raw as { totalTokens: number }).totalTokens > 0);
    console.log(
        JSON.stringify(
            {
                status: "passed",
                version: binding.kernelVersion,
                requests: Object.fromEntries(requests),
                gates: Object.fromEntries(gates),
                automaticCompactionUsage: usage[1]!.raw,
                samePayer: true,
                knownReceiptNoReplay: true,
            },
            null,
            2,
        ),
    );
} finally {
    await executions.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
}
