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
import {
    NATIVE_LAYERS,
    NativeConfigurationsDoc,
    NativeSetupDoc,
} from "../src/server/team-kernel.ts";
import { RotomJournal } from "../src/server/rotom-journal.ts";
import { verifyRotomKernel } from "../src/server/rotom-kernel.ts";
import { NATIVE_ENTRY } from "../src/server/entry-format.ts";
import { projectEntry } from "../src/server/projection.ts";
import { SessionsDoc } from "../src/server/docs.ts";
import type { Runtime } from "../src/server/team-accounts.ts";
import type { User } from "../src/server/config.ts";

const folder = join(realpathSync(root), "native-app");
const workspace = realpathSync(work);

mkdirSync(folder, { mode: 0o700 });
const secret = `synthetic-request-key-${randomUUID()}`;
const requestMembers: string[] = [];
/** Each member's personal AGENTS.md text, by member id; only the paying member's may reach the model. */
const personal = new Map<string, string>();
let lastBody = "";
let calls = 0,
    legacyCalls = 0,
    childRequests = 0,
    hold = false;
let subagentSearch = "";
/** Who paid for each subagent request: the gate tells the model server the member. */
const childMembers: string[] = [];
const hangingChild = Promise.withResolvers<void>();
/** The one member whose private mcp.json declares the probe server; nobody else's run may see its tool. */
let mcpOwner: string | undefined;
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
        lastBody = body;
        const input = JSON.parse(body);

        const compact = !input.tools?.length;

        const member = requestMembers.at(-1)!;

        if (!compact) {
            // The project's layer is read live from the workspace, the payer's from their private HOME.
            assert.ok(body.includes("PROJECT_LIVE_CONTEXT"));

            if (personal.has(member)) {
                assert.ok(body.includes(personal.get(member)!), `personal layer of ${member}`);
            }

            assert.ok(!body.includes("mcp__probe__") || member === mcpOwner, `MCP of ${member}`);
        }

        for (const [other, text] of personal) {
            assert.ok(other === member || !body.includes(text), `foreign personal layer ${other}`);
        }

        calls++;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const emit = (delta: unknown, finish: string | null = null) =>
            res.write(
                `data: ${JSON.stringify({ id: "app-fixture", object: "chat.completion.chunk", created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
            );

        emit({ role: "assistant" });

        if (compact) {
            emit({ content: "APP_NATIVE_COMPACT: preserved the native-app.txt outcome" });
            emit({}, "stop");
            res.end("data: [DONE]\n\n");

            return;
        }

        if (
            hold ||
            JSON.stringify(
                input.messages.findLast((message: { role: string }) => message.role === "user")
                    ?.content,
            ).includes("NATIVE_UI_HOLD")
        ) {
            emit({ content: "Waiting for cancellation" });

            return;
        }

        if (JSON.stringify(input.messages).includes("Use newly activated profile.")) {
            assert.ok(JSON.stringify(input.messages).includes("ACTIVATED_PROFILE_CONTEXT"));
            assert.ok(!JSON.stringify(input.messages).includes("UNACTIVATED_PROFILE_CONTEXT"));
            emit({ content: "APP_NATIVE_CONFIG_USED" });
            emit({}, "stop");
            res.end("data: [DONE]\n\n");

            return;
        }

        if (
            JSON.stringify(input.messages).includes("Continue the fork from its inherited summary.")
        ) {
            assert.ok(JSON.stringify(input.messages).includes("APP_NATIVE_COMPACT"));
            emit({ content: "APP_NATIVE_FORK_FINISHED" });
            emit({}, "stop");
            res.end("data: [DONE]\n\n");

            return;
        }

        if (
            JSON.stringify(
                input.messages.findLast((message: { role: string }) => message.role === "user")
                    ?.content,
            ).includes("ASK_THE_USER")
        ) {
            const asked = input.messages.find(
                (message: { role: string; tool_call_id?: string }) =>
                    message.role === "tool" && message.tool_call_id === "ask-1",
            );

            if (asked) {
                emit({ content: `ANSWER_WAS ${JSON.stringify(asked.content)}` });
                emit({}, "stop");
            } else {
                emit({
                    tool_calls: [
                        {
                            index: 0,
                            id: "ask-1",
                            type: "function",
                            function: {
                                name: "ask_user_question",
                                arguments: JSON.stringify({
                                    questions: [
                                        {
                                            question: "Which colour?",
                                            header: "Colour",
                                            options: [
                                                { label: "Blue", description: "the sea" },
                                                { label: "Green", description: "the grass" },
                                            ],
                                        },
                                    ],
                                }),
                            },
                        },
                    ],
                });
                emit({}, "tool_calls");
            }

            res.end("data: [DONE]\n\n");

            return;
        }

        const lastUser = JSON.stringify(
            input.messages.findLast((message: { role: string }) => message.role === "user")
                ?.content,
        );

        // The child's result comes back to the parent as a message that starts a new turn of the same prompt.
        if (lastUser.includes("Background task completed: **reviewer**")) {
            assert.match(lastUser, /CHILD_DONE/);
            emit({ content: "PARENT_SAW_CHILD" });
            emit({}, "stop");
            res.end("data: [DONE]\n\n");

            return;
        }

        // A child that never finishes on its own: only Stop ends it, and its request with it.
        if (lastUser.includes("SUBAGENT_CHILD_HANG")) {
            childMembers.push(member);
            hangingChild.resolve();
            await once(req.socket, "close");

            return;
        }

        if (lastUser.includes("SUBAGENT_CHILD_TASK")) {
            childRequests++;
            childMembers.push(member);
            emit({ content: "CHILD_DONE" });
            emit({}, "stop");
            res.end("data: [DONE]\n\n");

            return;
        }

        if (lastUser.includes("SPAWN_SUBAGENT") || lastUser.includes("SPAWN_HANGING")) {
            // Each spawning prompt has its own tool call ids: an earlier prompt's calls stay in the history.
            const round = lastUser.includes("SPAWN_HANGING") ? "2" : "1";
            const spawned = input.messages.find(
                (message: { role: string; tool_call_id?: string }) =>
                    message.role === "tool" && message.tool_call_id === `spawn-${round}`,
            );

            const found = input.messages.find(
                (message: { role: string; tool_call_id?: string }) =>
                    message.role === "tool" && message.tool_call_id === `search-${round}`,
            );

            if (!found) {
                emit({
                    tool_calls: [
                        {
                            index: 0,
                            id: `search-${round}`,
                            type: "function",
                            function: {
                                name: "search_tools",
                                arguments: JSON.stringify({ query: "subagent", limit: 3 }),
                            },
                        },
                    ],
                });
                emit({}, "tool_calls");
            } else if (spawned) {
                subagentSearch = JSON.stringify(found.content);
                emit({ content: "PARENT_AFTER_SUBAGENT" });
                emit({}, "stop");
            } else {
                emit({
                    tool_calls: [
                        {
                            index: 0,
                            id: `spawn-${round}`,
                            type: "function",
                            function: {
                                name: "subagent",
                                arguments: JSON.stringify({
                                    agent: "reviewer",
                                    task:
                                        round === "2"
                                            ? "SUBAGENT_CHILD_HANG: never answer"
                                            : "SUBAGENT_CHILD_TASK: reply CHILD_DONE",
                                    extensions: [],
                                }),
                            },
                        },
                    ],
                });
                emit({}, "tool_calls");
            }

            res.end("data: [DONE]\n\n");

            return;
        }

        if (
            JSON.stringify(
                input.messages.findLast((message: { role: string }) => message.role === "user")
                    ?.content,
            ).includes("STREAM_SLOWLY")
        ) {
            emit({ content: "PARTIAL_NATIVE " });
            await new Promise((resolve) => setTimeout(resolve, 1500));
            emit({ content: "STREAM_DONE" });
            emit({}, "stop");
            res.end("data: [DONE]\n\n");

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
        personal.set(user.id, `PERSONAL_LAYER_${user.name.toUpperCase()}`);
        app.kernel!.profiles.setInstructions(user.id, personal.get(user.id));
    }

    const beforeInvalidBackend = app.sessions().length;

    for (const backend of [["rotom"], ["durable"], null, {}, "unsupported"]) {
        assert.equal((await request(aliceToken, "sessions", "POST", { backend })).status, 400);
    }

    assert.equal(app.sessions().length, beforeInvalidBackend);
    assert.equal(calls, 0);
    report.invalidBackendRejectedWithoutFallback = true;

    // Simulate a process loss after the application transaction but before the native binding commit.
    const initial = app.commands.defaultModel(a);
    const frozen = app.profiles.capture(a, workspace, []);
    const planned = app.kernel!.binding(
        a,
        workspace,
        initial.model!,
        initial.thinkingLevel ?? "off",
    );
    const gap = await app.harness.createConversation(
        {
            ownership: { kind: "ownerless" },
            agent: { cwd: workspace },
            init: async (tx, id) => {
                (await tx.doc(ConfigurationDoc, id)).snapshot = frozen;
                (await tx.doc(NativeSetupDoc, id)).binding = planned;
                (await tx.doc(SessionsDoc)).items[String(id)] = {
                    cwd: workspace,
                    backend: "rotom",
                    createdBy: a.id,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                };
            },
        },
        context,
    );

    assert.equal(app.kernel!.executions.journal.hasConversation(String(gap.id)), false);
    assert.equal(
        (
            await request(aliceToken, `c/${gap.id}/submit`, "POST", {
                text: "Do not dispatch incomplete setup",
                requestId: "gap",
            })
        ).status,
        409,
    );
    assert.equal(calls, 0);
    await app.close();
    app = await open();
    handler = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} });
    assert.deepEqual(app.kernel!.executions.journal.session(String(gap.id)).binding, planned);
    assert.equal((await app.harness.snapshot(NativeSetupDoc, gap.id, context))?.bound, true);
    assert.equal(app.kernel!.executions.journal.receipts(String(gap.id)).length, 0);
    assert.equal(calls, 0);
    report.creationGapRecoveredWithoutDispatch = true;
    // Test-only loss of a proven unused binding. Once marked bound, startup must not silently recreate it.
    app.kernel!.executions.journal.reconcileOrphans(new Set());
    await app.close();
    await assert.rejects(open(), /execution journal is missing/);
    assert.equal(calls, 0);
    const repairedFixture = new RotomJournal(folder);

    repairedFixture.bind(String(gap.id), planned);
    repairedFixture.close();
    app = await open();
    handler = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} });
    report.lostInitializedJournalFailsClosed = true;

    const created = await request(aliceToken, "sessions", "POST", {
        title: "Native app proof",
        backend: "rotom",
    });

    assert.equal(created.status, 200);
    const { id } = (await created.json()) as { id: number };

    assert.equal(app.sessionMeta(id as never)?.backend, "rotom");
    writeFileSync(join(workspace, "AGENTS.md"), "PROJECT_LIVE_CONTEXT\n");
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
            await request(viewer.token, `c/${id}/submit`, "POST", {
                text: "Run",
                requestId: "viewer",
            })
        ).status,
        403,
    );
    assert.equal((await request(aliceToken, `c/${id}/compact`, "POST", {})).status, 400);
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
    // A pre-setup-document native session must use its original journal identity, not current defaults.
    await app.harness.commit(async (tx) => {
        const setup = await tx.doc(NativeSetupDoc, id as never);

        delete setup.binding;
        delete setup.bound;
    }, context);
    await app.close();
    app = await open();
    handler = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} });
    assert.equal((await app.harness.snapshot(NativeSetupDoc, id as never, context))?.bound, true);
    report.legacyNativeSetupBackfilledFromJournal = true;
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
    const admissionDriver = app.requireDriver.bind(app);

    for (const change of ["stop", "handoff"]) {
        const admissionEntered = Promise.withResolvers<void>();
        const admissionRelease = Promise.withResolvers<void>();
        let pauseAdmission = true;

        app.requireDriver = async (...args) => {
            await admissionDriver(...args);

            if (pauseAdmission && args[0] === id) {
                pauseAdmission = false;
                admissionEntered.resolve();
                await admissionRelease.promise;
            }
        };

        try {
            const stoppedAdmission = request(aliceToken, `c/${id}/submit`, "POST", {
                requestId: `${change}-admission`,
                text: "Never dispatch after admission state changes",
            });

            await admissionEntered.promise;
            assert.equal(app.kernel!.isRunning(id as never), true);

            if (change === "stop") {
                assert.equal((await request(aliceToken, `c/${id}/abort`, "POST", {})).status, 200);
            } else {
                const expectedHead = app.kernel!.executions.journal.session(String(id)).segmentId;
                const handoff = await request(aliceToken, `c/${id}/handoff`, "POST", {
                    requestId: "admission-handoff",
                    expectedHead,
                });

                assert.equal(handoff.status, 200);
                assert.equal(((await handoff.json()) as { status: string }).status, "settled");
                assert.notEqual(
                    app.kernel!.executions.journal.session(String(id)).segmentId,
                    expectedHead,
                );
            }

            admissionRelease.resolve();
            assert.equal((await stoppedAdmission).status, 409);
            assert.equal(
                app.kernel!.executions.journal.request(String(id), `${a.id}:${change}-admission`),
                undefined,
            );
            assert.equal(calls, 3);
        } finally {
            admissionRelease.resolve();
            app.requireDriver = admissionDriver;
        }
    }

    // No snapshot: the next run reads the project's AGENTS.md as it is now.
    writeFileSync(join(workspace, "AGENTS.md"), "PROJECT_LIVE_CONTEXT UPDATED_PROJECT_LAYER\n");
    const bobNow = app.config.userById(bob.user.id)!;
    const bobSession = await app.commands.createSession(bobNow, { backend: "rotom" });

    // Personal skills arrive over the API into Bob's private HOME; project skills live in the workspace.
    mkdirSync(join(workspace, ".pi", "skills", "project-proof"), { recursive: true });
    writeFileSync(
        join(workspace, ".pi", "skills", "project-proof", "SKILL.md"),
        "---\nname: project-proof\ndescription: PROJECT_SKILL_DESCRIPTION\n---\nProject skill.\n",
    );
    const skillPut = await request(bob.token, "kernel-profile/skills/bob-proof", "PUT", {
        files: {
            "SKILL.md": {
                text: "---\nname: bob-proof\ndescription: BOB_SKILL_DESCRIPTION\n---\nBob's skill.\n",
            },
            "scripts/run.sh": { base64: Buffer.from("echo bob\n").toString("base64") },
        },
    });

    assert.equal(skillPut.status, 200, await skillPut.clone().text());
    assert.deepEqual(((await skillPut.json()) as { skills: unknown[] }).skills, [
        { name: "bob-proof", description: "BOB_SKILL_DESCRIPTION", files: 2 },
    ]);

    for (const bad of [
        { "SKILL.md": { text: "---\nname: other\ndescription: x\n---\n" } },
        { "SKILL.md": { text: "---\nname: bob-bad\ndescription: x\n---\n" }, "../x": { text: "" } },
    ]) {
        assert.equal(
            (await request(bob.token, "kernel-profile/skills/bob-bad", "PUT", { files: bad }))
                .status,
            400,
        );
    }

    assert.deepEqual(
        ((await (await request(aliceToken, "kernel-profile")).json()) as { skills: unknown[] })
            .skills,
        [],
    );
    // The CLI pushes a member's local ~/.pi/agent layer with their own sign-in token.
    const localAgent = join(realpathSync(root), "carol-local-agent");

    mkdirSync(join(localAgent, "skills", "local-proof", "references"), { recursive: true });
    writeFileSync(join(localAgent, "AGENTS.md"), personal.get(bob.user.id)!);
    writeFileSync(
        join(localAgent, "skills", "local-proof", "SKILL.md"),
        "---\nname: local-proof\ndescription: LOCAL_SKILL_DESCRIPTION\n---\nLocal.\n",
    );
    writeFileSync(join(localAgent, "skills", "local-proof", "references", "a.md"), "ref\n");
    // Bob's own MCP server: a stdio command on the server, declared only in his runs.
    writeFileSync(
        join(localAgent, "mcp.json"),
        JSON.stringify({
            mcpServers: {
                probe: {
                    command: process.execPath,
                    args: [join(import.meta.dirname, "fixtures/mcp-echo.mjs")],
                    exposure: "direct",
                },
            },
        }),
    );
    mcpOwner = bob.user.id;
    mkdirSync(join(localAgent, "skills", "Bad Name"));
    writeFileSync(join(localAgent, "skills", "Bad Name", "SKILL.md"), "---\nname: x\n---\n");
    const { pushProfile } = await import("../scripts/profile-push.mjs");
    const pushed = await pushProfile({ server: base, token: bob.token, agentDir: localAgent });

    assert.equal(pushed.instructions, true);
    assert.equal(pushed.mcp, true);
    assert.equal(
        (await request(bob.token, "kernel-profile", "POST", { mcp: '{"servers":{}}' })).status,
        400,
    );
    assert.equal(
        ((await (await request(aliceToken, "kernel-profile")).json()) as { mcp: string }).mcp,
        "",
    );
    assert.deepEqual(pushed.skills, ["local-proof"]);
    assert.deepEqual(
        pushed.refused.map((each: { name: string }) => each.name),
        ["Bad Name"],
    );
    assert.deepEqual(
        ((await (await request(bob.token, "kernel-profile")).json()) as { skills: unknown[] })
            .skills,
        [
            { name: "bob-proof", description: "BOB_SKILL_DESCRIPTION", files: 2 },
            { name: "local-proof", description: "LOCAL_SKILL_DESCRIPTION", files: 2 },
        ],
    );
    hold = true;
    const inFlight = request(bob.token, `c/${bobSession.id}/submit`, "POST", {
        text: "Wait for revocation",
        requestId: "revoke",
    });

    await until(() => calls === 4, "native request began", 30000);
    assert.ok(lastBody.includes("UPDATED_PROJECT_LAYER"));
    assert.ok(lastBody.includes("PROJECT_SKILL_DESCRIPTION"));
    assert.ok(lastBody.includes("BOB_SKILL_DESCRIPTION"));
    assert.ok(lastBody.includes("LOCAL_SKILL_DESCRIPTION"));
    assert.ok(lastBody.includes("mcp__probe__echo"), "Bob's own MCP tool is declared");

    for (const operation of ["submit", "compact"]) {
        const busyKey = `busy-${operation}`;

        assert.equal(
            (
                await request(bob.token, `c/${bobSession.id}/${operation}`, "POST", {
                    requestId: busyKey,
                    ...(operation === "submit"
                        ? { text: "Must not run" }
                        : { instructions: "Must not run" }),
                })
            ).status,
            409,
        );
        assert.equal(
            app.kernel!.executions.journal.request(
                String(bobSession.id),
                `${bob.user.id}:${busyKey}`,
            ),
            undefined,
        );
    }

    assert.equal(calls, 4);
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
    personal.set(carla.user.id, "PERSONAL_LAYER_CARLA");
    app.kernel!.profiles.setInstructions(carla.user.id, personal.get(carla.user.id));
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
    const observed = app.kernel!.snapshot(id as never, owner(app));

    assert.equal(
        (
            await request(viewer.token, `c/${id}/handoff`, "POST", {
                requestId: "viewer-handoff",
                expectedHead: observed.segmentId,
            })
        ).status,
        403,
    );
    assert.equal(
        (
            await request(bob.token, `c/${id}/handoff`, "POST", {
                requestId: "borrow",
                expectedHead: observed.segmentId,
                memberId: a.id,
            })
        ).status,
        400,
    );
    assert.equal(
        (
            await request(bob.token, `c/${id}/handoff`, "POST", {
                requestId: "stale",
                expectedHead: "stale",
            })
        ).status,
        409,
    );
    const transfer = await request(bob.token, `c/${id}/handoff`, "POST", {
        requestId: "takeover",
        expectedHead: observed.segmentId,
    });

    assert.equal(transfer.status, 200, await transfer.clone().text());
    const transferred = (await transfer.json()) as { id: string; status: string };

    assert.equal(transferred.status, "settled");
    const afterTransfer = app.kernel!.snapshot(id as never, app.config.userById(bob.user.id)!);

    assert.equal(afterTransfer.memberId, bob.user.id);
    assert.equal(afterTransfer.usage.length, 3);
    assert.ok(afterTransfer.usage.every((row) => row.memberId === a.id));
    assert.equal(calls, 4);
    assert.equal(
        (
            (await (
                await request(bob.token, `c/${id}/handoff`, "POST", {
                    requestId: "takeover",
                    expectedHead: observed.segmentId,
                })
            ).json()) as { id: string }
        ).id,
        transferred.id,
    );
    assert.equal(
        (
            (await (
                await request(aliceToken, `c/${id}/submit`, "POST", {
                    requestId: "first",
                    text: "Write the proof file.",
                })
            ).json()) as { id: string }
        ).id,
        receipt.id,
    );
    assert.equal(
        (await request(aliceToken, `c/${id}/compact`, "POST", { requestId: "foreign-compact" }))
            .status,
        403,
    );
    assert.equal(
        (
            await request(bob.token, `c/${id}/compact`, "POST", {
                requestId: "bad-compact",
                instructions: null,
            })
        ).status,
        400,
    );
    const settingsFile = join(folder, "kernel-homes", bob.user.id, ".pi/agent/settings.json");
    const settings = JSON.parse(readFileSync(settingsFile, "utf8"));

    settings.compaction = { enabled: false, keepRecentTokens: 1, reserveTokens: 1024 };
    writeFileSync(settingsFile, JSON.stringify(settings), { mode: 0o600 });
    const compactResponse = await request(bob.token, `c/${id}/compact`, "POST", {
        requestId: "compact",
    });

    assert.equal(compactResponse.status, 200);
    const compactReceipt = (await compactResponse.json()) as { id: string; status: string };

    assert.equal(compactReceipt.status, "settled", JSON.stringify(compactReceipt));
    const afterCompact = app.kernel!.snapshot(id as never, app.config.userById(bob.user.id)!);

    assert.equal(afterCompact.usage.length, 4);
    assert.equal(afterCompact.usage.at(-1)?.memberId, bob.user.id);
    // This history needs both the history summary and a split-turn prefix summary.
    assert.equal(calls, 6);
    assert.deepEqual(requestMembers.slice(-2), [bob.user.id, bob.user.id]);
    assert.equal(
        (
            (await (
                await request(bob.token, `c/${id}/compact`, "POST", { requestId: "compact" })
            ).json()) as { id: string }
        ).id,
        compactReceipt.id,
    );
    assert.equal(calls, 6);
    assert.equal(
        (
            await request(bob.token, `c/${id}/compact`, "POST", {
                requestId: "compact",
                instructions: "different",
            })
        ).status,
        409,
    );
    assert.equal(
        (
            await request(bob.token, `c/${id}/handoff`, "POST", {
                requestId: "takeover",
                expectedHead: afterTransfer.segmentId,
            })
        ).status,
        409,
    );
    assert.equal(calls, 6);
    report.apiHandoffAndCompaction = true;
    report.handoffHistoricalUsagePreserved = true;

    const originalFile = app.kernel!.executions.journal.session(String(id)).sessionFile!;
    const originalBytes = readFileSync(originalFile);
    const countBeforeFork = app.sessions().length;
    const forkBody = { requestId: "fork-once", expectedHead: afterCompact.segmentId };
    const forkResponses = await Promise.all([
        request(aliceToken, `c/${id}/fork`, "POST", forkBody),
        request(aliceToken, `c/${id}/fork`, "POST", forkBody),
    ]);

    for (const response of forkResponses) {
        assert.equal(response.status, 200, await response.clone().text());
    }

    const forked = (await forkResponses[0]!.json()) as {
        id: number;
        receipt: { id: string; status: string };
    };

    assert.deepEqual(await forkResponses[1]!.json(), forked);
    assert.equal(forked.receipt.status, "settled");

    const assertForkIdentity = async (requestId: string) => {
        for (const operation of ["submit", "compact", "handoff", "configuration"]) {
            const body =
                operation === "submit"
                    ? { requestId, text: "Must not run" }
                    : operation === "compact"
                      ? { requestId, instructions: "Must not run" }
                      : operation === "configuration"
                        ? { requestId, activate: "mine", expectedHead: afterCompact.segmentId }
                        : { requestId, expectedHead: afterCompact.segmentId };

            assert.equal(
                (await request(aliceToken, `c/${id}/${operation}`, "POST", body)).status,
                409,
                `${operation} must not reuse ${requestId}`,
            );
            assert.equal(
                (
                    await request(
                        aliceToken,
                        `c/${id}/kernel-request?operation=${operation}&requestId=${requestId}`,
                    )
                ).status,
                409,
            );
        }

        assert.equal(
            app.kernel!.executions.journal.request(String(id), `${a.id}:${requestId}`),
            undefined,
        );
    };

    await assertForkIdentity("fork-once");
    assert.equal(
        (
            await request(aliceToken, `c/${id}/fork`, "POST", {
                requestId: "first",
                expectedHead: afterCompact.segmentId,
            })
        ).status,
        409,
    );
    assert.equal(
        (await request(aliceToken, `c/${id}/kernel-request?operation=fork&requestId=first`)).status,
        409,
    );
    assert.deepEqual(
        await (
            await request(aliceToken, `c/${id}/kernel-request?operation=fork&requestId=fork-once`)
        ).json(),
        { targetId: forked.id, receipt: forked.receipt },
    );
    assert.deepEqual(
        await (
            await request(bob.token, `c/${id}/kernel-request?operation=fork&requestId=fork-once`)
        ).json(),
        { targetId: null, receipt: null },
    );
    assert.equal(
        (await request(aliceToken, `c/${id}/kernel-request?operation=compact&requestId=first`))
            .status,
        409,
    );
    assert.equal(app.sessions().length, countBeforeFork + 1);
    const forkSnapshot = app.kernel!.snapshot(forked.id as never, owner(app));

    assert.equal(forkSnapshot.initializing, false);
    assert.equal(forkSnapshot.memberId, a.id);
    assert.equal(forkSnapshot.usage.length, 0);
    assert.deepEqual(app.profiles.snapshot(forked.id as never), app.profiles.snapshot(id as never));
    assert.equal(
        app.sessionMeta(forked.id as never)?.projectId,
        app.sessionMeta(id as never)?.projectId,
    );
    assert.notEqual(
        app.kernel!.executions.journal.session(String(forked.id)).sessionFile,
        originalFile,
    );
    assert.equal(calls, 6);
    assert.equal(
        (
            await request(aliceToken, `c/${id}/fork`, "POST", {
                ...forkBody,
                expectedHead: "changed",
            })
        ).status,
        409,
    );
    assert.equal(
        (await request(aliceToken, `c/${id}/fork`, "POST", { ...forkBody, memberId: bob.user.id }))
            .status,
        400,
    );
    await app.close();
    app = await open();
    handler = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} });
    assert.deepEqual(
        await (await request(aliceToken, `c/${id}/fork`, "POST", forkBody)).json(),
        forked,
    );
    const forkReply = await request(aliceToken, `c/${forked.id}/submit`, "POST", {
        requestId: "fork-followup",
        text: "Continue the fork from its inherited summary.",
    });

    assert.equal(forkReply.status, 200);
    const forkReceipt = (await forkReply.json()) as { status: string };

    assert.equal(forkReceipt.status, "settled", JSON.stringify(forkReceipt));
    assert.equal(calls, 7);
    assert.deepEqual(
        app.kernel!.snapshot(forked.id as never, owner(app)).usage.map((row) => row.memberId),
        [a.id],
    );
    assert.deepEqual(readFileSync(originalFile), originalBytes);
    report.apiForkIdempotencyConfigurationAndPayer = true;

    // Fork permission alone permits a public-history clone, never a paid continuation.
    project = app.projects.save(
        owner(app),
        { ...project, members: { [carla.user.id]: { view: true, continue: false, fork: true } } },
        (key) => !!app.config.userById(key),
    );
    await app.projectsChanged();
    const carlaHead = app.kernel!.snapshot(
        scoped.id,
        app.config.userById(carla.user.id)!,
    ).segmentId;
    const sameMemberFork = await request(carla.token, `c/${scoped.id}/fork`, "POST", {
        requestId: "fork-only",
        expectedHead: carlaHead,
    });

    assert.equal(sameMemberFork.status, 200, await sameMemberFork.clone().text());
    const sameFork = (await sameMemberFork.json()) as { id: number; receipt: { status: string } };

    assert.equal(sameFork.receipt.status, "settled");
    assert.equal(
        (
            await request(carla.token, `c/${sameFork.id}/submit`, "POST", {
                requestId: "denied-continue",
                text: "Not authorized",
            })
        ).status,
        403,
    );
    project = app.projects.save(
        owner(app),
        { ...project, members: { [carla.user.id]: { view: true, continue: true, fork: false } } },
        (key) => !!app.config.userById(key),
    );
    await app.projectsChanged();
    const beforeDeniedFork = app.sessions().length;

    assert.equal(
        (
            await request(carla.token, `c/${scoped.id}/fork`, "POST", {
                requestId: "denied-fork",
                expectedHead: carlaHead,
            })
        ).status,
        403,
    );
    assert.equal(app.sessions().length, beforeDeniedFork);
    assert.equal(calls, 7);
    report.forkAndContinuePermissionsIndependent = true;

    const beforeConfig = app.kernel!.executions.journal.session(String(forked.id));
    const configSourceBytes = readFileSync(beforeConfig.sessionFile!);

    // A rotom session starts layered: nothing is frozen until a member explicitly activates a snapshot.
    assert.equal(app.configuration(forked.id as never), undefined);
    assert.equal(
        app.kernel!.executions.journal.session(String(forked.id)).binding.configurationDigest,
        NATIVE_LAYERS,
    );
    const activateBody = {
        activate: "mine",
        requestId: "activate-once",
        expectedHead: beforeConfig.segmentId,
    };

    assert.equal(
        (await request(bob.token, `c/${forked.id}/configuration`, "POST", activateBody)).status,
        403,
    );
    assert.equal(
        (
            await request(aliceToken, `c/${forked.id}/configuration`, "POST", {
                ...activateBody,
                activate: "other",
            })
        ).status,
        400,
    );
    const activationSkill = join(workspace, "activation-skill");

    mkdirSync(activationSkill);
    writeFileSync(
        join(activationSkill, "SKILL.md"),
        "---\nname: activation-skill\ndescription: Verify immutable native configuration snapshots.\n---\nUse this skill only when requested.\n",
    );
    app.profiles.save(owner(app), {
        name: "Activated",
        instructions: `${personal.get(a.id)}\nACTIVATED_PROFILE_CONTEXT`,
        skillDirectories: [activationSkill],
    });
    const requireDriver = app.requireDriver.bind(app);
    let release!: () => void, arrived!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const arrival = new Promise<void>((resolve) => {
        arrived = resolve;
    });
    let blockAdmission = true;

    app.requireDriver = async (...args) => {
        if (blockAdmission) {
            blockAdmission = false;
            arrived();
            await gate;
        }

        return requireDriver(...args);
    };

    let activatedResponse: Response;

    try {
        const activating = request(
            aliceToken,
            `c/${forked.id}/configuration`,
            "POST",
            activateBody,
        );

        await arrival;
        const collision = await request(aliceToken, `c/${forked.id}/submit`, "POST", {
            requestId: activateBody.requestId,
            text: "Must never be dispatched.",
        });

        assert.equal(collision.status, 409);
        assert.equal(
            app.kernel!.executions.journal.request(
                String(forked.id),
                `${a.id}:${activateBody.requestId}`,
            ),
            undefined,
        );
        release();
        activatedResponse = await activating;
    } finally {
        release();
        app.requireDriver = requireDriver;
    }

    report.concurrentConfigurationIdentityProtected = true;

    assert.equal(activatedResponse.status, 200, await activatedResponse.clone().text());
    const activated = (await activatedResponse.json()) as {
        receipt: { id: string; status: string; operation: string };
    };

    assert.equal(activated.receipt.status, "settled");
    assert.equal(activated.receipt.operation, "configuration");
    const activeConfiguration = app.configuration(forked.id as never)!;

    assert.notEqual(activeConfiguration.digest, NATIVE_LAYERS);
    assert.equal(app.profiles.snapshot(forked.id as never), undefined);
    assert.deepEqual(readFileSync(beforeConfig.sessionFile!), configSourceBytes);
    assert.deepEqual(
        app.kernel!.executions.journal.segment(beforeConfig.segmentId).binding,
        beforeConfig.binding,
    );
    assert.equal(app.kernel!.snapshot(forked.id as never, owner(app)).usage.length, 1);
    assert.equal(calls, 7);
    assert.deepEqual(activeConfiguration.skills.map((skill) => skill.name).sort(), [
        "activation-skill",
        "project-proof",
    ]);
    const sameContentBody = {
        activate: "mine",
        requestId: "same-content-gap",
        expectedHead: app.kernel!.snapshot(forked.id as never, owner(app)).segmentId,
    };
    const handoff = app.kernel!.executions.handoff.bind(app.kernel!.executions);

    let seedReached!: () => void, releaseSeed!: () => void;
    const seedArrival = new Promise<void>((resolve) => {
        seedReached = resolve;
    });
    const seedGate = new Promise<void>((resolve) => {
        releaseSeed = resolve;
    });

    app.kernel!.executions.handoff = async () => {
        seedReached();
        await seedGate;

        throw new Error("Fixture: stop after configuration staging, before journal intent");
    };

    try {
        const staging = request(
            aliceToken,
            `c/${forked.id}/configuration`,
            "POST",
            sameContentBody,
        );

        await seedArrival;
        assert.deepEqual(
            await (
                await request(
                    aliceToken,
                    `c/${forked.id}/kernel-request?operation=configuration&requestId=same-content-gap`,
                )
            ).json(),
            { targetId: forked.id, receipt: null },
        );
        releaseSeed();
        assert.equal((await staging).status, 500);
        assert.deepEqual(
            await (
                await request(
                    aliceToken,
                    `c/${forked.id}/kernel-request?operation=configuration&requestId=same-content-gap`,
                )
            ).json(),
            { targetId: forked.id, receipt: null, preparedOnly: true },
        );
        assert.deepEqual(app.configuration(forked.id as never), activeConfiguration);
    } finally {
        releaseSeed();
        app.kernel!.executions.handoff = handoff;
    }

    app.profiles.save(owner(app), {
        name: "Not activated",
        instructions: `${personal.get(a.id)}\nUNACTIVATED_PROFILE_CONTEXT`,
        skillDirectories: [],
    });
    await app.close();
    app = await open();
    handler = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} });
    assert.deepEqual(app.configuration(forked.id as never), activeConfiguration);
    assert.deepEqual(
        await (
            await request(aliceToken, `c/${forked.id}/configuration`, "POST", sameContentBody)
        ).json(),
        { receipt: null },
    );
    assert.deepEqual(app.configuration(forked.id as never), activeConfiguration);
    report.sameDigestStagingPreservesSnapshotIdentity = true;
    assert.deepEqual(
        await (
            await request(aliceToken, `c/${forked.id}/configuration`, "POST", activateBody)
        ).json(),
        activated,
    );
    assert.equal(
        (
            await request(aliceToken, `c/${forked.id}/configuration`, "POST", {
                ...activateBody,
                expectedHead: "changed",
            })
        ).status,
        409,
    );
    assert.deepEqual(
        await (
            await request(
                aliceToken,
                `c/${forked.id}/kernel-request?operation=configuration&requestId=activate-once`,
            )
        ).json(),
        { targetId: forked.id, receipt: activated.receipt },
    );
    const configReply = await request(aliceToken, `c/${forked.id}/submit`, "POST", {
        requestId: "config-use",
        text: "Use newly activated profile.",
    });

    assert.equal(configReply.status, 200);
    assert.equal(((await configReply.json()) as { status: string }).status, "settled");
    assert.equal(calls, 8);
    const activeHead = app.kernel!.snapshot(forked.id as never, owner(app)).segmentId;
    const configForkResponse = await request(aliceToken, `c/${forked.id}/fork`, "POST", {
        requestId: "config-fork",
        expectedHead: activeHead,
    });

    assert.equal(configForkResponse.status, 200, await configForkResponse.clone().text());
    const configFork = (await configForkResponse.json()) as { id: number };

    // A fork runs on the forker's own layers; it never inherits the source's frozen personal snapshot.
    assert.equal(app.configuration(configFork.id as never), undefined);
    assert.equal(
        app.kernel!.executions.journal.session(String(configFork.id)).binding.configurationDigest,
        NATIVE_LAYERS,
    );
    const staged = app.profiles.capture(owner(app), workspace, []);

    await app.harness.commit(async (tx) => {
        const configurations = await tx.doc(NativeConfigurationsDoc, forked.id as never);

        configurations.snapshots[staged.digest] = staged;
        configurations.requests[`${a.id}:config-gap`] = {
            expectedHead: activeHead,
            binding: {
                ...app.kernel!.executions.journal.session(String(forked.id)).binding,
                configurationDigest: staged.digest,
            },
        };
    }, context);
    report.nativeConfigurationActivationAndFork = true;

    // App creation is committed, but no seed intent exists: a restart must not silently execute the seed.
    const forkGap = await app.commands.createSession(
        owner(app),
        { backend: "rotom", cwd: workspace },
        {
            sourceId: id as never,
            expectedHead: afterCompact.segmentId,
            requestId: `${a.id}:fork-gap`,
        },
    );

    assert.equal(app.kernel!.snapshot(forkGap.id, owner(app)).initializing, true);
    assert.equal(
        (
            await request(aliceToken, `c/${forkGap.id}/submit`, "POST", {
                requestId: "no-empty-fork",
                text: "Not until seeded",
            })
        ).status,
        409,
    );
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
    assert.equal(app.kernel!.snapshot(forkGap.id, owner(app)).initializing, true);
    assert.deepEqual(
        await (
            await request(aliceToken, `c/${id}/fork`, "POST", {
                requestId: "fork-gap",
                expectedHead: afterCompact.segmentId,
            })
        ).json(),
        { id: Number(forkGap.id), receipt: null },
    );
    assert.equal(app.kernel!.executions.journal.receipts(String(forkGap.id)).length, 0);
    const unknownHead = app.kernel!.snapshot(bobSession.id, owner(app)).segmentId;
    const beforeUnknownFork = app.sessions().length;

    assert.equal(
        (
            await request(aliceToken, `c/${bobSession.id}/fork`, "POST", {
                requestId: "unknown-source",
                expectedHead: unknownHead,
            })
        ).status,
        409,
    );
    assert.equal(app.sessions().length, beforeUnknownFork);
    report.forkGapAndUnknownSourceNotReplayed = true;
    assert.equal(app.configuration(forked.id as never)!.digest, activeConfiguration.digest);
    await assertForkIdentity("fork-once");
    await assertForkIdentity("fork-gap");
    assert.deepEqual(
        await (
            await request(aliceToken, `c/${forked.id}/configuration`, "POST", {
                activate: "mine",
                requestId: "config-gap",
                expectedHead: activeHead,
            })
        ).json(),
        { receipt: null },
    );
    assert.equal(
        app.kernel!.executions.journal.request(String(forked.id), `${a.id}:config-gap`),
        undefined,
    );
    report.configurationGapNotReplayed = true;
    assert.deepEqual(
        await (
            await request(aliceToken, `c/${id}/kernel-request?operation=fork&requestId=fork-gap`)
        ).json(),
        { targetId: Number(forkGap.id), receipt: null, preparedOnly: true },
    );
    assert.equal(
        (
            (await (
                await request(
                    bob.token,
                    `c/${bobSession.id}/kernel-request?operation=submit&requestId=intent-only`,
                )
            ).json()) as { receipt: { status: string } }
        ).receipt.status,
        "unknown",
    );
    const unknownReadback = (await (
        await request(
            bob.token,
            `c/${bobSession.id}/kernel-request?operation=submit&requestId=intent-only`,
        )
    ).json()) as { preparedOnly?: boolean };

    assert.equal(unknownReadback.preparedOnly, undefined);
    assert.deepEqual(
        await (
            await request(
                aliceToken,
                `c/${forked.id}/kernel-request?operation=configuration&requestId=config-gap`,
            )
        ).json(),
        { targetId: forked.id, receipt: null, preparedOnly: true },
    );
    report.preparedOnlyReadbackExcludesLiveAndUnknown = true;
    report.readOnlyExactReceiptLookup = true;
    await assert.rejects(
        app.execution.admit(legacy.id, app.config.userById(bob.user.id)!),
        /active or unknown/,
    );
    assert.equal(calls, 8);
    assert.equal(legacyCalls, 0);

    // Whoever sends pays: a member's submit takes over with their own account, carrying public history only.
    const shared2 = (await (
        await request(aliceToken, "sessions", "POST", { title: "Auto takeover", backend: "rotom" })
    ).json()) as { id: number };
    const aliceRun = (await (
        await request(aliceToken, `c/${shared2.id}/submit`, "POST", {
            text: "Write the proof file.",
            requestId: "alice-run",
        })
    ).json()) as { status: string };

    assert.equal(aliceRun.status, "settled");
    const beforeTakeover = app.kernel!.snapshot(shared2.id as never, owner(app));
    const dana = app.config.addUser("Dana", "guest");

    await app.hello(dana.user);
    project = app.projects.save(
        owner(app),
        {
            ...project,
            members: {
                ...project.members,
                [dana.user.id]: { view: true, continue: true, fork: true },
            },
        },
        (key) => !!app.config.userById(key),
    );
    await app.projectsChanged();
    const danaRun = await request(dana.token, `c/${shared2.id}/submit`, "POST", {
        text: "Write the proof file.",
        requestId: "bob-run",
    });

    assert.equal(danaRun.status, 200, await danaRun.clone().text());
    assert.equal(((await danaRun.json()) as { status: string }).status, "settled");
    const afterTakeover = app.kernel!.snapshot(shared2.id as never, owner(app));

    assert.equal(afterTakeover.memberId, dana.user.id);
    assert.notEqual(afterTakeover.segmentId, beforeTakeover.segmentId);
    assert.deepEqual(
        afterTakeover.usage.map((row) => row.memberId),
        [a.id, a.id, dana.user.id, dana.user.id],
    );
    assert.deepEqual(requestMembers.slice(-2), [dana.user.id, dana.user.id]);
    assert.equal(calls, 12);
    report.submitTakesOverWithSendersAccount = true;

    // A kernel pin upgrade starts a new segment recording the new version instead of rejecting old sessions.
    const oldPin = { ...planned, kernelVersion: "0.0.0-previous-pin" };
    const upgraded = await app.harness.createConversation(
        {
            ownership: { kind: "ownerless" },
            agent: { cwd: workspace },
            init: async (tx, id) => {
                (await tx.doc(ConfigurationDoc, id)).snapshot = frozen;
                (await tx.doc(NativeSetupDoc, id)).binding = oldPin;
                (await tx.doc(SessionsDoc)).items[String(id)] = {
                    cwd: workspace,
                    backend: "rotom",
                    createdBy: a.id,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                };
            },
        },
        context,
    );

    await app.kernel!.ensureBound(upgraded.id);
    const upgradeRun = await request(aliceToken, `c/${upgraded.id}/submit`, "POST", {
        text: "Write the proof file.",
        requestId: "after-upgrade",
    });

    assert.equal(upgradeRun.status, 200, await upgradeRun.clone().text());
    assert.equal(((await upgradeRun.json()) as { status: string }).status, "settled");
    assert.equal(
        app.kernel!.executions.journal.session(String(upgraded.id)).binding.kernelVersion,
        verifyRotomKernel().version,
    );
    assert.equal(calls, 14);
    report.kernelUpgradeStartsNewSegment = true;

    // One transcript: the run answers at reservation, streams into the room live, and lands as mirrored entries.
    const streamed = await request(aliceToken, `c/${shared2.id}/submit`, "POST", {
        text: "STREAM_SLOWLY please",
        requestId: "stream",
        wait: false,
    });

    assert.equal(streamed.status, 200, await streamed.clone().text());
    const streamReceipt = (await streamed.json()) as { id: string; status: string };

    assert.equal(streamReceipt.status, "dispatch-intent");
    let partial: unknown;

    for (let tries = 0; tries < 2400 && partial === undefined; tries++) {
        const live = app.kernel!.clientLive(shared2.id as never);

        if (live.busy && JSON.stringify(live.generation ?? {}).includes("PARTIAL_NATIVE")) {
            partial = live;
        }

        await new Promise((resolve) => setTimeout(resolve, 25));
    }

    assert.ok(partial, "the in-flight answer shows live before it is persisted");

    while (app.kernel!.isRunning(shared2.id as never)) {
        await new Promise((resolve) => setTimeout(resolve, 25));
    }

    assert.equal(app.kernel!.clientLive(shared2.id as never).busy, false);
    assert.equal(
        app.kernel!.executions.journal.request(String(shared2.id), `${a.id}:stream`)?.status,
        "settled",
    );
    const room = await app.room(shared2.id as never);
    const mirrored = room.value!.entries.filter((entry) => entry.kind === NATIVE_ENTRY);

    assert.equal(
        mirrored.length,
        app.kernel!.executions.journal.entries(String(shared2.id)).length,
    );
    const shown = mirrored.map((entry) => projectEntry(entry)).filter((entry) => entry);
    const users = shown.filter((entry) => entry!.kind === "user") as { id: number; text: string }[];

    assert.deepEqual(
        users.map((entry) => entry.text),
        ["Write the proof file.", "Write the proof file.", "STREAM_SLOWLY please"],
    );
    assert.deepEqual(
        users.map((entry) => room.authors[String(entry.id)]),
        [a.id, dana.user.id, a.id],
    );
    assert.ok(shown.some((entry) => entry!.kind === "toolResult"));
    assert.ok(
        JSON.stringify(shown.at(-1)).includes("PARTIAL_NATIVE STREAM_DONE"),
        JSON.stringify(shown.at(-1)),
    );
    assert.equal(calls, 15);
    report.unifiedTranscriptLiveAndMirrored = true;

    // An extension's question reaches the paying member, and only their answer goes back to the run.
    const asking = await request(aliceToken, `c/${shared2.id}/submit`, "POST", {
        text: "ASK_THE_USER which colour",
        requestId: "ask",
        wait: false,
    });

    assert.equal(asking.status, 200, await asking.clone().text());
    const dialogsOf = () =>
        (app.kernel!.roomState(shared2.id as never, a) as { dialogs?: unknown[] }).dialogs ?? [];
    let dialog: { id: string; method: string; title: string; options: string[] } | undefined;

    for (let tries = 0; tries < 2400 && !dialog; tries++) {
        dialog = dialogsOf()[0] as typeof dialog;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }

    assert.ok(dialog, "the question is waiting in the room");
    assert.equal(dialog.method, "select");
    assert.match(dialog.title, /Which colour\?/);
    const green = dialog.options.find((option) => option.includes("Green"))!;
    const answer = (token: string, body: object) =>
        request(token, `c/${shared2.id}/dialog`, "POST", { id: dialog!.id, ...body });

    assert.equal((await answer(dana.token, { value: green })).status, 403);
    assert.equal((await answer(aliceToken, { value: "Purple" })).status, 400);
    assert.equal((await answer(aliceToken, { value: green })).status, 200);
    assert.equal((await answer(aliceToken, { value: green })).status, 409);

    while (app.kernel!.isRunning(shared2.id as never)) {
        await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const answered = (await app.room(shared2.id as never))
        .value!.entries.filter((entry) => entry.kind === NATIVE_ENTRY)
        .map((entry) => JSON.stringify(projectEntry(entry)));

    assert.ok(answered.at(-1)!.includes("ANSWER_WAS") && answered.at(-1)!.includes("Green"));
    assert.equal(dialogsOf().length, 0);
    assert.equal(calls, 17);
    report.extensionDialogsReachThePayer = true;

    // A message sent while Pi works joins that run, for the member who pays for it only.
    assert.equal(
        (
            await request(aliceToken, `c/${shared2.id}/submit`, "POST", {
                text: "STREAM_SLOWLY then a follow-up",
                requestId: "queue-host",
                wait: false,
            })
        ).status,
        200,
    );

    for (let tries = 0; tries < 2400; tries++) {
        if (
            JSON.stringify(app.kernel!.clientLive(shared2.id as never)).includes("PARTIAL_NATIVE")
        ) {
            break;
        }

        await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const queued = (token: string) =>
        request(token, `c/${shared2.id}/submit`, "POST", {
            text: "FOLLOW_UP_NOTE",
            requestId: "queued",
            mode: "followUp",
        });

    assert.equal((await queued(dana.token)).status, 409);
    const accepted = await queued(aliceToken);

    assert.equal(accepted.status, 200, await accepted.clone().text());
    assert.deepEqual(await accepted.json(), { queued: "followUp" });

    while (app.kernel!.isRunning(shared2.id as never)) {
        await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const queuedRoom = await app.room(shared2.id as never);
    const queuedUsers = queuedRoom
        .value!.entries.filter((entry) => entry.kind === NATIVE_ENTRY)
        .map((entry) => projectEntry(entry))
        .filter((entry) => entry?.kind === "user") as { id: number; text: string }[];

    assert.deepEqual(
        queuedUsers.slice(-2).map((entry) => [entry.text, queuedRoom.authors[String(entry.id)]]),
        [
            ["STREAM_SLOWLY then a follow-up", a.id],
            ["FOLLOW_UP_NOTE", a.id],
        ],
    );
    assert.equal(
        app.kernel!.executions.journal.request(String(shared2.id), `${a.id}:queue-host`)?.status,
        "settled",
    );
    // The host answer, then the follow-up's own write-and-finish turn.
    assert.equal(calls, 20);
    report.messagesJoinTheRunningPrompt = true;

    // A subagent is a separate rotom process in the member HOME, which holds no credential. It starts through the team
    // wrapper, so its requests pass the run's own gate: same payer, same model, only while the run is active. The run
    // stays active, and the session busy, until the child's result is back and the parent's turn on it has settled.
    const spawn = await request(aliceToken, `c/${shared2.id}/submit`, "POST", {
        text: "SPAWN_SUBAGENT now",
        requestId: "spawn-subagent",
    });

    assert.equal(spawn.status, 200, await spawn.clone().text());
    assert.equal(((await spawn.json()) as { status: string }).status, "settled");
    assert.equal(
        subagentSearch,
        JSON.stringify("Loaded specialized tools: subagent, subagent_wait"),
    );
    assert.equal(childRequests, 1, "the child reached the model once");
    const subagentRuns = join(
        folder,
        "kernel-homes",
        a.id,
        ".local/state/rotom/subagent-store/owned-process-groups-v2/async-subagent-runs",
    );

    assert.deepEqual(childMembers, [a.id], "the child spends the member who sent the prompt");
    const subagentTurn = app
        .kernel!.executions.journal.segmentEntries(
            app.kernel!.executions.journal.session(String(shared2.id)).segmentId,
        )
        .map((entry) => JSON.stringify(entry));

    assert.ok(subagentTurn.some((entry) => entry.includes("PARENT_AFTER_SUBAGENT")));
    assert.ok(
        subagentTurn.findIndex((entry) => entry.includes("PARENT_SAW_CHILD")) >
            subagentTurn.findIndex((entry) => entry.includes("PARENT_AFTER_SUBAGENT")),
        "the parent's turn on the child's result is part of the same run",
    );
    assert.equal(
        readFileSync(join(folder, "kernel-homes", a.id, ".pi/agent/auth.json"), "utf8").trim(),
        "{}",
        "no grant appears in the member HOME",
    );
    const childUsage = app
        .kernel!.executions.journal.usage(String(shared2.id))
        .filter((each) => each.subagent);

    assert.deepEqual(
        childUsage.map((each) => each.memberId),
        [a.id],
        "the child's response is charged to the same member",
    );
    report.subagentsThroughTheGate = true;

    // Stop ends a run that waits for its children, and stops them: the hanging child's request is cut, and the session
    // takes the next prompt.
    const hanging = request(aliceToken, `c/${shared2.id}/submit`, "POST", {
        text: "SPAWN_HANGING subagent",
        requestId: "spawn-hanging",
    });

    await hangingChild.promise;
    assert.equal(app.kernel!.isRunning(shared2.id as never), true, "the run waits for its child");
    await until(
        () =>
            (app.kernel!.roomState(shared2.id as never, a) as { subagents?: number }).subagents ===
            1,
        "the room shows the run waiting for its child",
        10000,
    );
    assert.equal((await request(aliceToken, `c/${shared2.id}/abort`, "POST", {})).status, 200);
    const stoppedRun = await hanging;

    assert.equal(stoppedRun.status, 200, await stoppedRun.clone().text());
    assert.equal(((await stoppedRun.json()) as { status: string }).status, "settled");
    assert.deepEqual(childMembers, [a.id, a.id]);
    const childStates = () =>
        readdirSync(subagentRuns, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
            .map(
                (entry) =>
                    JSON.parse(readFileSync(join(subagentRuns, entry.name, "status.json"), "utf8"))
                        .state as string,
            )
            .sort();

    await until(() => !childStates().includes("running"), "the stopped child ended", 30000);
    assert.deepEqual(childStates(), ["complete", "stopped"]);
    report.stopEndsSubagents = true;

    // A server restart cuts a prompt off; the next start continues it once, as its member, without a person.
    const journalOf = () => app.kernel!.executions.journal;

    const reopen = async () => {
        await app.close();
        app = await open();
        handler = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} });
    };

    const startCutOff = async (requestId: string) => {
        const started = await request(aliceToken, `c/${shared2.id}/submit`, "POST", {
            text: `STREAM_SLOWLY until ${requestId}`,
            requestId,
            wait: false,
        });

        assert.equal(started.status, 200, await started.clone().text());

        for (let tries = 0; tries < 2400; tries++) {
            if (JSON.stringify(app.kernel!.clientLive(shared2.id as never)).includes("PARTIAL")) {
                break;
            }

            await new Promise((resolve) => setTimeout(resolve, 25));
        }

        return ((await started.json()) as { id: string }).id;
    };

    const continued = async (attemptId: string) => {
        const key = `${a.id}:#resume-${attemptId}`;

        for (let tries = 0; tries < 2400; tries++) {
            if (journalOf().request(String(shared2.id), key)?.status === "settled") {
                break;
            }

            await new Promise((resolve) => setTimeout(resolve, 25));
        }

        assert.equal(journalOf().request(String(shared2.id), key)?.status, "settled");
        assert.equal(journalOf().resume(attemptId)?.state, "started");

        while (app.kernel!.isRunning(shared2.id as never)) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }

        const room = await app.room(shared2.id as never);
        const users = room
            .value!.entries.filter((entry) => entry.kind === NATIVE_ENTRY)
            .map((entry) => projectEntry(entry))
            .filter((entry) => entry?.kind === "user") as { from?: string; text: string }[];

        assert.equal(users.at(-1)!.from, "server");
        assert.match(users.at(-1)!.text, /server restarted/);
        assert.equal(requestMembers.at(-1), a.id);
        assert.equal(
            (app.kernel!.roomState(shared2.id as never, a) as { cutOff?: boolean }).cutOff,
            undefined,
        );
    };

    const cleanHost = await startCutOff("restart-host");
    const beforeRestart = calls;

    await reopen();
    await continued(cleanHost);
    assert.equal(journalOf().receipt(cleanHost).status, "settled");
    assert.equal(journalOf().resume(cleanHost)?.chain, 1);
    assert.ok(calls > beforeRestart, "the continuation asked the model again");
    // A second start finds the continuation already made; it sends nothing more.
    const afterContinue = calls;

    await reopen();
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(calls, afterContinue);
    report.cleanRestartContinues = true;

    // A crash: the kernel dies without a word. Its run is unknown until a start proves the process gone.
    const crashHost = await startCutOff("crash-host");
    const { DatabaseSync } = await import("node:sqlite");
    const reader = new DatabaseSync(join(folder, "kernel.sqlite"), { readOnly: true });
    const { pid } = reader.prepare("SELECT pid FROM kernel_attempts WHERE id=?").get(crashHost) as {
        pid: number;
    };

    reader.close();
    process.kill(pid, "SIGKILL");

    while (app.kernel!.isRunning(shared2.id as never)) {
        await new Promise((resolve) => setTimeout(resolve, 25));
    }

    assert.equal(journalOf().receipt(crashHost).status, "unknown");
    assert.equal(
        (app.kernel!.roomState(shared2.id as never, a) as { pending?: { status: string } }).pending
            ?.status,
        "unknown",
    );
    await reopen();
    await continued(crashHost);
    assert.equal(journalOf().receipt(crashHost).status, "interrupted");
    report.crashedKernelInterruptedAndContinued = true;
    Object.assign(report, {
        status: "passed",
        projectViewAndContinue: true,
        accountGenerationChecked: true,
        budgetNotBypassed: true,
        slashAndLongRequestRejectedBeforeIntent: true,
        disablingCannotBypassUnknownFence: true,
        apiCreateSubmitReadAbort: true,
        roleRevocation: true,
        layeredContext: true,
        fixedPayer: true,
        restartIdempotency: true,
        nativeHistoryResume: true,
        noDurableFallback: true,
        privateRequestAuthNotPersisted: true,
        loopbackRequests: calls,
    });

    if (process.argv.includes("--serve") || process.argv.includes("--ui")) {
        // Exercise real native compaction on a small UI fixture, without changing product defaults.
        const uiSettingsPath = join(
            app.kernel!.executions.journal.session(String(forked.id)).binding.home,
            ".pi",
            "agent",
            "settings.json",
        );
        const uiSettings = JSON.parse(readFileSync(uiSettingsPath, "utf8"));

        uiSettings.compaction = { enabled: false, keepRecentTokens: 1, reserveTokens: 1024 };
        writeFileSync(uiSettingsPath, JSON.stringify(uiSettings), { mode: 0o600 });
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

        if (process.argv.includes("--ui")) {
            const { nativeUiProof } = await import("./kernel-ui-proof.ts");

            report.nativeUi = await nativeUiProof({
                root: realpathSync(root),
                base: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
                id: Number(id),
                memberName: owner(app).name,
            });
            // The composer's one message, sent by the owner who pays for it; nothing else dispatched. The subagent runs
            // before it count six: a child and the parent's turn on its result, then a stopped run with its child.
            assert.equal(calls, 36);
            assert.equal(requestMembers.at(-1), owner(app).id);
            report.webUiVerified = true;
        } else {
            await Promise.race([once(process, "SIGTERM"), once(process, "SIGINT")]);
        }
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
