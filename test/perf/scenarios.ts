/**
 * One run of the controlled benchmarks: a real server in team kernel mode, real rotom child processes, a real
 * event-stream tab, and a loopback OpenAI-compatible model that streams a fixed answer. No real account is used.
 * Each scenario records how long it took and the work counters (`counters.ts`) for exactly its window.
 *
 *   node test/perf/scenarios.ts <out.json>
 *
 * `measure.ts` runs this several times, each in a fresh process, and turns the runs into a report.
 */
import {
    nativeTimingSince,
    nativeTimingSnapshot,
    raw,
    since,
    snapshot,
    type Counts,
} from "./counters.ts";
import { cleanUp, owner, root, work } from "../helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { PocketApp } from "../../src/server/app.ts";
import { createHandler } from "../../src/server/http.ts";
import type { Runtime } from "../../src/server/team-accounts.ts";
import type { User } from "../../src/server/config.ts";
import { measureWebOpen } from "./browser.ts";
import { WORKLOAD } from "./workload.ts";
import { imageFixture, probeImages } from "./images.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import { NATIVE_ENTRY } from "../../src/server/entry-format.ts";
import { sniffImage } from "../../src/server/http/assets.ts";
import { measureImageNetwork } from "./image-network.ts";
import { measurePasteNetwork } from "./paste-network.ts";
import { sessionListTab } from "./session-list.ts";
import { claimFor } from "./view-claim.ts";
import { type Transcript, viewTab } from "./view-tab.ts";

export type ScenarioResult =
    | { scenario: string; ms: number; counts: Counts; extra?: Record<string, number> }
    | { scenario: string; unavailable: string };

const out = process.argv[2];

if (out === undefined) {
    throw new Error("Usage: node test/perf/scenarios.ts <out.json>");
}

const results: ScenarioResult[] = [];

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
    const text = request.includes("PROJECTION-SEED")
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

await scenario("startup.restart", async () => {
    await app.close();
    app = await open();
    handler = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} });
});
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

// Image retrieval reads the Durable mirror, not native RPC. Seed that exact persisted representation, after
// every established workload. No upload/resizing/model cost is hidden inside these retrieval-only scenarios.
const imageSession = (await call("sessions", "POST", { title: "Images", backend: "rotom" })).value
    .id as unknown as ConversationId;
const images = Array.from({ length: WORKLOAD.imageEntries }, (_, index) =>
    imageFixture(WORKLOAD.imageWidth, WORKLOAD.imageHeight, index),
);
const imageEntries = await app.harness.commit(async (tx) => {
    const ids: number[] = [];

    for (const [index, bytes] of images.entries()) {
        const record = await tx.appendEntry(imageSession, {
            kind: NATIVE_ENTRY,
            data: {
                entry: {
                    type: "message",
                    id: `image-${index}`,
                    parentId: index === 0 ? null : `image-${index - 1}`,
                    message: {
                        role: "user",
                        timestamp: index,
                        content: [
                            {
                                type: "text",
                                text: `Image ${index}.`.padEnd(WORKLOAD.answerChars, "."),
                            },
                            {
                                type: "image",
                                mimeType: "image/png",
                                data: bytes.toString("base64"),
                            },
                        ],
                    },
                },
            } as JsonValue,
        });

        ids.push(record.id as unknown as number);
    }

    return ids;
}, BACKGROUND_CONTEXT);
const imageProbe = probeImages(app.transcripts);
const unprobedHandler = handler;

handler = (request, response) =>
    imageProbe.run(request, response, () => unprobedHandler(request, response));

