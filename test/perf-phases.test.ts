// A native prompt run's phases, as the daily performance journal gets them: the real rotom kernel and its tools, with a
// loopback model that waits before it answers and asks for one slow tool. No real account is used.
import assert from "node:assert/strict";
import { once } from "node:events";
import { realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { PocketApp } from "../src/server/app.ts";
import { createHandler } from "../src/server/http.ts";
import { kernelRunChannel, type KernelRunSignal } from "../src/server/perf-channels.ts";
import { cleanUp, owner, root, work as workspace } from "./helpers.ts";

const FIRST_OUTPUT_DELAY_MS = 250;
const TOOL_SECONDS = 0.4;

const work = realpathSync(workspace);
const runs: KernelRunSignal[] = [];
const listen = (message: unknown) => runs.push(message as KernelRunSignal);
let app: Awaited<ReturnType<typeof PocketApp.open>>;
let server: Server;
let model: Server;
let base: string;
let token: string;

before(async () => {
    // Each request waits before its first chunk. A request after a tool result answers in text; any other asks for
    // one tool run that takes TOOL_SECONDS.
    model = createServer(async (request, response) => {
        let body = "";

        for await (const chunk of request) {
            body += chunk;
        }

        const messages = (JSON.parse(body) as { messages: { role: string }[] }).messages;
        const emit = (delta: object, finish: string | null = null) =>
            response.write(
                `data: ${JSON.stringify({ id: "phases", object: "chat.completion.chunk", created: 1, model: "phases", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
            );

        response.writeHead(200, { "Content-Type": "text/event-stream" });
        await new Promise((resolve) => setTimeout(resolve, FIRST_OUTPUT_DELAY_MS));
        emit({ role: "assistant" });

        if (messages.at(-1)?.role === "tool") {
            emit({ content: "Done." });
            emit({}, "stop");
        } else {
            emit({
                tool_calls: [
                    {
                        index: 0,
                        id: `call-${messages.length}`,
                        type: "function",
                        function: {
                            name: "bash",
                            arguments: JSON.stringify({ command: `sleep ${TOOL_SECONDS}` }),
                        },
                    },
                ],
            });
            emit({}, "tool_calls");
        }

        response.end("data: [DONE]\n\n");
    });
    model.listen(0, "127.0.0.1");
    await once(model, "listening");
    const baseUrl = `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`;

    writeFileSync(join(work, "AGENTS.md"), "Phase test project.\n");
    app = await PocketApp.open({
        dataDir: join(realpathSync(root), "perf-phases-data"),
        defaultCwd: work,
        kernel: true,
        supervised: false,
        browser: null,
        log: () => {},
        configureUserModels: (models, user) =>
            models.registerNativeProvider({
                id: "openai",
                name: "Loopback phase model",
                auth: {
                    apiKey: {
                        name: "Synthetic",
                        resolve: async () => ({
                            auth: { apiKey: `phases:${user.id}` },
                            source: "test",
                        }),
                    },
                },
                getModels: () => [
                    {
                        id: "phases",
                        name: "phases",
                        api: "openai-completions",
                        provider: "openai",
                        baseUrl,
                        reasoning: false,
                        input: ["text"],
                        contextWindow: 200_000,
                        maxTokens: 4096,
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    },
                ],
                stream: () => {
                    throw new Error("rotom sessions never run on the Durable path");
                },
                streamSimple: () => {
                    throw new Error("rotom sessions never run on the Durable path");
                },
            }),
    });
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    token = app.config.addDevice(owner(app).id).token;
    await app.hello(owner(app));
    kernelRunChannel.subscribe(listen);
});

after(async () => {
    kernelRunChannel.unsubscribe(listen);
    server?.closeAllConnections();
    server?.close();
    model?.close();
    await app?.close();
    cleanUp();
});

const call = async (path: string, body: object) => {
    const response = await fetch(`${base}/api/${path}`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${token}`,
            "x-pocket": "1",
            "content-type": "application/json",
        },
        body: JSON.stringify(body),
    });
    const text = await response.text();

    assert.equal(response.status, 200, `${path}: ${text}`);

    return JSON.parse(text) as Record<string, unknown>;
};

test("a prompt run reports its dispatch, the model's first output, and its tool time, and whether its process was new", async () => {
    const id = (await call("sessions", { title: "Phases", backend: "rotom" })).id as number;

    for (const turn of [1, 2]) {
        runs.length = 0;
        assert.equal(
            (await call(`c/${id}/submit`, { text: `Turn ${turn}.`, requestId: `phases-${turn}` }))
                .status,
            "settled",
        );

        const run = runs.find((each) => each.outcome === "prompt:settled");

        assert.ok(run?.prompt, `turn ${turn}: ${JSON.stringify(runs)}`);
        const { process, dispatchMs, firstOutputMs, toolMs, tools } = run.prompt;

        assert.equal(process, turn === 1 ? "started" : "reused");
        assert.equal(tools, 1);
        // The model waits before each answer; the tool sleeps. Each phase is at least that, and within the run.
        assert.ok(
            firstOutputMs !== null && firstOutputMs >= FIRST_OUTPUT_DELAY_MS - 10,
            `first output ${firstOutputMs}`,
        );
        assert.ok(toolMs >= TOOL_SECONDS * 1000 - 10, `tool ${toolMs}`);
        assert.ok(
            dispatchMs + firstOutputMs! + toolMs + FIRST_OUTPUT_DELAY_MS <= run.ms,
            `phases within the run: ${JSON.stringify(run)}`,
        );
    }
});
