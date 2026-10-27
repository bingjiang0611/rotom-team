/**
 * One run of the controlled benchmarks: a real server in team kernel mode, real rotom child processes, a real
 * event-stream tab, and a loopback OpenAI-compatible model that streams a fixed answer. No real account is used.
 * Each scenario records how long it took and the work counters (`counters.ts`) for exactly its window.
 *
 *   node test/perf/scenarios.ts <out.json>
 *
 * `measure.ts` runs this several times, each in a fresh process, and turns the runs into a report.
 */
import { nativeTimingSince, nativeTimingSnapshot, raw, since, snapshot } from "./counters.ts";
import { cleanUp, owner, root, work } from "../helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { PocketApp } from "../../src/server/app.ts";
import { createHandler } from "../../src/server/http.ts";
import type { Runtime } from "../../src/server/team-accounts.ts";
import type { User } from "../../src/server/config.ts";
import { measureWebOpen } from "./browser.ts";
import { SPLIT_FIRST_OUTPUT_MS, WORKLOAD } from "./workload.ts";
import type { ScenarioContext, ScenarioResult as BenchmarkResult } from "./scenario-context.ts";
import { runHistoryScenarios } from "./scenario-history.ts";
import { runImageScenarios } from "./scenario-images.ts";
import { runAssetScenarios, runJournalScenario } from "./scenario-journal-assets.ts";
import { runNativeLongScenario, runNativeWarmScenarios } from "./scenario-native.ts";
import { runEstablishedSends, runNetworkSends } from "./scenario-sends.ts";
export type { ScenarioResult } from "./scenario-context.ts";
const out = process.argv[2];

if (out === undefined) {
    throw new Error("Usage: node test/perf/scenarios.ts <out.json>");
}

const results: BenchmarkResult[] = [];

// ─── The loopback model: the same answer for the same turn, in a fixed number of chunks, as fast as it can.

/** The text answering the `turn`th user message; it ends with a marker the browser scenario waits for. */
const answer = (turn: number) => {
    const marker = `END-OF-ANSWER-${turn}`;
    const body = `Answer ${turn}. `.padEnd(
        WORKLOAD.answerChars - marker.length - 1,
        "lorem ipsum ",
    );

    return `${body} ${marker}`;
};

let inferenceRequests = 0;