try {
    for (const [name, indices] of [
        ["image.single", [0]],
        [
            "image.concurrent",
            Array.from({ length: WORKLOAD.imageParallel }, (_, index) => index + 1),
        ],
    ] as const) {
        imageProbe.reset();
        let clientMs = 0;

        await scenario(
            name,
            async () => {
                const beforeInference = inferenceRequests;
                const beforeWork = snapshot();
                const sizes = await Promise.all(
                    indices.map(async (index) => {
                        const started = performance.now();
                        const response = await fetch(
                            `${base}/api/c/${imageSession}/image/${imageEntries[index]}/0`,
                            {
                                headers: { authorization: `Bearer ${token}` },
                            },
                        );
                        const bytes = Buffer.from(await response.arrayBuffer());

                        clientMs += performance.now() - started;
                        assert.equal(response.status, 200);
                        assert.equal(response.headers.get("content-type"), "image/png");
                        assert.equal(
                            response.headers.get("cache-control"),
                            "private, max-age=31536000, immutable",
                        );
                        assert.deepEqual(
                            bytes,
                            images[index],
                            "the actual HTTP body, not just its size or signature",
                        );

                        return bytes.length;
                    }),
                );
                const measured = imageProbe.report(indices.length);

                assert.equal(
                    inferenceRequests,
                    beforeInference,
                    "retrieval must not call the model",
                );
                assert.equal(
                    since(beforeWork)["subprocess.total"] ?? 0,
                    0,
                    "retrieval must not start a child",
                );
                assert.equal(measured.counts["image.lookup.calls"], indices.length);
                assert.equal(measured.counts["image.decode.calls"], indices.length);
                assert.equal(
                    measured.counts["image.decode.bytes"],
                    sizes.reduce((a, b) => a + b, 0),
                );

                return { ...measured.counts, "http.body.bytes": sizes.reduce((a, b) => a + b, 0) };
            },
            () => ({ ...imageProbe.report(indices.length).timings, imageClientMs: clientMs }),
        );
    }
} finally {
    handler = unprobedHandler;
    imageProbe.restore();
}

// Transcript thumbnails: what the browser asks for to show a stored image inline. The body must be a real image of
// the type it claims; its size is whatever the server chooses to send for a thumbnail.
for (const name of ["image.thumbs.first", "image.thumbs.again"]) {
    await scenario(name, async () => {
        const beforeInference = inferenceRequests;
        const sizes = await Promise.all(
            Array.from({ length: WORKLOAD.imageParallel }, async (_, offset) => {
                const index = WORKLOAD.imageParallel + 1 + offset;
                const response = await fetch(
                    `${base}/api/c/${imageSession}/image/${imageEntries[index]}/0?size=thumb`,
                    { headers: { authorization: `Bearer ${token}` } },
                );
                const bytes = Buffer.from(await response.arrayBuffer());

                assert.equal(response.status, 200);
                assert.equal(response.headers.get("content-type"), sniffImage(bytes));
                assert.equal(
                    response.headers.get("cache-control"),
                    "private, max-age=31536000, immutable",
                );

                return bytes.length;
            }),
        );

        assert.equal(inferenceRequests, beforeInference, "thumbnails must not call the model");

        return { "http.body.bytes": sizes.reduce((a, b) => a + b, 0) };
    });
}

const imageNetwork = await measureImageNetwork({
    base,
    token,
    paths: Array.from({ length: WORKLOAD.imageParallel }, (_, offset) => {
        const index = 2 * WORKLOAD.imageParallel + 1 + offset;

        return `/api/c/${imageSession}/image/${imageEntries[index]}/0?size=thumb`;
    }),
    profile: join(root, "perf-image-network"),
    quiet,
});

results.push(
    "unavailable" in imageNetwork
        ? { scenario: "image.thumbs.network", unavailable: imageNetwork.unavailable }
        : { scenario: "image.thumbs.network", ms: imageNetwork.ms, counts: imageNetwork.counts },
);

const beforePasteInference = inferenceRequests;
const pasteNetwork = await measurePasteNetwork({
    base,
    token,
    conversation: imageSession,
    profile: join(root, "perf-paste-network"),
    quiet,
});

assert.equal(inferenceRequests, beforePasteInference, "pasting/uploading must not call the model");
results.push(
    "unavailable" in pasteNetwork
        ? { scenario: "image.paste.network", unavailable: pasteNetwork.unavailable }
        : { scenario: "image.paste.network", ms: pasteNetwork.ms, counts: pasteNetwork.counts },
);

const originalTags = images.map(
    (image) => `"sha256-${createHash("sha256").update(image).digest("hex")}"`,
);

for (const name of ["image.original.again", "image.original.validated"]) {
    await scenario(name, async () => {
        const beforeInference = inferenceRequests;
        const sizes = await Promise.all(
            Array.from({ length: WORKLOAD.imageParallel }, async (_, offset) => {
                const index = offset + 1;
                const response = await fetch(
                    `${base}/api/c/${imageSession}/image/${imageEntries[index]}/0`,
                    {
                        headers: {
                            authorization: `Bearer ${token}`,
                            ...(name.endsWith("validated")
                                ? { "if-none-match": originalTags[index]! }
                                : {}),
                        },
                    },
                );
                const bytes = Buffer.from(await response.arrayBuffer());

                assert.ok(
                    response.status === 200 ||
                        (name.endsWith("validated") && response.status === 304),
                );

                if (response.status === 304) {
                    assert.equal(response.headers.get("etag"), originalTags[index]);
                    assert.equal(bytes.length, 0);
                } else {
                    assert.deepEqual(
                        bytes,
                        images[index],
                        "repeated originals must still be byte-identical",
                    );
                }

                return bytes.length;
            }),
        );

        assert.equal(inferenceRequests, beforeInference);

        return { "http.body.bytes": sizes.reduce((a, b) => a + b, 0) };
    });
}

