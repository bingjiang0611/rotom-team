// Warming a member's native process before they send: the real rotom kernel with a loopback model, no real account.
// A warm start spends nothing, a send takes the warm process, each member keeps one, and one that changes account or
// loses the session loses it.
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { PocketApp } from "../src/server/app.ts";
import { createHandler } from "../src/server/http.ts";
import { kernelRunChannel, type KernelRunSignal } from "../src/server/perf-channels.ts";
import { cleanUp, owner, root, until, work as workspace } from "./helpers.ts";

const FIRST_OUTPUT_DELAY_MS = 50;
const TOOL_SECONDS = 0.1;

const work = realpathSync(workspace);
const runs: KernelRunSignal[] = [];
const listen = (message: unknown) => runs.push(message as KernelRunSignal);
/** Requests the loopback model got: a warm start must make none. */
let modelRequests = 0;
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

        modelRequests += 1;

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

    writeFileSync(join(work, "AGENTS.md"), "Warm test project.\n");
    app = await PocketApp.open({
        dataDir: join(realpathSync(root), "native-warm-data"),
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

const post = async (path: string, body: object, bearer = token) => {
    const response = await fetch(`${base}/api/${path}`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${bearer}`,
            "x-pocket": "1",
            "content-type": "application/json",
        },
        body: JSON.stringify(body),
    });

    return { status: response.status, text: await response.text() };
};

const call = async (path: string, body: object, bearer = token) => {
    const { status, text } = await post(path, body, bearer);

    assert.equal(status, 200, `${path}: ${text}`);

    return JSON.parse(text) as Record<string, unknown>;
};

/** Native processes running now: each has its gate file while it runs. */
const gates = () => {
    const folder = join(app.dataDir, "kernel-gates");

    return existsSync(folder)
        ? readdirSync(folder).filter((name) => name.endsWith(".json")).length
        : 0;
};

const session = async (title: string) =>
    (await call("sessions", { title, backend: "rotom" })).id as number;
const warm = async (id: number, bearer = token) =>
    (await call(`c/${id}/warm`, {}, bearer)).warmed as boolean;

const send = async (id: number, turn: string) => {
    runs.length = 0;
    assert.equal(
        (await call(`c/${id}/submit`, { text: `Turn ${turn}.`, requestId: `warm-${turn}` })).status,
        "settled",
    );

    return runs.find((each) => each.outcome === "prompt:settled")?.prompt?.process;
};

test("a warm start spends nothing, and the first send takes that process", async () => {
    const id = await session("Warm");
    const before = gates();
    const requests = modelRequests;

    assert.equal(await warm(id), true);
    assert.equal(gates(), before + 1, "one process started");
    assert.equal(modelRequests, requests, "a warm process asks the model nothing");
    assert.equal(await warm(id), true, "asking again starts nothing more");
    assert.equal(gates(), before + 1);
    assert.equal(await send(id, "warm-1"), "reused");
    assert.equal(app.kernel!.executions.unusedWarm().length, 0, "used, it is no longer unused");
    assert.equal(gates(), before + 1);
});

test("a send while its warm start is on its way waits for that process instead of a second", async () => {
    const id = await session("Race");
    const before = gates();
    const warming = warm(id);
    const process = await send(id, "race-1");

    assert.equal(await warming, true);
    assert.equal(process, "reused");
    assert.equal(gates(), before + 1, "one process for the session");
});

test("each member keeps one unused warm process; warming another session retires the first", async () => {
    const first = await session("First");
    const second = await session("Second");
    const before = gates();

    assert.equal(await warm(first), true);
    assert.equal(gates(), before + 1);
    assert.equal(await warm(second), true);
    assert.equal(gates(), before + 1, "the first warm process retired for the second");
    assert.deepEqual(
        app.kernel!.executions.unusedWarm().map((each) => each.sessionId),
        [String(second)],
    );
    assert.equal(await send(first, "first-1"), "started", "the retired one starts again on send");
});

test("another member cannot warm a session that runs on someone else's account", async () => {
    const id = await session("Owned");
    const guest = app.config.addUser("Guest", "guest");
    const guestToken = app.config.addDevice(guest.user.id).token;
    const before = gates();
    const { status, text } = await post(`c/${id}/warm`, {}, guestToken);

    // The session is not shared with them: refused like any request of theirs for it.
    assert.ok(status === 403 || status === 404 || JSON.parse(text).warmed === false, text);
    assert.equal(gates(), before);
});

test("changing a member's account retires their unused warm process", async () => {
    const id = await session("Account");

    // An earlier test's unused warm process retires for this one: count from after the warm start.
    assert.equal(await warm(id), true);
    const warmed = gates();

    await app.execution.accountIdle(owner(app));
    assert.equal(gates(), warmed - 1, "retired before the account changes");
    assert.equal(app.kernel!.executions.unusedWarm().length, 0);
});

test("an unused warm process retires, and the next send starts one again", async () => {
    const id = await session("Retire");

    assert.equal(await warm(id), true);
    const warmed = gates();
    const [unused] = app.kernel!.executions.unusedWarm();

    await app.kernel!.executions.retireUnused(unused!.segmentId);
    assert.equal(gates(), warmed - 1, "retired");
    assert.equal(await send(id, "retire-1"), "started");
});

test("a member who may no longer drive the session loses its unused warm process", async () => {
    const { user: guest } = app.config.addUser("Gina", "guest");
    const guestToken = app.config.addDevice(guest.id).token;
    const id = (await call("sessions", { title: "Gina's", backend: "rotom" }, guestToken))
        .id as number;

    assert.equal(await warm(id, guestToken), true);
    assert.ok(app.kernel!.executions.unusedWarm().some((each) => each.sessionId === String(id)));
    app.setAccess(owner(app), guest.id, { role: "viewer" });
    // Revocation runs in the background: it is done once the process is gone.
    await until(
        () => !app.kernel!.executions.unusedWarm().some((each) => each.sessionId === String(id)),
        "the viewer's warm process to retire",
    );
    assert.equal(await post(`c/${id}/warm`, {}, guestToken).then((each) => each.status), 403);
});
