// Explicit real-product application proof; only a loopback model and synthetic request credentials.
import { root, work, owner, until, context } from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import {
    mkdirSync,
    readFileSync,
    writeFileSync,
    realpathSync,
    readdirSync,
    existsSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PocketApp } from "../src/server/app.ts";
import { createHandler } from "../src/server/http.ts";
import { COOKIE } from "../src/server/auth.ts";
import { ConfigurationDoc } from "../src/server/team-profiles.ts";
import type { Runtime } from "../src/server/team-accounts.ts";
import type { User } from "../src/server/config.ts";

const folder = join(realpathSync(root), "native-app");
const workspace = realpathSync(work);

mkdirSync(folder, { mode: 0o700 });
const secret = `synthetic-request-key-${randomUUID()}`;
const requestMembers: string[] = [];
let calls = 0,
    legacyCalls = 0,
    hold = false;
const modelServer = createServer(async (req, res) => {
    try {
        const authorization = req.headers.authorization;

        assert.ok(authorization && authorization.startsWith(`Bearer ${secret}:`));
        requestMembers.push(authorization.slice(`Bearer ${secret}:`.length));
        let body = "";

        for await (const chunk of req) {
            body += chunk;
        }

        assert.ok(!body.includes(secret));
        const input = JSON.parse(body);

        assert.ok(body.includes("FROZEN_PERSONAL_CONTEXT"));
        assert.ok(!body.includes("UNFROZEN_CONTEXT"));
        calls++;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const emit = (delta: unknown, finish: string | null = null) =>
            res.write(
                `data: ${JSON.stringify({ id: "app-fixture", object: "chat.completion.chunk", created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
            );

        emit({ role: "assistant" });

        if (hold) {
            emit({ content: "Waiting for cancellation" });

            return;
        }

        const written = input.messages.some(
            (message: { role: string; tool_call_id?: string }) =>
                message.role === "tool" && message.tool_call_id === "native-app-write",
        );

        if (!written) {
            emit({
                tool_calls: [
                    {
                        index: 0,
                        id: "native-app-write",
                        type: "function",
                        function: {
                            name: "write",
                            arguments: JSON.stringify({
                                path: "native-app.txt",
                                content: "APP_NATIVE_OK\n",
                            }),
                        },
                    },
                ],
            });
            emit({}, "tool_calls");
        } else {
            emit({ content: "APP_NATIVE_FINISHED" });
            emit({}, "stop");
        }

        res.end("data: [DONE]\n\n");
    } catch (error) {
        res.destroy(error as Error);
    }
});

modelServer.listen(0, "127.0.0.1");
await once(modelServer, "listening");
const baseUrl = `http://127.0.0.1:${(modelServer.address() as { port: number }).port}/v1`;
const configureUserModels = (models: Runtime, user: User) =>
    models.registerNativeProvider({
        id: "openai",
        name: "Private scripted native fixture",
        auth: {
            apiKey: {
                name: "Scripted request auth",
                resolve: async () => ({
                    auth: { apiKey: `${secret}:${user.id}` },
                    source: "isolated fixture",
                }),
            },
        },
        getModels: () => [
            {
                id: "app-native",
                name: "app-native",
                api: "openai-completions",
                provider: "openai",
                baseUrl,
                reasoning: false,
                input: ["text"],
                contextWindow: 32000,
                maxTokens: 1024,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
        ],
        stream: () => {
            legacyCalls++;

            throw new Error("Durable model path must not execute native conversations");
        },
        streamSimple: () => {
            legacyCalls++;

            throw new Error("Durable model path must not execute native conversations");
        },
    });
const open = (kernel = true) =>
    PocketApp.open({
        dataDir: folder,
        defaultCwd: workspace,
        supervised: false,
        kernel,
        browser: null,
        log: () => {},
        configureUserModels,
    });
let app = await open();
let bootstrap: { token: string; id: number } | undefined;
const server = createServer((req, res) => {
    if (req.url === "/kernel-proof-bootstrap" && bootstrap) {
        const { token, id } = bootstrap;

        bootstrap = undefined;
        res.writeHead(302, {
            "Set-Cookie": `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`,
            Location: `/s/${id}`,
            "Cache-Control": "no-store",
        }).end();

        return;
    }

    return handler(req, res);
});
let handler = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} });

server.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const request = (token: string, path: string, method = "GET", body?: object) =>
    fetch(`${base}/api/${path}`, {
        method,
        headers: {
            authorization: `Bearer ${token}`,
            "x-pocket": "1",
            "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
const report: Record<string, unknown> = {
    realProvider: false,
    status: "running",
    webUiVerified: false,
};

try {
    const a = owner(app),
        bob = app.config.addUser("Bob", "guest"),
        viewer = app.config.addUser("Viewer", "viewer");
    const aliceToken = app.config.addDevice(a.id).token;

    await app.hello(bob.user);

    for (const user of [a, bob.user]) {
        app.profiles.save(user, {
            name: "Frozen",
            instructions: "FROZEN_PERSONAL_CONTEXT",
            skillDirectories: [],
        });
    }

    const beforeInvalidBackend = app.sessions().length;

    for (const backend of [["rotom"], ["durable"], null, {}, "unsupported"]) {
        assert.equal((await request(aliceToken, "sessions", "POST", { backend })).status, 400);
    }

    assert.equal(app.sessions().length, beforeInvalidBackend);
    assert.equal(calls, 0);
    report.invalidBackendRejectedWithoutFallback = true;

    const created = await request(aliceToken, "sessions", "POST", {
        title: "Native app proof",
        backend: "rotom",
    });

    assert.equal(created.status, 200);
    const { id } = (await created.json()) as { id: number };

    assert.equal(app.sessionMeta(id as never)?.backend, "rotom");
    writeFileSync(join(workspace, "AGENTS.md"), "UNFROZEN_CONTEXT\n");
    const first = await request(aliceToken, `c/${id}/submit`, "POST", {
        text: "Write the proof file.",
        requestId: "first",
    });

    assert.equal(first.status, 200);
    const receipt = (await first.json()) as { id: string; status: string };

    assert.equal(receipt.status, "settled", JSON.stringify(receipt));
    assert.equal(calls, 2);
    assert.equal(legacyCalls, 0);
    assert.equal(readFileSync(join(workspace, "native-app.txt"), "utf8"), "APP_NATIVE_OK\n");
    const shared = await request(viewer.token, `c/${id}/kernel`);

    assert.equal(shared.status, 200);
    const view = (await shared.json()) as {
        usage: { memberId: string }[];
        messages: unknown[];
        costStatus: string;
    };

    assert.equal(view.usage.length, 2);
    assert.ok(view.usage.every((row) => row.memberId === a.id));
    assert.equal(view.costStatus, "unknown");
    assert.ok(JSON.stringify(view.messages).includes("APP_NATIVE_FINISHED"));
    assert.equal(
        (
            await request(bob.token, `c/${id}/submit`, "POST", {
                text: "Borrow Alice",
                requestId: "foreign",
            })
        ).status,
        403,
    );
    assert.equal(
        (
            await request(viewer.token, `c/${id}/submit`, "POST", {
                text: "Run",
                requestId: "viewer",
            })
        ).status,
        403,
    );
    assert.equal((await request(aliceToken, `c/${id}/compact`, "POST", {})).status, 409);
    await assert.rejects(
        app.commands.submit(id as never, a, { text: "legacy bypass", requestId: "legacy" }),
        /backend/,
    );
    const duplicate = await request(aliceToken, `c/${id}/submit`, "POST", {
        text: "Write the proof file.",
        requestId: "first",
    });

    assert.equal(((await duplicate.json()) as { id: string }).id, receipt.id);
    assert.equal(calls, 2);
    await app.close();
    app = await open();
    handler = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} });
    const restarted = await request(aliceToken, `c/${id}/submit`, "POST", {
        text: "Write the proof file.",
        requestId: "first",
    });

    assert.equal(((await restarted.json()) as { id: string }).id, receipt.id);
    assert.equal(calls, 2);
    const resumed = await request(aliceToken, `c/${id}/submit`, "POST", {
        text: "Continue without repeating tools",
        requestId: "continue",
    });

    const resumedBody = (await resumed.json()) as { status: string };

    assert.equal(resumed.status, 200, JSON.stringify(resumedBody));
    assert.equal(resumedBody.status, "settled");
    assert.equal(calls, 3);
    assert.equal(app.kernel!.snapshot(id as never, owner(app)).usage.length, 3);
    const snapshot = await app.harness.snapshot(ConfigurationDoc, id as never, context);

    await app.harness.commit(async (tx) => {
        (await tx.doc(ConfigurationDoc, id as never)).snapshot = {
            ...snapshot!.snapshot!,
            digest: "changed",
        };
    }, context);
    assert.equal(
        (
            await request(aliceToken, `c/${id}/submit`, "POST", {
                text: "Must not send",
                requestId: "tampered",
            })
        ).status,
        409,
    );
    assert.equal(calls, 3);
    await app.harness.commit(async (tx) => {
        (await tx.doc(ConfigurationDoc, id as never)).snapshot = snapshot!.snapshot;
    }, context);

    writeFileSync(join(workspace, "AGENTS.md"), "NEW_PROJECT_CONTEXT\n");
    const bobNow = app.config.userById(bob.user.id)!;
    const bobSession = await app.commands.createSession(bobNow, { backend: "rotom" });

    hold = true;
    const inFlight = request(bob.token, `c/${bobSession.id}/submit`, "POST", {
        text: "Wait for revocation",
        requestId: "revoke",
    });

    await until(() => calls === 4, "native request began", 30000);
    app.setAccess(owner(app), bob.user.id, { role: "viewer" });
    const stopped = await inFlight;

    assert.equal(stopped.status, 200);
    assert.equal(((await stopped.json()) as { status: string }).status, "settled");
    assert.equal(calls, 4);
    assert.ok(
        JSON.stringify(
            app.kernel!.snapshot(bobSession.id, app.config.userById(bob.user.id)!),
        ).includes('"stopReason":"aborted"'),
    );
    hold = false;

    assert.deepEqual(requestMembers, [a.id, a.id, a.id, bob.user.id]);
    const beforeRejected = app.kernel!.executions.journal.receipts(String(id)).length;

    for (const invalid of [
        { text: "/compact", requestId: "slash" },
        { text: "hello", requestId: "x".repeat(128) },
    ]) {
        assert.equal((await request(aliceToken, `c/${id}/submit`, "POST", invalid)).status, 400);
    }

    assert.equal(app.kernel!.executions.journal.receipts(String(id)).length, beforeRejected);
    assert.equal(calls, 4);

    const carla = app.config.addUser("Carla", "guest");

    await app.hello(carla.user);
    app.profiles.save(carla.user, {
        name: "Frozen",
        instructions: "FROZEN_PERSONAL_CONTEXT",
        skillDirectories: [],
    });
    let project = app.projects.save(
        owner(app),
        {
            name: "Native rights",
            cwd: workspace,
            members: { [carla.user.id]: { view: true, continue: true, fork: true } },
        },
        (key) => !!app.config.userById(key),
    );
    const scoped = await app.commands.createSession(carla.user, { backend: "rotom" });

    project = app.projects.save(
        owner(app),
        { ...project, members: { [carla.user.id]: { view: true, continue: false, fork: false } } },
        (key) => !!app.config.userById(key),
    );
    await app.projectsChanged();
    assert.equal((await request(carla.token, `c/${scoped.id}/kernel`)).status, 200);
    assert.equal(
        (
            await request(carla.token, `c/${scoped.id}/submit`, "POST", {
                text: "Denied",
                requestId: "denied",
            })
        ).status,
        403,
    );
    project = app.projects.save(
        owner(app),
        { ...project, members: {} },
        (key) => !!app.config.userById(key),
    );
    await app.projectsChanged();
    assert.equal((await request(carla.token, `c/${scoped.id}/kernel`)).status, 404);
    app.projects.save(
        owner(app),
        { ...project, members: { [carla.user.id]: { view: true, continue: true, fork: true } } },
        (key) => !!app.config.userById(key),
    );
    await app.projectsChanged();
    app.spend.setPersonBudget(owner(app), carla.user.id, 10);
    assert.equal(
        (
            await request(carla.token, `c/${scoped.id}/submit`, "POST", {
                text: "Budget not bypassed",
                requestId: "budget",
            })
        ).status,
        409,
    );
    app.spend.setPersonBudget(owner(app), carla.user.id, null);
    app.accounts.beginChange(carla.user, "openai");
    app.accounts.endChange(carla.user);
    await app.accounts.refresh(carla.user);
    assert.equal(
        (
            await request(carla.token, `c/${scoped.id}/submit`, "POST", {
                text: "Old account generation",
                requestId: "generation",
            })
        ).status,
        403,
    );
    assert.equal(calls, 4);

    // No request credential or refresh-capable grant was stored by the native HOME.
    const nativeHome = join(folder, "kernel-homes", a.id);

    const nativeAuth = join(nativeHome, ".pi/agent/auth.json");

    assert.ok(!existsSync(nativeAuth) || readFileSync(nativeAuth, "utf8").trim() === "{}");

    function scan(path: string): void {
        for (const entry of readdirSync(path, { withFileTypes: true })) {
            const file = join(path, entry.name);

            if (entry.isDirectory()) {
                scan(file);
            } else if (entry.isFile()) {
                assert.equal(
                    readFileSync(file).includes(Buffer.from(secret)),
                    false,
                    "native files must not persist request credentials",
                );
            }
        }
    }

    scan(nativeHome);
    await app.close();
    app = await open(false);
    handler = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} });
    assert.equal(
        (
            await request(aliceToken, `c/${id}/submit`, "POST", {
                text: "Do not fall back",
                requestId: "disabled",
            })
        ).status,
        409,
    );
    assert.equal(calls, 4);
    assert.equal(legacyCalls, 0);
    // A pending receipt must not be escapable by disabling the executable or choosing another backend.
    await app.close();
    app = await open();
    handler = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} });
    app.setAccess(owner(app), bob.user.id, { role: "guest" });
    const legacy = await app.commands.createSession(owner(app), {
        title: "Existing engine baseline",
    });

    // Use Bob's existing native session but no model request: this is a simulated crash window.
    app.kernel!.executions.journal.reserve(
        String(bobSession.id),
        `${bob.user.id}:intent-only`,
        "never dispatched",
    );
    await app.close();
    await assert.rejects(open(false), /pending or unknown/);
    app = await open();
    handler = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} });
    assert.equal(app.kernel!.executions.journal.pending(bob.user.id)?.status, "unknown");
    await assert.rejects(
        app.execution.admit(legacy.id, app.config.userById(bob.user.id)!),
        /active or unknown/,
    );
    assert.equal(calls, 4);
    assert.equal(legacyCalls, 0);
    Object.assign(report, {
        status: "passed",
        projectViewAndContinue: true,
        accountGenerationChecked: true,
        budgetNotBypassed: true,
        slashAndLongRequestRejectedBeforeIntent: true,
        disablingCannotBypassUnknownFence: true,
        apiCreateSubmitReadAbort: true,
        roleRevocation: true,
        frozenContext: true,
        fixedPayer: true,
        restartIdempotency: true,
        nativeHistoryResume: true,
        noDurableFallback: true,
        privateRequestAuthNotPersisted: true,
        loopbackRequests: calls,
    });

    if (process.argv.includes("--serve")) {
        bootstrap = { token: app.config.addDevice(owner(app).id).token, id };
        const uiUrl = `http://rotom-team-kernel-proof.localhost:${(server.address() as { port: number }).port}/kernel-proof-bootstrap`;

        writeFileSync(
            join(realpathSync(root), "team-kernel-report.json"),
            JSON.stringify({ ...report, uiUrl }, null, 2),
            { mode: 0o600 },
        );
        console.log(
            JSON.stringify({
                uiUrl,
                evidence: join(realpathSync(root), "team-kernel-report.json"),
            }),
        );
        await Promise.race([once(process, "SIGTERM"), once(process, "SIGINT")]);
    }
} finally {
    await app.close();
    server.closeAllConnections();
    modelServer.closeAllConnections();
    await Promise.all([
        new Promise<void>((resolve) => server.close(() => resolve())),
        new Promise<void>((resolve) => modelServer.close(() => resolve())),
    ]);
    writeFileSync(
        join(realpathSync(root), "team-kernel-report.json"),
        JSON.stringify(report, null, 2),
        { mode: 0o600 },
    );
}

console.log(
    JSON.stringify({ ...report, evidence: join(realpathSync(root), "team-kernel-report.json") }),
);
