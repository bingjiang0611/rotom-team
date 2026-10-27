/** Real native hot-switch, rotated gate, next-operation reload and unknown-outcome proof; loopback only. */
import { root, work, owner, until, cleanUp } from "./helpers.ts";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PocketApp } from "../src/server/app.ts";
import { createHandler } from "../src/server/http.ts";

process.umask(0o077);
const data = join(realpathSync(root), "switch-proof");
const starts = join(data, "starts.jsonl");
const fail = join(data, "fail-switch");

mkdirSync(join(data, "team-agent/extensions"), { recursive: true });
writeFileSync(
    join(data, "team-agent/extensions/switch-proof.ts"),
    `import {appendFileSync, readFileSync, existsSync} from "node:fs";
export default function(pi) {
    pi.on("session_start", (_event, ctx) => appendFileSync(${JSON.stringify(starts)}, JSON.stringify({pid:process.pid, model:ctx.model?.id, reducer:JSON.parse(readFileSync(process.env.HOME + "/.pi/agent/sol-pi.json", "utf8")).evidencePreservingReducerModel}) + "\\n"));
    pi.on("model_select", () => {if(existsSync(${JSON.stringify(fail)})) throw new Error("injected-model-select-error");});
}`,
);
const calls: string[] = [];
let hold = false;
let release: (() => void) | undefined;
const provider = createServer(async (request, response) => {
    let body = "";

    for await (const chunk of request) {
        body += chunk;
    }

    const input = JSON.parse(body);

    assert.equal(request.headers.authorization, "Bearer synthetic-switch-key");
    calls.push(input.model);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (delta: object, finish: string | null = null) =>
        response.write(
            `data: ${JSON.stringify({ id: "switch", object: "chat.completion.chunk", created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );

    emit({ role: "assistant" });
    emit({ content: `Actual model: ${input.model}` });

    const finish = () => {
        emit({}, "stop");
        response.end("data: [DONE]\n\n");
    };

    if (hold) {
        release = finish;
    } else {
        finish();
    }
});

provider.listen(0, "127.0.0.1");
await once(provider, "listening");
const baseUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;
const app = await PocketApp.open({
    dataDir: data,
    defaultCwd: realpathSync(work),
    supervised: false,
    kernel: true,
    browser: null,
    log: () => {},
    configureUserModels: (models) =>
        models.registerNativeProvider({
            id: "openai",
            name: "Synthetic model switch",
            auth: {
                apiKey: {
                    name: "Synthetic key",
                    resolve: async () => ({
                        auth: { apiKey: "synthetic-switch-key" },
                        source: "fixture",
                    }),
                },
            },
            getModels: () =>
                ["model-a", "model-b"].map((id) => ({
                    id,
                    name: id,
                    provider: "openai",
                    api: "openai-completions",
                    baseUrl,
                    reasoning: false,
                    input: ["text"],
                    contextWindow: 200_000,
                    maxTokens: 4096,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                })),
            stream: () => {
                throw new Error("must use native");
            },
            streamSimple: () => {
                throw new Error("must use native");
            },
        }),
});
const alice = owner(app);
const bob = app.config.addUser("Bob", "guest").user;
const token = app.config.addDevice(alice.id).token;
const bobToken = app.config.addDevice(bob.id).token;

await app.hello(alice);
const server = createServer(
    createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
);

server.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/`;

const call = async (path: string, body: object, status = 200, auth = token) => {
    const response = await fetch(base + path, {
        method: "POST",
        headers: {
            authorization: `Bearer ${auth}`,
            "x-pocket": "1",
            "content-type": "application/json",
        },
        body: JSON.stringify(body),
    });
    const text = await response.text();

    assert.equal(response.status, status, text);

    return JSON.parse(text);
};

const observations = () =>
    readFileSync(starts, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

try {
    const { id } = await call("sessions", { title: "Model switch proof", backend: "rotom" });
    const seed = await call(`c/${id}/submit`, { text: "Seed native history", requestId: "seed" });

    assert.equal(seed.status, "settled");
    const before = await app.kernel!.executions.journal.session(String(id));
    const initialStarts = observations();
    const files = readdirSync(join(data, "kernel-gates")).filter((file) => file.endsWith(".json"));

    assert.equal(files.length, 1);
    const gateFile = join(data, "kernel-gates", files[0]!);
    const oldGate = JSON.parse(readFileSync(gateFile, "utf8"));
    const choose = (modelId: string, requestId: string, status = 200, auth = token) =>
        call(`c/${id}/submit`, { text: `/model openai/${modelId}`, requestId }, status, auth);
    const switched = await choose("model-b", "switch-b");

    assert.equal(switched.status, "handled");
    assert.deepEqual(
        observations(),
        initialStarts,
        "no process startup or resource reload during switch",
    );
    assert.deepEqual(calls, ["model-a"], "selection does not infer");
    const after = await app.kernel!.executions.journal.session(String(id));

    assert.equal(after.kernelSessionId, before.kernelSessionId);
    assert.equal(after.sessionFile, before.sessionFile);
    assert.equal(after.binding.model, "model-b");
    assert.ok(
        (await app.kernel!.executions.journal.segmentEntries(after.segmentId)).some(
            (entry) => entry.type === "model_change" && entry.modelId === "model-b",
        ),
    );
    const newGate = JSON.parse(readFileSync(gateFile, "utf8"));

    assert.notEqual(newGate.token, oldGate.token);
    assert.equal(newGate.url, oldGate.url);
    assert.deepEqual(
        await choose("model-b", "switch-b"),
        switched,
        "exact replay is readback only",
    );
    await choose("model-a", "switch-b", 409);
    await choose("missing", "bad-model", 400);
    assert.equal(JSON.parse(readFileSync(gateFile, "utf8")).token, newGate.token);

    hold = true;
    const pending = call(`c/${id}/submit`, {
        text: "Hold actual new model inference",
        requestId: "held",
    });

    let earlyResult: unknown;

    void pending.then((result) => {
        earlyResult = result;
    });
    await until(
        () => release !== undefined || earlyResult !== undefined,
        "new-model inference",
        20_000,
    );
    assert.equal(
        earlyResult,
        undefined,
        JSON.stringify({
            earlyResult,
            starts: observations(),
            info: await app.kernel!.roomInfo(id),
        }),
    );
    assert.deepEqual(calls, ["model-a", "model-b"]);
    const reloaded = observations().at(-1)!;

    assert.equal(reloaded.pid, initialStarts[0].pid, "the next operation also keeps the process");
    assert.equal(
        reloaded.reducer,
        "model-b",
        "auxiliary model config is reloaded before inference",
    );

    for (const [key, model, expected] of [
        [oldGate.token, "model-a", 403],
        [oldGate.token, "model-b", 403],
        [newGate.token, "model-a", 403],
        [newGate.token, "model-b", 200],
    ] as const) {
        const response = await fetch(newGate.url, {
            method: "POST",
            headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
            body: JSON.stringify({ operation: "inference", provider: "openai", model }),
        });

        assert.equal(response.status, expected, "gate identity must match the active model epoch");
        await response.body?.cancel();
    }

    await choose("model-a", "busy", 409);
    await choose("model-a", "foreign", 409, bobToken);
    assert.equal(JSON.parse(readFileSync(gateFile, "utf8")).token, newGate.token);
    release!();
    assert.equal((await pending).status, "settled");
    hold = false;

    for (const model of ["model-a", "model-b"]) {
        assert.equal((await choose(model, `cycle-${model}`)).status, "handled");
    }

    const beforeExplicitReload = observations().length;
    const explicitReload = await call(`c/${id}/submit`, {
        text: "/reload",
        requestId: "explicit-reload-after-switch",
    });

    assert.equal(explicitReload.status, "handled");
    assert.equal(observations().length, beforeExplicitReload + 1, "explicit reload runs once");
    const discovered = await call(`c/${id}/prompts`, { requestId: "after-explicit-reload" });

    assert.equal(discovered.receipt.status, "handled");
    assert.equal(observations().length, beforeExplicitReload + 1, "pending reload was cleared");
    writeFileSync(fail, "inject native failure");
    const unknown = await choose("model-a", "unknown-switch");

    assert.equal(unknown.status, "unknown");
    assert.deepEqual(await choose("model-a", "unknown-switch"), unknown);
    await choose("model-b", "after-unknown", 409);
    assert.deepEqual(calls, ["model-a", "model-b"], "failure/replay never invokes a model");
    console.log(
        "PASS: native model/history, same PID, rotated token, active gate denial, deferred auxiliary reload, one explicit reload, busy/foreign refusal, duplicate/conflict and unknown fences",
    );
} finally {
    release?.();
    await app.close();
    server.closeAllConnections();
    provider.closeAllConnections();
    await Promise.all([
        new Promise<void>((resolve) => server.close(() => resolve())),
        new Promise<void>((resolve) => provider.close(() => resolve())),
    ]);
    cleanUp();
}