// Changes polling on a long history whose entries carry images: four tabs ask at once, then all four ask again
// with nothing changed (what the browser's 4-8 s poll does while the agent works).
await scenario("changes.poll.images", async () => {
    let bytes = 0;

    for (let round = 0; round < 2; round++) {
        const answers = await Promise.all(
            Array.from({ length: WORKLOAD.projectionTabs }, () =>
                call(`c/${imageSession}/changes`),
            ),
        );
        const first = raw.stringify(answers[0]!.value);

        assert.ok(Array.isArray(answers[0]!.value.files), "a changes listing");
        assert.ok(
            answers.every((answer) => raw.stringify(answer.value) === first),
            "every tab sees the same changes",
        );
        bytes += answers.reduce((sum, answer) => sum + answer.bytes, 0);
    }

    return { "http.body.bytes": bytes };
});

// Four tabs with the full catalogue already loaded: two renames change one row at a time. Setup and first snapshots
// are outside this window; the renames, resulting pushes, and correctness readback are all inside it.
const listTabs = Array.from({ length: WORKLOAD.projectionTabs }, () =>
    sessionListTab(base, token, raw),
);

try {
    await Promise.all(listTabs.map((tab) => tab.until(() => true)));
    await scenario("sessions.rename.tabs", async () => {
        for (const title of ["Catalogue rename one", "Catalogue rename two"]) {
            await call(`sessions/${history}`, "POST", { title });
            await Promise.all(
                listTabs.map((tab) =>
                    tab.until((rows) =>
                        rows.some((row) => row.id === history && row.title === title),
                    ),
                ),
            );
        }

        const expected = raw.stringify(app.sessions(owner(app)));

        for (const tab of listTabs) {
            assert.equal(raw.stringify(tab.rows), expected, "each tab reconstructs the full list");
        }
    });
} finally {
    await Promise.all(listTabs.map((tab) => tab.close()));
}

// A tab that held the 12-turn session's transcript connects again (a network blip, or a reload with a saved copy) and
// says which entries it holds. A server that ignores the claim sends them all again; either way the rebuilt
// transcript must equal the one the tab had, entry for entry.
const build = ((await call("me")).value as { server: { startedAt: number } }).server.startedAt;
const holder = viewTab(base, token, raw, history);
const held = await holder.full;

await holder.close();
await quiet();
await scenario("session.reclaim", async () => {
    const again = viewTab(base, token, raw, history, {
        have: claimFor(build, held.order),
        entries: held.entries,
    });
    const view = await again.full;

    await again.close();
    assert.deepEqual(view.order, held.order);

    for (const id of view.order) {
        assert.deepEqual(view.entries.get(id), held.entries.get(id), `entry ${id}`);
    }
});

// Coming back to a session opened before in this browser: until the page shows the server's own view.
const reopen = await measureWebOpen({
    base,
    ownerToken: app.config.ownerToken,
    sessionId: history,
    marker: `END-OF-ANSWER-${WORKLOAD.seededTurns}`,
    quiet,
    profile: join(root, "perf-browser-reopen"),
    reopen: true,
});

results.push(
    "unavailable" in reopen
        ? { scenario: "web.reopen", unavailable: reopen.unavailable }
        : { scenario: "web.reopen", ms: reopen.ms, counts: reopen.counts, extra: reopen.metrics },
);

// A long history, seeded as the native mirror stores it (no model): opening it, then reading all of it.
const long = (await call("sessions", "POST", { title: "Long", backend: "rotom" })).value
    .id as unknown as ConversationId;

