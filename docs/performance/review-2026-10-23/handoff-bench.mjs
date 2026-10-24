// D7: 1/10/100 MiB, three real handoffs per case. Fresh child per size; local synthetic model only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, realpathSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as turn, setTimeout as delay } from "node:timers/promises";

const option = process.argv.indexOf("--mib");

if (option < 0) {
    const cases = [1, 10, 100].map((mib) =>
        JSON.parse(
            execFileSync(
                process.execPath,
                [
                    "--expose-gc",
                    "--import",
                    fileURLToPath(new URL("./handoff-worker-probe.mjs", import.meta.url)),
                    fileURLToPath(import.meta.url),
                    "--mib",
                    String(mib),
                ],
                { encoding: "utf8", maxBuffer: 1024 * 1024 * 4 },
            ),
        ),
    );

    console.log(
        JSON.stringify(
            {
                source: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
                cases,
            },
            null,
            2,
        ),
    );
} else {
    const mib = Number(process.argv[option + 1]);

    assert.ok([1, 10, 100].includes(mib));
    const { cleanUp, owner, root, work } = await import("../../../test/helpers.ts");
    const { PocketApp } = await import("../../../src/server/app.ts");
    const { nativeSessionManager } = await import("../../../src/server/rotom-kernel.ts");
    const { seedPhaseChannel } = await import("../../../src/server/perf-channels.ts");
    const native = await nativeSessionManager();
    let inferenceRequests = 0;
    const model = createServer(async (request, response) => {
        assert.ok(request.url.endsWith("/chat/completions"));

        for await (const chunk of request) {
            void chunk;
        }

        inferenceRequests++;
        response.writeHead(200, { "content-type": "text/event-stream" });
        const emit = (delta, finish_reason = null) =>
            response.write(
                `data: ${JSON.stringify({ id: "d7", object: "chat.completion.chunk", created: 1, model: "handoff-fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
            );

        emit({ role: "assistant", content: "D7 synthetic first reply" });
        emit({}, "stop");
        response.end("data: [DONE]\n\n");
    });

    model.listen(0, "127.0.0.1");
    await once(model, "listening");
    const baseUrl = `http://127.0.0.1:${model.address().port}/v1`;
    const app = await PocketApp.open({
        dataDir: join(realpathSync(root), "handoff"),
        defaultCwd: realpathSync(work),
        kernel: true,
        supervised: false,
        browser: null,
        log: () => {},
        configureUserModels: (models) =>
            models.registerNativeProvider({
                id: "openai",
                name: "D7 local synthetic model",
                auth: {
                    apiKey: {
                        name: "Synthetic",
                        resolve: async () => ({ auth: { apiKey: "fixture" }, source: "test" }),
                    },
                },
                getModels: () => [
                    {
                        id: "handoff-fixture",
                        name: "handoff-fixture",
                        provider: "openai",
                        api: "openai-completions",
                        baseUrl,
                        reasoning: false,
                        input: ["text"],
                        contextWindow: 1_000_000_000,
                        maxTokens: 32,
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    },
                ],
                stream: () => {
                    throw new Error("No Durable inference");
                },
                streamSimple: () => {
                    throw new Error("No Durable inference");
                },
            }),
    });
    let db;

    try {
        const user = owner(app);
        const session = await app.commands.createSession(user, { backend: "rotom" });
        const journal = app.kernel.executions.journal;
        const id = String(session.id);
        const binding = journal.session(id).binding;

        assert.equal(binding.model, "handoff-fixture");

        (() => {
            const text = "x".repeat((mib * 1024 * 1024) / 64);
            const entries = Array.from({ length: 64 }, (_, i) => ({
                id: `entry-${i}`,
                parentId: i ? `entry-${i - 1}` : null,
                type: "message",
                timestamp: new Date(i).toISOString(),
                message: {
                    role: i % 2 ? "assistant" : "user",
                    content: [{ type: "text", text }],
                    timestamp: i,
                    ...(i % 2
                        ? {
                              provider: binding.provider,
                              model: binding.model,
                              api: "openai-completions",
                              stopReason: "stop",
                              usage: {
                                  input: 0,
                                  output: 0,
                                  cacheRead: 0,
                                  cacheWrite: 0,
                                  totalTokens: 0,
                                  cost: {
                                      input: 0,
                                      output: 0,
                                      cacheRead: 0,
                                      cacheWrite: 0,
                                      total: 0,
                                  },
                              },
                          }
                        : {}),
                },
            }));
            const receipt = journal.reserve(id, "source", "source", "command");

            journal.attach(receipt.id, join(app.dataDir, "source.jsonl"), "source-id");
            journal.finish(receipt.id, "handled", entries);
        })();

        const database = join(app.dataDir, "kernel.sqlite");

        db = new DatabaseSync(database, { readOnly: true });
        const storage = () => ({
            db: statSync(database).size,
            wal: existsSync(database + "-wal") ? statSync(database + "-wal").size : 0,
            body: Number(
                db
                    .prepare(
                        "SELECT COALESCE(SUM(length(CAST(body AS BLOB))),0) AS bytes FROM kernel_entries",
                    )
                    .get().bytes,
            ),
        });
        const samples = [];

        for (let iteration = 1; iteration <= 3; iteration++) {
            await turn();
            global.gc();
            const before = storage();
            const rssBefore = process.memoryUsage.rss();
            const peakBefore = process.resourceUsage().maxRSS * 1024;
            let rssPeak = rssBefore,
                lag = 0,
                ticks = 0,
                last = performance.now();
            const timer = setInterval(() => {
                const now = performance.now();

                lag = Math.max(lag, now - last - 1);
                last = now;
                ticks++;
                rssPeak = Math.max(rssPeak, process.memoryUsage.rss());
            }, 1);

            await delay(2);
            lag = 0;
            ticks = 0;
            last = performance.now();
            const phases = [];
            const observe = (value) => phases.push(value);

            seedPhaseChannel.subscribe(observe);
            const start = performance.now();
            let receipt;

            try {
                receipt = await app.kernel.executions.handoff(
                    id,
                    `handoff-${iteration}`,
                    journal.session(id).segmentId,
                    binding,
                );
            } finally {
                seedPhaseChannel.unsubscribe(observe);
            }

            const ms = performance.now() - start;
            const rssAfter = process.memoryUsage.rss();
            const peakAfter = process.resourceUsage().maxRSS * 1024;

            await delay(0);
            clearInterval(timer);
            assert.equal(receipt.status, "settled");
            const after = storage();
            const target = journal.session(id);

            assert.equal(journal.segmentEntries(target.segmentId).length, 64);
            assert.equal(journal.entries(id).length, 64, "handoff is not mirrored/billed again");
            const openStart = performance.now();

            assert.equal(native.SessionManager.open(target.sessionFile).getEntries().length, 64);
            const nativeOpenMs = performance.now() - openStart;
            const warmStart = performance.now();

            assert.equal((await app.kernel.warm(session.id, user)).warmed, true);
            const warmMs = performance.now() - warmStart;

            samples.push({
                iteration,
                ms,
                phases,
                eventLoop: { maxLagMs: lag, ticks },
                rss: {
                    before: rssBefore,
                    sampledPeak: rssPeak,
                    after: rssAfter,
                    processPeakBefore: peakBefore,
                    processPeakAfter: peakAfter,
                },
                storage: {
                    before,
                    after,
                    delta: Object.fromEntries(
                        Object.keys(before).map((key) => [key, after[key] - before[key]]),
                    ),
                },
                seedBytes: statSync(target.sessionFile).size,
                nativeOpenMs,
                warmMs,
            });
        }

        const firstStart = performance.now();
        const first = await app.kernel.executions.run(id, "synthetic-first", "D7 first turn");
        const firstTurnMs = performance.now() - firstStart;

        assert.equal(first.status, "settled");
        assert.equal(inferenceRequests, 1);
        console.log(
            JSON.stringify({
                mib,
                samples,
                firstTurnMs,
                inferenceRequests,
                model: "loopback synthetic; not real inference latency",
            }),
        );
    } finally {
        db?.close();
        await app.close();
        model.closeAllConnections();
        await new Promise((resolve) => model.close(resolve));
        cleanUp();
    }
}