const model = createServer(async (req, res) => {
    let body = "";

    for await (const chunk of req) {
        body += chunk;
    }

    const input = raw.parse(body) as { messages: { role: string; content: unknown }[] };

    inferenceRequests++;
    const users = input.messages.filter((m) => m.role === "user");
    const request = raw.stringify(users.at(-1)?.content ?? "");
    const fullAnswer = answer(users.length);
    // A send timed in phases (`send-phases.ts`) names itself; the answer's first chunk names it back.
    const split = /SPLIT-USER-([a-z]+)/.exec(request)?.[1];
    const text =
        split !== undefined
            ? `SPLIT-REPLY-${split} ${fullAnswer}`
            : request.includes("PROJECTION-SEED")
              ? fullAnswer.slice(0, WORKLOAD.projectionAnswerChars)
              : fullAnswer;
    // A paced answer streams like a real model, so the server's 90 ms push coalescing has something to coalesce.
    const paced = request.includes("PACED");
    const size = Math.ceil(text.length / WORKLOAD.streamChunks);
    const emit = (delta: object, finish: string | null = null) =>
        res.write(
            `data: ${raw.stringify({ id: "perf", object: "chat.completion.chunk", created: 1, model: "perf", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );

    res.writeHead(200, { "Content-Type": "text/event-stream" });
    emit({ role: "assistant" });

    // A real model thinks before it answers: long enough that the sender's own message is pushed before the reply.
    if (split !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, SPLIT_FIRST_OUTPUT_MS));
    }

    for (let at = 0; at < text.length; at += size) {
        emit({ content: text.slice(at, at + size) });

        if (paced) {
            await new Promise((resolve) => setTimeout(resolve, WORKLOAD.pacedChunkMs));
        }
    }

    emit({}, "stop");
    res.end("data: [DONE]\n\n");
});

model.listen(0, "127.0.0.1");
await once(model, "listening");
const baseUrl = `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`;
const configureUserModels = (models: Runtime, user: User) =>
    models.registerNativeProvider({
        id: "openai",
        name: "Loopback benchmark model",
        auth: {
            apiKey: {
                name: "Synthetic benchmark key",
                resolve: async () => ({ auth: { apiKey: `perf:${user.id}` }, source: "perf" }),
            },
        },
        getModels: () => [
            {
                id: "perf",
                name: "perf",
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
    });

// ─── The workspace: a Git repository with changed files, so the changes and branches routes have work to do.

const data = join(realpathSync(root), "perf-data");
const workspace = join(realpathSync(work), "perf-project");
const git = (...args: string[]) =>
    execFileSync("git", ["-C", workspace, ...args], { stdio: "ignore" });

mkdirSync(join(workspace, "src"), { recursive: true });
writeFileSync(join(workspace, "AGENTS.md"), "Benchmark project.\n");

for (let index = 0; index < WORKLOAD.changedFiles; index++) {
    writeFileSync(join(workspace, "src", `file-${index}.txt`), `line ${index}\n`.repeat(50));
}

git("init", "-q", "-b", "main");
git("-c", "user.name=perf", "-c", "user.email=perf@example.invalid", "add", "-A");
git("-c", "user.name=perf", "-c", "user.email=perf@example.invalid", "commit", "-q", "-m", "seed");
git("branch", "feature");

for (let index = 0; index < WORKLOAD.changedFiles; index++) {
    writeFileSync(join(workspace, "src", `file-${index}.txt`), `changed ${index}\n`.repeat(60));
}

// ─── The server, as the service runs it: kernel mode, behind the real HTTP handler.

const open = () =>
    PocketApp.open({
        dataDir: data,
        defaultCwd: workspace,
        supervised: false,
        kernel: true,
        ...(process.env.ROTOM_PERF_STORAGE_WORKER === "1" ? { storageWorker: true } : {}),
        browser: null,
        log: () => {},
        configureUserModels,
    });
let app = await open();
let handler = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} });
const server: Server = createServer((req, res) => handler(req, res));

server.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const alice = owner(app);
const token = app.config.addDevice(alice.id).token;

await app.hello(alice);

const call = async (path: string, method = "GET", body?: object) => {
    const response = await fetch(`${base}/api/${path}`, {
        method,
        headers: {
            authorization: `Bearer ${token}`,
            "x-pocket": "1",
            "content-type": "application/json",
        },
        ...(body ? { body: raw.stringify(body) } : {}),
    });
    const text = await response.text();

    assert.equal(response.status, 200, `${method} ${path}: ${text}`);

    return { value: raw.parse(text) as Record<string, unknown>, bytes: Buffer.byteLength(text) };
};

/** A browser tab on the event stream of session `id`; `fullView` settles once its first full view has arrived. */
function tab(id: number) {
    const controller = new AbortController();
    let resolveFull: () => void;
    const fullView = new Promise<void>((resolve) => (resolveFull = resolve));
    const reading = (async () => {
        const response = await fetch(`${base}/api/events?c=${id}&tab=perf-${id}-${Date.now()}`, {
            headers: { authorization: `Bearer ${token}` },
            signal: controller.signal,
        });
        const decoder = new TextDecoder();
        let buffer = "";

        for await (const chunk of response.body!) {
            buffer += decoder.decode(chunk as Uint8Array, { stream: true });
            let end: number;

            while ((end = buffer.indexOf("\n\n")) >= 0) {
                const frame = buffer.slice(0, end);

                buffer = buffer.slice(end + 2);

                // Only the event name and the `full` flag, without parsing the event: parsing would count as work.
                if (frame.startsWith("event: view\n") && frame.includes('"full":true')) {
                    resolveFull!();
                }
            }
        }
    })().catch((error: Error) => {
        if (error.name !== "AbortError") {
            throw error;
        }
    });

    return {
        fullView,
        close: async () => {
            controller.abort();
            await reading;
        },
    };
}

/**
 * Wait until the server has gone quiet: no event pushed and no SQL statement for `quietMs`. Pushes coalesce over 90 ms
 * and native runs finish asynchronously, so a scenario's window ends here, not when its request answered.
 */
async function quiet(quietMs = 400, limitMs = 20_000): Promise<void> {
    const started = Date.now();
    let last = snapshot();
    let calmSince = Date.now();

    while (Date.now() - calmSince < quietMs) {
        if (Date.now() - started > limitMs) {
            throw new Error(`The server did not go quiet within ${limitMs} ms`);
        }

        await new Promise((resolve) => setTimeout(resolve, 50));
        const now = snapshot();

        if (
            now["push.events"] !== last["push.events"] ||
            now["sql.statements"] !== last["sql.statements"]
        ) {
            calmSince = Date.now();
        }

        last = now;
    }
}

/** Time `action` and count its work, through the quiet that follows it. Counts `action` returns join the counters. */
async function scenario(
    name: string,
    action: () => Promise<Record<string, number> | void>,
    phaseTimings?: () => Record<string, number>,
): Promise<void> {
    await quiet();
    const before = snapshot();
    const timingBefore = nativeTimingSnapshot();
    const started = performance.now();
    const extra = await action();
    const ms = performance.now() - started;
    const native = { ...nativeTimingSince(timingBefore), ...phaseTimings?.() };

    await quiet();
    results.push({
        scenario: name,
        ms,
        counts: { ...since(before), ...extra },
        ...(Object.keys(native).length === 0 ? {} : { extra: native }),
    });
}

const submit = (id: number, turn: number, text = `Question ${turn}.`) =>
    call(`c/${id}/submit`, "POST", { text, requestId: `perf-${id}-${turn}` });

// ─── Seed: a session with history, and more sessions for the list.

const history = (await call("sessions", "POST", { title: "History", backend: "rotom" })).value
    .id as number;

for (let turn = 1; turn <= WORKLOAD.seededTurns; turn++) {
    assert.equal((await submit(history, turn)).value.status, "settled");
}

for (let index = 0; index < WORKLOAD.extraSessions; index++) {
    await call("sessions", "POST", { title: `Session ${index}`, backend: "rotom" });
}

// ─── Scenarios.

let appCloseMs = 0;
let appOpenMs = 0;

await scenario(
    "startup.restart",
    async () => {
        let started = performance.now();

        await app.close();
        appCloseMs = performance.now() - started;
        started = performance.now();
        app = await open();
        appOpenMs = performance.now() - started;
        handler = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} });
    },
    () => ({ appCloseMs, appOpenMs }),
);
await app.hello(owner(app));

await scenario("sessions.list", async () => ({
    "http.body.bytes": (await call("sessions")).bytes,
}));

await scenario("session.open", async () => {
    const watcher = tab(history);

    await watcher.fullView;
    await watcher.close();
});

const fresh = (await call("sessions", "POST", { title: "Fresh", backend: "rotom" })).value
    .id as number;
const watcher = tab(fresh);

await watcher.fullView;
await scenario("turn.cold", async () => {
    assert.equal((await submit(fresh, 1)).value.status, "settled");
});
await scenario("turn.warm", async () => {
    assert.equal((await submit(fresh, 2)).value.status, "settled");
});
await scenario("turn.paced", async () => {
    assert.equal((await submit(fresh, 3, "Question 3, PACED.")).value.status, "settled");
});
await watcher.close();

await scenario("git.changes", async () => ({
    "http.body.bytes": (await call(`c/${history}/changes`)).bytes,
}));
await scenario("git.diff", async () => {
    const response = await fetch(`${base}/api/c/${history}/changes/diff?path=src/file-0.txt`, {
        headers: { authorization: `Bearer ${token}` },
    });
    const text = await response.text();

    assert.equal(response.status, 200);
    assert.match(text, /^diff --git a\/src\/file-0.txt b\/src\/file-0.txt$/m);
    assert.match(text, /^-line 0$/m);
    assert.match(text, /^\+changed 0$/m);

    return { "http.body.bytes": Buffer.byteLength(text) };
});
await scenario("git.branches", async () => ({
    "http.body.bytes": (await call(`c/${history}/branches`)).bytes,
}));
await scenario("commands.list", async () => ({
    "http.body.bytes": (await call(`c/${history}/prompts`)).bytes,
}));

const web = await measureWebOpen({
    base,
    ownerToken: app.config.ownerToken,
    sessionId: history,
    marker: `END-OF-ANSWER-${WORKLOAD.seededTurns}`,
    quiet,
    profile: join(root, "perf-browser"),
});

results.push(
    "unavailable" in web
        ? { scenario: "web.open", unavailable: web.unavailable }
        : { scenario: "web.open", ms: web.ms, counts: web.counts, extra: web.metrics },
);

// Append readiness workloads only after the existing scenarios: their session/history inputs stay unchanged.
const prepared = (await call("sessions", "POST", { title: "Prepared", backend: "rotom" })).value
    .id as number;
const preparedTab = tab(prepared);

await preparedTab.fullView;

async function discover(requestId: string): Promise<Record<string, number>> {
    const beforeCalls = inferenceRequests;
    const response = await call(`c/${prepared}/prompts`, "POST", { requestId });
    const value = response.value as { receipt: { status: string }; dynamicReady: boolean };

    assert.equal(value.receipt.status, "handled");
    assert.equal(value.dynamicReady, true);
    assert.equal(inferenceRequests, beforeCalls, "native discovery must not make a model request");

    return { "http.body.bytes": response.bytes };
}

await scenario("commands.discover.cold", () => discover("perf-discover-cold"));
await scenario("commands.discover.warm", () => discover("perf-discover-warm"));
await scenario("turn.prepared", async () => {
    const beforeCalls = inferenceRequests;

    assert.equal((await submit(prepared, 1)).value.status, "settled");
    assert.equal(inferenceRequests, beforeCalls + 1, "the prepared prompt makes one model request");
});
await preparedTab.close();

// Append projection workloads last so their larger history and extra tabs cannot alter established scenarios.
const projection = (await call("sessions", "POST", { title: "Projection", backend: "rotom" })).value
    .id as number;

for (let turn = 1; turn <= WORKLOAD.projectionTurns; turn++) {
    assert.equal(
        (await submit(projection, turn, `Projection seed ${turn}, PROJECTION-SEED.`)).value.status,
        "settled",
    );
}

const projectionTabs: ReturnType<typeof tab>[] = [];

await scenario("projection.large.open", async () => {
    for (let index = 0; index < WORKLOAD.projectionTabs; index++) {
        const watcher = tab(projection);

        projectionTabs.push(watcher);
        await watcher.fullView;
    }
});
await scenario("projection.large.paced", async () => {
    assert.equal(
        (await submit(projection, WORKLOAD.projectionTurns + 1, "Projection paced, PACED.")).value
            .status,
        "settled",
    );
});
await Promise.all(projectionTabs.map((watcher) => watcher.close()));

const webPaced = await measureWebOpen({
    base,
    ownerToken: app.config.ownerToken,
    sessionId: history,
    marker: `END-OF-ANSWER-${WORKLOAD.seededTurns}`,
    quiet,
    profile: join(root, "perf-browser-paced"),
    afterOpen: {
        marker: `END-OF-ANSWER-${WORKLOAD.seededTurns + 1}`,
        action: async () => {
            assert.equal(
                (await submit(history, WORKLOAD.seededTurns + 1, "Browser reply, PACED.")).value
                    .status,
                "settled",
            );
        },
    },
});

results.push(
    "unavailable" in webPaced
        ? { scenario: "web.paced", unavailable: webPaced.unavailable }
        : {
              scenario: "web.paced",
              ms: webPaced.ms,
              counts: webPaced.counts,
              extra: webPaced.metrics,
          },
);

const context: ScenarioContext = {
    app,
    alice,
    base,
    history,
    ownerToken: app.config.ownerToken,
    root,
    token,
    raw,
    results,
    call,
    inferenceRequests: () => inferenceRequests,
    quiet,
    scenario,
    submit,
    tab,
    getHandler: () => handler,
    setHandler: (next) => {
        handler = next;
    },
};

await runImageScenarios(context);
await runHistoryScenarios(context);
await runNativeWarmScenarios(context);
await runEstablishedSends(context);
await runJournalScenario(context);
await runNativeLongScenario(context);
await runAssetScenarios(context);
await runNetworkSends(context);

writeFileSync(out, raw.stringify({ workload: WORKLOAD, results }, null, 2));
server.closeAllConnections();
server.close();
model.close();
await app.close();
cleanUp();

if (process.env.ROTOM_PERF_STORAGE_WORKER === "1") {
    assert.ok((snapshot()["storage.worker.replyBytes"] ?? 0) > 0, "worker measurement is required");
    assert.equal(
        snapshot()["storage.worker.unavailable"] ?? 0,
        0,
        "unmeasured worker work is unavailable, not zero",
    );
}

process.exit(0);