await app.harness.commit(async (tx) => {
    for (let turn = 1; turn <= WORKLOAD.longTurns; turn++) {
        const parent = turn === 1 ? null : `long-answer-${turn - 1}`;

        await tx.appendEntry(long, {
            kind: NATIVE_ENTRY,
            data: {
                entry: {
                    type: "message",
                    id: `long-question-${turn}`,
                    parentId: parent,
                    message: { role: "user", timestamp: turn, content: `Long question ${turn}?` },
                },
            } as JsonValue,
        });
        await tx.appendEntry(long, {
            kind: NATIVE_ENTRY,
            data: {
                entry: {
                    type: "message",
                    id: `long-answer-${turn}`,
                    parentId: `long-question-${turn}`,
                    message: {
                        role: "assistant",
                        timestamp: turn,
                        stopReason: "stop",
                        content: [
                            {
                                type: "text",
                                text: `LONG-ANSWER-${turn} `.padEnd(WORKLOAD.longAnswerChars, "x"),
                            },
                        ],
                    },
                },
            } as JsonValue,
        });
    }
}, BACKGROUND_CONTEXT);

// The reference: an unpaged view of the same history, outside every window.
const reference = viewTab(base, token, raw, long as unknown as number);
const whole = await reference.full;

await reference.close();
await quiet();

let longTab: ReturnType<typeof viewTab> | undefined;
let opened: Transcript & { kept: number };

try {
    await scenario("session.open.long", async () => {
        longTab = viewTab(
            base,
            token,
            raw,
            long as unknown as number,
            undefined,
            `&tail=${WORKLOAD.longTail}`,
        );
        opened = await longTab.full;
        assert.deepEqual(opened.order, whole.order, "the whole order, whatever is sent");
        assert.equal(opened.order.at(-1), whole.order.at(-1));
        assert.ok(opened.entries.has(whole.order.at(-1)!), "the newest entry is there");

        for (const [id, entry] of opened.entries) {
            assert.deepEqual(entry, whole.entries.get(id), `entry ${id}`);
        }
    });
    // Read back what the tab lacks, newest page first, as scrolling up does; a tab that has everything asks nothing.
    await scenario("session.history.earlier", async () => {
        const held = opened.entries;
        let bytes = 0;

        for (let page = 0; page < 1000; page++) {
            const first = opened.order.findIndex((id) => held.has(id));

            if (first <= 0) {
                break;
            }

            const response = await fetch(
                `${base}/api/c/${long}/entries?before=${opened.order[first]}`,
                { headers: { authorization: `Bearer ${token}` } },
            );
            const text = await response.text();

            assert.equal(response.status, 200, text);
            bytes += Buffer.byteLength(text);

            const { entries } = raw.parse(text) as { entries: { id: number }[] };

            assert.ok(entries.length > 0, "a page makes progress");

            for (const entry of entries) {
                held.set(entry.id, entry);
            }
        }

        assert.deepEqual(
            opened.order.filter((id) => !held.has(id)),
            [],
            "the tab holds the whole history",
        );

        for (const id of opened.order) {
            assert.deepEqual(held.get(id), whole.entries.get(id), `entry ${id}`);
        }

        return { "http.body.bytes": bytes };
    });
} finally {
    await longTab?.close();
}

const webLong = await measureWebOpen({
    base,
    ownerToken: app.config.ownerToken,
    sessionId: long as unknown as number,
    marker: `LONG-ANSWER-${WORKLOAD.longTurns} `,
    quiet,
    profile: join(root, "perf-browser-long"),
});

results.push(
    "unavailable" in webLong
        ? { scenario: "web.open.long", unavailable: webLong.unavailable }
        : {
              scenario: "web.open.long",
              ms: webLong.ms,
              counts: webLong.counts,
              extra: webLong.metrics,
          },
);

// A member focuses the message box of a new session of theirs: its native process may start before they send.
const ready = (await call("sessions", "POST", { title: "Warm", backend: "rotom" })).value
    .id as number;
const readyTab = tab(ready);

await readyTab.fullView;
await scenario("native.warm", async () => {
    const response = await fetch(`${base}/api/c/${ready}/warm`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${token}`,
            "x-pocket": "1",
            "content-type": "application/json",
        },
        body: "{}",
    });
    const text = await response.text();

    // A server that does not warm refuses the route for a native session (409, no Durable fallback); a refusal is no
    // work. A warm start shows as one rotom process (`subprocess.rotom`).
    assert.ok([200, 409].includes(response.status), `warm: ${response.status} ${text}`);
});
await scenario("turn.prewarmed", async () => {
    assert.equal((await submit(ready, 1)).value.status, "settled");
});
await readyTab.close();

writeFileSync(out, raw.stringify({ workload: WORKLOAD, results }, null, 2));
server.closeAllConnections();
server.close();
model.close();
await app.close();
cleanUp();
process.exit(0);
