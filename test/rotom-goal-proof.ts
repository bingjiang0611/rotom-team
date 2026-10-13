/** Opt-in real pinned Goal lifecycle with a loopback scripted model; no real accounts. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RotomExecutions } from "../src/server/rotom-executions.ts";
import { verifyRotomKernel } from "../src/server/rotom-kernel.ts";

process.umask(0o077);
const root = realpathSync(mkdtempSync(join(tmpdir(), "rotom-goal-proof-")));
const requests: { at: number; goalId: string; mode: string }[] = [];
let mode = "timer";
let calls = 0;
let serverError: unknown;
const server = createServer(async (request, response) => {
    try {
        assert.equal(request.url, "/v1/chat/completions");
        let text = "";

        for await (const chunk of request) {
            text += chunk;
        }

        const input = JSON.parse(text) as {
            messages: { role: string; content: unknown }[];
        };

        appendFileSync(join(root, "requests.jsonl"), `${JSON.stringify({ mode, input })}\n`);
        const context = input.messages
            .filter((message) => message.role === "system" || message.role === "user")
            .flatMap((message) =>
                Array.isArray(message.content)
                    ? message.content.map((block: { text?: string }) => block.text ?? "")
                    : [String(message.content)],
            )
            .join("\n");
        const goalId = [...context.matchAll(/<goal_id>\s*([^<]+?)\s*<\/goal_id>/g)]
            .at(-1)?.[1]
            ?.trim();

        assert.ok(goalId, "the current native Goal contract must supply a goal ID");
        requests.push({ at: Date.now(), goalId, mode });
        calls++;

        if (mode === "skill-wake" && calls === 3) {
            assert.ok(
                context.includes("SKILL_WAKE_BODY"),
                "native expands queued skills before waking the workflow",
            );
        }

        const tool =
            calls === 1
                ? {
                      name: "goal_continue",
                      arguments: {
                          goal_id: goalId,
                          next_action: "Wait for the fixture's native safety deadline.",
                      },
                  }
                : calls === 2
                  ? {
                        name: "goal_wait",
                        arguments: {
                            goal_id: goalId,
                            reason: "Await the fixture's native safety deadline.",
                            resume_after_ms: 10_000,
                        },
                    }
                  : undefined;

        response.writeHead(200, { "Content-Type": "text/event-stream" });
        const emit = (delta: unknown, finish: string | null = null) =>
            response.write(
                `data: ${JSON.stringify({ id: `goal-${mode}-${calls}`, object: "chat.completion.chunk", created: 1, model: "goal-fixture", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
            );

        emit({ role: "assistant" });

        if (tool) {
            emit({
                tool_calls: [
                    {
                        index: 0,
                        id: `control-${mode}-${calls}`,
                        type: "function",
                        function: {
                            name: tool.name,
                            arguments: JSON.stringify(tool.arguments),
                        },
                    },
                ],
            });
            emit({}, "tool_calls");
        } else {
            emit({ content: "Fixture reached the native wake. Pause for the next user decision." });
            emit({}, "stop");
        }

        response.end("data: [DONE]\n\n");
    } catch (error) {
        serverError = error;
        response.writeHead(500);
        response.end("Synthetic fixture failed; see requests.jsonl");
    }
});

server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = (server.address() as { port: number }).port;
const report: Record<string, unknown> = { realProvider: false, root };

try {
    for (const scenario of ["timer", "stop", "pause", "wake", "skill-wake"]) {
        mode = scenario;
        calls = 0;
        const data = join(root, scenario);
        const home = join(data, "kernel-homes/alice");
        const workspace = join(data, "workspace");

        mkdirSync(join(home, ".pi/agent"), { recursive: true, mode: 0o700 });
        mkdirSync(join(workspace, ".pi/skills/wake-proof"), { recursive: true, mode: 0o700 });
        writeFileSync(
            join(workspace, ".pi/skills/wake-proof/SKILL.md"),
            "---\nname: wake-proof\ndescription: Native queued skill wake proof\n---\nSKILL_WAKE_BODY: Pause after this authorized input.\n",
        );
        writeFileSync(
            join(home, ".pi/agent/models.json"),
            JSON.stringify({
                providers: {
                    "goal-fixture": {
                        baseUrl: `http://127.0.0.1:${port}/v1`,
                        api: "openai-completions",
                        apiKey: "synthetic-fixture-not-secret",
                        models: [
                            {
                                id: "goal-fixture",
                                contextWindow: 128_000,
                                maxTokens: 1024,
                                reasoning: false,
                                input: ["text"],
                            },
                        ],
                    },
                },
            }),
        );
        writeFileSync(
            join(home, ".pi/agent/settings.json"),
            JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }),
        );
        const authorizations: { member: string; operation: string; session: string }[] = [];
        const executions = new RotomExecutions(data, async (binding, operation, session) => {
            authorizations.push({ member: binding.memberId, operation, session });
        });

        executions.journal.bind("goal-room", {
            memberId: "alice",
            kernelVersion: verifyRotomKernel().version,
            accountGeneration: "synthetic-goal-fixture",
            provider: "goal-fixture",
            model: "goal-fixture",
            configurationDigest: "project",
            home,
            workspace,
        });
        let waitingAt: number | undefined;
        let stop: Promise<unknown> | undefined;
        let timedOut = false;
        const states: unknown[] = [];
        const receipts: string[] = [];
        const deadline = setTimeout(() => {
            timedOut = true;
            stop = executions.abort("goal-room");
        }, 60_000);

        try {
            const result = await executions.run(
                "goal-room",
                `goal-${scenario}`,
                `\n\t /goal\tExercise the synthetic ${scenario} deadline, then pause for a user decision.`,
                {
                    onReserved: (receipt) => {
                        receipts.push(receipt.id);
                    },
                    onEvent: (event) => {
                        appendFileSync(join(data, "events.jsonl"), `${JSON.stringify(event)}\n`);
                    },
                    onNativeGoalState: (state) => {
                        states.push(state);
                        writeFileSync(join(data, "states.json"), JSON.stringify(states, null, 2));
                        const goal = (state as { goal?: { status?: string; waiting?: unknown } })
                            ?.goal;

                        if (goal?.status === "active" && goal.waiting && waitingAt === undefined) {
                            waitingAt = Date.now();

                            if (scenario === "stop") {
                                stop = executions.abort("goal-room");
                            } else if (scenario === "pause") {
                                stop = executions.queue("goal-room", "/goal pause", "steer");
                            } else if (scenario === "skill-wake") {
                                stop = executions.queue(
                                    "goal-room",
                                    "/skill:wake-proof wake now",
                                    "steer",
                                );
                            } else if (scenario === "wake") {
                                stop = executions.wake(
                                    "goal-room",
                                    "Wake now on the same account and pause for my decision.",
                                );
                            }
                        }
                    },
                },
            );

            await stop;
            assert.equal(serverError, undefined);
            assert.equal(timedOut, false, "Goal did not finish before the safety deadline");
            assert.ok(waitingAt !== undefined, "must observe real native waiting before wake/Stop");
            assert.equal(receipts.length, 1);
            assert.ok(
                authorizations.every(
                    (auth) => auth.member === "alice" && auth.session === "goal-room",
                ),
            );

            if (scenario === "timer") {
                assert.equal(result.status, "handled");
                assert.equal(
                    calls,
                    3,
                    "native timer must produce a third inference without injected input",
                );
                const ownRequests = requests.filter((item) => item.mode === scenario);

                const waitingRequest = ownRequests[1];
                const wakeRequest = ownRequests[2];

                assert.ok(waitingRequest && wakeRequest);
                assert.ok(wakeRequest.at - waitingRequest.at >= 10_000);
                assert.equal(new Set(ownRequests.map((item) => item.goalId)).size, 1);

                const beforeModel = calls;
                const model = await executions.run(
                    "goal-room",
                    "unsafe-model",
                    "/model goal-fixture/different-model",
                );

                assert.equal(
                    model.status,
                    "rejected",
                    "low-level execution must never mutate the admitted Team model",
                );
                assert.equal(executions.journal.session("goal-room").binding.model, "goal-fixture");
                assert.equal(calls, beforeModel);
            } else if (["pause", "wake", "skill-wake"].includes(scenario)) {
                assert.equal(result.status, "handled");
                assert.equal(calls, scenario === "pause" ? 2 : 3);
                assert.equal((states.at(-1) as { goal: { status: string } }).goal.status, "paused");
                assert.ok(
                    Date.now() - waitingAt < 10_000,
                    "explicit control must not wait for the timer",
                );
            } else {
                assert.equal(
                    result.status,
                    "unknown",
                    "Stop interrupts accepted work, not a completed handler-only run",
                );
                assert.equal(calls, 2, "Stop must prevent the native deadline inference");
            }

            report[scenario] = { result, calls, waitingAt, authorizations, receipts };
        } finally {
            clearTimeout(deadline);
            await stop;
            executions.close();
        }
    }

    report.status = "passed";
} finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, evidence: join(root, "report.json") }));
}
