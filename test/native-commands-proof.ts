/** Actual pinned command adapters through Team HTTP, isolated synthetic accounts and loopback inference only. */
import { root, owner, until, fakeTab } from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { PocketApp } from "../src/server/app.ts";
import { createHandler } from "../src/server/http.ts";
import type { Runtime } from "../src/server/team-accounts.ts";
import type { User } from "../src/server/config.ts";
import { COOKIE } from "../src/server/auth.ts";
import { nativeSessionManager } from "../src/server/rotom-kernel.ts";

process.umask(0o077);
const data = join(realpathSync(root), "native-commands");
const workspace = join(realpathSync(root), "commands-workspace");
const startsFile = join(data, "native-starts.jsonl");

mkdirSync(data, { mode: 0o700 });
mkdirSync(workspace, { recursive: true, mode: 0o700 });
mkdirSync(join(data, "team-agent/extensions"), { recursive: true, mode: 0o700 });
mkdirSync(join(data, "team-agent/prompts"), { recursive: true, mode: 0o700 });
writeFileSync(
    join(data, "team-agent/prompts/fixture-prompt.md"),
    "NATIVE_TEMPLATE_INPUT $ARGUMENTS",
);
// Native command resolution prefers the hidden extension over this same-name template.
writeFileSync(
    join(data, "team-agent/prompts/fixture-echo.md"),
    "MUST_NOT_BYPASS_COMMAND_ADMISSION",
);
writeFileSync(
    join(data, "team-agent/prompts/runtime-swap.md"),
    "STALE_TEMPLATE_MUST_NOT_AUTHORIZE_AN_EXTENSION",
);
writeFileSync(
    join(data, "team-agent/extensions/commands.ts"),
    `import {appendFileSync,existsSync} from "node:fs";
export default function(pi) {
    pi.on("session_start", () => appendFileSync(${JSON.stringify(join(realpathSync(root), "native-commands/native-starts.jsonl"))}, JSON.stringify({home: process.env.HOME}) + "\\n"));
    pi.on("session_start", () => { if (existsSync(${JSON.stringify(join(data, "force-discovery-unknown"))})) process.exit(17); });
    pi.registerCommand("fixture-echo", {description: "fixture dynamic command", handler: async (_args, ctx) => ctx.ui.notify("native-echo")});
    const swap = () => pi.registerCommand("runtime-swap", {handler: async () => pi.appendEntry("hidden-command-effect", {})});
    pi.on("session_start", () => { if (existsSync(${JSON.stringify(join(data, "team-agent/extensions/swap-command.flag"))})) swap(); });
    pi.on("input", async (event, ctx) => {
        if (event.text.includes("HOLD_MARKER")) swap();
        if (event.text === "FIXTURE_LARGE_HISTORY" || event.text === "FIXTURE_LARGE_MEMORY") {
            for (let i = 0; i < 5; i++) pi.appendEntry("large-readback-fixture", {padding: "A".repeat(14 * 1024 * 1024)});
            if (event.text === "FIXTURE_LARGE_MEMORY") return {action: "handled"};
        }
        if (event.text === "FIXTURE_CUSTOM_MESSAGE") {
            pi.sendMessage({customType: "fixture-text", content: [{type: "text", text: "CUSTOM_"}, {type: "text", text: "DRAFT"}], display: true}, {triggerTurn: false});
            pi.appendEntry("fixture-after-custom", {});
            return {action: "handled"};
        }
        if (event.text === "FIXTURE_CANCEL_TREE" || event.text === "FIXTURE_ALLOW_TREE") {
            pi.appendEntry("fixture-tree-cancellation", {enabled: event.text === "FIXTURE_CANCEL_TREE"});
            return {action: "handled"};
        }
        if (event.text !== "FIXTURE_STATUS") return;
        for (let i = 0; i < 20; i++) { ctx.ui.setStatus("fixture-status", "STATUS_" + i); ctx.ui.setWidget("fixture-widget", ["WIDGET_" + i]); }
        await ctx.ui.confirm("Clear native slots?", "The latest status and widget should each occupy one slot.");
        ctx.ui.setStatus("fixture-status", undefined); ctx.ui.setWidget("fixture-widget", undefined);
        await ctx.ui.confirm("Native slots cleared", "Both slots must disappear while this command remains open.");
        return {action: "handled"};
    });
    pi.on("session_before_tree", (_event, ctx) => {
        if (ctx.sessionManager.getEntries().findLast(entry => entry.customType === "fixture-tree-cancellation")?.data?.enabled) return {cancel: true};
    });
    for (const name of ["future.点", "constructor"]) { pi.registerCommand(name, {description: "Generic native name", handler: async (args) => pi.appendEntry("fixture-generic-name", {name, args})}); }
    pi.registerCommand("fixture-private", {description: "private-home:" + process.env.HOME, handler: async () => {}});
    pi.registerCommand("fixture-error", {handler: async () => { pi.appendEntry("fixture-effect", {effect: true}); throw new Error("fixture-after-effect"); }});
}`,
);
const calls: Array<{ payer: string; body: Record<string, any> }> = [];
let hold = false;
const heldResponses: Array<() => void> = [];

const releaseResponses = () => {
    hold = false;

    for (const release of heldResponses.splice(0)) {
        release();
    }
};

const goalCounts = new Map<string, number>();
const provider = createServer(async (request, response) => {
    let body = "";

    for await (const chunk of request) {
        body += chunk;
    }

    const payer = String(request.headers.authorization).replace("Bearer synthetic:", "");
    const input = JSON.parse(body);

    calls.push({ payer, body: input });
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const emit = (delta: unknown, finish: string | null = null) =>
        response.write(
            `data: ${JSON.stringify({ id: `private-response-${calls.length}`, object: "chat.completion.chunk", created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } } : {}) })}\n\n`,
        );

    emit({ role: "assistant" });
    const goalContext = input.messages
        .filter((message: { role: string }) => ["system", "user"].includes(message.role))
        .map((message: { content: unknown }) =>
            Array.isArray(message.content)
                ? message.content.map((block: { text?: string }) => block.text ?? "").join("\n")
                : String(message.content),
        )
        .join("\n");
    const goalId = [...goalContext.matchAll(/<goal_id>\s*([^<]+?)\s*<\/goal_id>/g)]
        .at(-1)?.[1]
        ?.trim();

    if (goalId) {
        const count = (goalCounts.get(goalId) ?? 0) + 1;

        goalCounts.set(goalId, count);

        if (count <= 2) {
            emit({
                tool_calls: [
                    {
                        index: 0,
                        id: `goal-${count}`,
                        type: "function",
                        function: {
                            name: count === 1 ? "goal_continue" : "goal_wait",
                            arguments: JSON.stringify(
                                count === 1
                                    ? { goal_id: goalId, next_action: "Wait for browser input." }
                                    : {
                                          goal_id: goalId,
                                          reason: "Await browser input.",
                                          resume_after_ms: 60_000,
                                      },
                            ),
                        },
                    },
                ],
            });
            emit({}, "tool_calls");
        } else {
            emit({
                content: "The browser woke the native Goal. Pause for the next user decision.",
            });
            emit({}, "stop");
        }

        response.end("data: [DONE]\n\n");

        return;
    }

    emit({ reasoning_content: `PRIVATE_REASONING_${payer}` });
    emit({ content: `NATIVE_ANSWER_${calls.length}` });

    const finish = () => {
        emit({}, "stop");
        response.end("data: [DONE]\n\n");
    };

    if (hold) {
        heldResponses.push(finish);
    } else {
        finish();
    }
});

provider.listen(0, "127.0.0.1");
await once(provider, "listening");
const baseUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;
const qoderCalls: Array<{ memberId: string; action: string; force?: boolean }> = [];

const configureUserModels = (models: Runtime, user: User) => {
    models.registerNativeProvider({
        id: "openai",
        name: "synthetic commands fixture",
        auth: {
            apiKey: {
                name: "fixture",
                resolve: async () => ({
                    auth: { apiKey: `synthetic:${user.id}` },
                    source: "fixture",
                }),
            },
        },
        getModels: () =>
            ["model-a", "model-b", "model-c"].map((id) => ({
                id,
                name: id,
                api: "openai-completions" as const,
                provider: "openai",
                baseUrl,
                reasoning: true,
                // Like Qoder's reasoning-only tiers: "off" clamps to "low".
                ...(id === "model-c" ? { thinkingLevelMap: { off: null, minimal: null } } : {}),
                input: ["text" as const, "image" as const],
                contextWindow: 32000,
                maxTokens: 1024,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            })),
        stream: () => {
            throw new Error("Durable must not run");
        },
        streamSimple: () => {
            throw new Error("Durable must not run");
        },
    });
    const qoder = {
        id: "qoder",
        name: "synthetic personal Qoder account",
        auth: {
            apiKey: {
                name: "fixture",
                resolve: async () => ({
                    auth: { apiKey: `private-qoder:${user.id}` },
                    source: "fixture",
                }),
            },
        },
        getModels: () => [],
        refreshModels: async (context: { force?: boolean }) => {
            qoderCalls.push({ memberId: user.id, action: "models", force: context.force });
        },
        getCatalogStatus: () => [{ id: `PRIVATE_CATALOG_${user.id}`, enabled: true }],
        getQuotaUsage: async ({ apiKey }: { apiKey: string }) => {
            assert.equal(apiKey, `private-qoder:${user.id}`);
            qoderCalls.push({ memberId: user.id, action: "credits" });

            return {
                observedAt: 1000,
                pools: {
                    plan: { remaining: 7, total: 10, used: 3, unit: "credits" },
                    addon: null,
                    shared: { remaining: null, total: null, used: null, unit: "unknown" },
                },
                privateFixture: `PRIVATE_CREDITS_${user.id}`,
            };
        },
        stream: () => {
            throw new Error("Qoder inference must not run");
        },
        streamSimple: () => {
            throw new Error("Qoder inference must not run");
        },
    };

    models.registerNativeProvider(qoder);
};

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
let bootstrap: { token: string; id: number } | undefined;
const server = createServer((req, res) => {
    if (req.url === "/native-command-bootstrap" && bootstrap) {
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

server.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/`;
let sequence = 0;
const report: Record<string, unknown> = { realAccounts: false, data };

try {
    const alice = owner(app);
    const bob = app.config.addUser("Bob", "guest").user;
    const viewer = app.config.addUser("Viewer", "viewer").user;
    const tokens = new Map(
        [alice, bob, viewer].map((user) => [user.id, app.config.addDevice(user.id).token]),
    );
    const request = (user: User, path: string, body?: unknown) =>
        fetch(`${base}${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: {
                authorization: `Bearer ${tokens.get(user.id)}`,
                "x-pocket": "1",
                "content-type": "application/json",
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });

    const json = async (response: Response) => {
        const text = await response.text();

        assert.equal(response.status, 200, text);

        return JSON.parse(text);
    };

    const created = await json(
        await request(alice, "sessions", { backend: "rotom", cwd: workspace }),
    );
    const id = created.id;
    const submit = (user: User, text: string, extra: Record<string, unknown> = {}, target = id) =>
        request(user, `c/${target}/submit`, { text, requestId: `command-${++sequence}`, ...extra });
    const beforeCatalog = await json(await request(viewer, `c/${id}/prompts`));

    assert.equal(beforeCatalog.dynamicReady, false);
    assert.equal(existsSync(startsFile), false, "GET does not start native extensions");
    assert.ok(beforeCatalog.commands.some((command: { name: string }) => command.name === "model"));
    assert.ok(
        !beforeCatalog.commands.some((command: { name: string }) =>
            ["share", "bug"].includes(command.name),
        ),
    );
    assert.equal(calls.length, 0);
    const beforeDiscovery = (await app.kernel!.executions.journal.receipts(String(id))).length;

    assert.equal(
        (await request(viewer, `c/${id}/prompts`, { requestId: "viewer-discovery" })).status,
        403,
    );
    assert.equal(
        (await app.kernel!.executions.journal.receipts(String(id))).length,
        beforeDiscovery,
    );
    const discovered = await json(
        await request(alice, `c/${id}/prompts`, { requestId: "first-discovery" }),
    );

    assert.equal(discovered.receipt.status, "handled");
    assert.equal(discovered.receipt.operation, "discover");
    assert.ok(discovered.commands.some((command: { name: string }) => command.name === "goal"));
    assert.equal(calls.length, 0, "first-session discovery must not require a paid prompt");
    const emptyContext = await json(
        await submit(alice, "/context", { requestId: "empty-context" }),
    );

    assert.equal(emptyContext.status, "handled");
    assert.equal(emptyContext.nativeResult.context.type, "native-context");
    assert.equal(emptyContext.nativeResult.context.captured, false);
    assert.ok(emptyContext.nativeResult.context.estimatedTokens > 0);
    assert.equal(calls.length, 0, "context before first message runs no model probe");
    assert.equal((await submit(viewer, "/context")).status, 403);
    assert.equal((await submit(alice, "/context config")).status, 400);
    const afterContextCatalog = await json(await request(alice, `c/${id}/prompts`));
    const startsBeforeRead = readFileSync(startsFile, "utf8");
    const realNow = Date.now;

    try {
        Date.now = () => realNow() + 31_000;
        const retained = await json(await request(alice, `c/${id}/prompts`));

        assert.equal(retained.dynamicReady, true);
        assert.equal(retained.freshness, "last-known");
        assert.equal(retained.capturedAt, afterContextCatalog.capturedAt);
        assert.deepEqual(retained.commands, afterContextCatalog.commands);
    } finally {
        Date.now = realNow;
    }

    assert.equal(readFileSync(startsFile, "utf8"), startsBeforeRead);
    assert.equal(
        (await request(bob, `c/${id}/native-settings`, { steeringMode: "all" })).status,
        403,
    );
    assert.equal((await json(await request(bob, `c/${id}/prompts`))).dynamicReady, false);
    assert.equal((await submit(alice, "/unknown-before-title")).status, 400);
    assert.equal(app.sessionMeta(id)?.title, undefined);
    assert.equal((await json(await submit(alice, "FIRST_USER_MARKER"))).status, "settled");
    assert.equal(calls.at(-1)!.body.model, "model-a");
    const sourceFirst = await app.kernel!.executions.journal.session(String(id));

    const originalFile = sourceFirst.sessionFile!;
    const registry = await json(await request(alice, `c/${id}/prompts`));

    assert.equal((await json(await request(viewer, `c/${id}/prompts`))).dynamicReady, false);

    assert.ok(registry.dynamicReady);
    assert.notEqual(
        ((await app.kernel!.roomState(id, alice)) as { commandsRevision: string | null })
            .commandsRevision,
        null,
        "the catalog revision reaches only its exact member and binding",
    );
    assert.equal(
        ((await app.kernel!.roomState(id, bob)) as { commandsRevision: string | null })
            .commandsRevision,
        null,
    );
    assert.equal(
        ((await app.kernel!.roomState(id, viewer)) as { commandsRevision: string | null })
            .commandsRevision,
        null,
    );
    const projectionJournal = app.kernel!.executions.journal;
    const originalRoomSnapshot = projectionJournal.roomSnapshot;
    let projectionReads = 0;

    try {
        projectionJournal.roomSnapshot = async function (sessionId) {
            projectionReads++;

            return await originalRoomSnapshot.call(this, sessionId);
        };

        assert.notEqual(
            ((await app.kernel!.roomState(id, alice)) as { commandsRevision: string | null })
                .commandsRevision,
            null,
        );
        assert.equal(
            projectionReads,
            1,
            "one roomState performs exactly one fresh room snapshot read",
        );

        projectionJournal.roomSnapshot = async function (sessionId) {
            const session = (await originalRoomSnapshot.call(this, sessionId))!;

            return {
                ...session,
                binding: { ...session.binding, model: "unmatched-projection-model" },
            };
        };

        assert.equal(
            ((await app.kernel!.roomState(id, alice)) as { commandsRevision: string | null })
                .commandsRevision,
            null,
            "even the same member and segment need exact full binding equality",
        );
    } finally {
        projectionJournal.roomSnapshot = originalRoomSnapshot;
    }

    const projectionRoom = await app.room(id);
    const savedClients = [...projectionRoom.clients];
    const originalGoal = app.kernel!.nativeGoal;
    const originalRoomState = app.kernel!.roomState;
    const aliceTab = fakeTab(id, alice);
    const bobTab = fakeTab(id, bob);
    const viewerTab = fakeTab(id, viewer);
    let goalReads = 0;
    let safetyReads = 0;
    let nextGoal: unknown = await originalGoal.call(app.kernel!, id);

    try {
        projectionRoom.clients.clear();
        const tabs = [aliceTab, bobTab, viewerTab];

        for (const tab of tabs) {
            projectionRoom.clients.add(tab.client);
        }

        app.kernel!.nativeGoal = async function () {
            goalReads++;

            return nextGoal;
        };

        app.kernel!.roomState = async function (sessionId, user) {
            safetyReads++;

            return await originalRoomState.call(this, sessionId, user);
        };

        await projectionRoom.pushAll(aliceTab.client);
        assert.equal(goalReads, 1, "one synchronous fanout reads native Goal once, even if absent");
        assert.equal(safetyReads, 3, "every viewer still performs its fresh safety projection");
        assert.equal(aliceTab.last("view")!.full, true);
        assert.equal(bobTab.last("view")!.full, false);
        assert.deepEqual(aliceTab.field("nativeGoal"), nextGoal ?? null);
        assert.deepEqual(bobTab.field("nativeGoal"), nextGoal ?? null);
        assert.notEqual(
            (aliceTab.last("view")!.kernel as { commandsRevision: unknown }).commandsRevision,
            null,
        );
        assert.equal(
            (bobTab.last("view")!.kernel as { commandsRevision: unknown }).commandsRevision,
            null,
        );
        assert.equal(
            (viewerTab.last("view")!.kernel as { commandsRevision: unknown }).commandsRevision,
            null,
        );
        nextGoal = { goal: { id: "fixture-current", status: "active" } };
        await projectionRoom.pushAll();
        assert.equal(goalReads, 2, "the next fanout rereads Goal rather than keeping a cache");
        assert.equal(safetyReads, 6);

        for (const tab of tabs) {
            assert.deepEqual(tab.field("nativeGoal"), nextGoal);
        }

        nextGoal = { goal: { id: "fixture-current", status: "waiting" } };
        await projectionRoom.pushAll();
        assert.equal(goalReads, 3);
        nextGoal = undefined;
        await projectionRoom.pushAll();
        assert.equal(goalReads, 4);

        for (const tab of tabs) {
            assert.equal(tab.field("nativeGoal"), null, "cleared Goal is not retained");
        }

        await projectionRoom.push(aliceTab.client, true);
        await projectionRoom.push(bobTab.client, true);
        assert.equal(goalReads, 6, "standalone/reconnect pushes stay independently fresh");

        app.kernel!.nativeGoal = () => {
            throw new Error("fixture corrupt Goal read");
        };

        const before = tabs.map((tab) => tab.events.length);

        await assert.rejects(
            async () => await projectionRoom.pushAll(),
            /fixture corrupt Goal read/,
        );
        assert.deepEqual(
            tabs.map((tab) => tab.events.length),
            before,
            "read failures are not swallowed into empty state",
        );
        projectionRoom.clients.clear();
        await projectionRoom.pushAll();
    } finally {
        app.kernel!.nativeGoal = originalGoal;
        app.kernel!.roomState = originalRoomState;
        projectionRoom.clients.clear();

        for (const client of savedClients) {
            projectionRoom.clients.add(client);
        }
    }

    const publicNames = new Set(registry.commands.map((command: { name: string }) => command.name));

    for (const name of [
        "context",
        "llama",
        "qoder-models",
        "name",
        "session",
        "copy",
        "fixture-echo",
        "future.点",
        "constructor",
    ]) {
        assert.equal(publicNames.has(name), true, name);
    }

    for (const name of [
        "scoped-models",
        "export",
        "import",
        "share",
        "bug",
        "trust",
        "login",
        "logout",
        "new",
        "resume",
        "quit",
    ]) {
        assert.equal(publicNames.has(name), false, name);
    }

    const noInference = calls.length;
    const contextUsage = await json(
        await submit(alice, "/context usage", { requestId: "context-usage" }),
    );
    const contextInjections = await json(await submit(alice, "/context injections"));

    assert.equal(contextUsage.nativeResult.context.view, "usage");
    assert.equal(contextUsage.nativeResult.context.captured, true);
    assert.equal(contextUsage.nativeResult.context.reported.contextWindow, 32000);
    assert.ok(contextUsage.nativeResult.context.categories.length > 0);
    assert.equal(contextInjections.nativeResult.context.view, "injections");
    assert.ok(contextInjections.nativeResult.context.groups.length > 0);
    assert.ok(!JSON.stringify(contextInjections.nativeResult).includes('"text":'));
    const contextReplay = await json(
        await submit(alice, "/context usage", { requestId: "context-usage" }),
    );

    assert.equal(contextReplay.id, contextUsage.id);
    assert.deepEqual(contextReplay.nativeResult, contextUsage.nativeResult);
    assert.equal(calls.length, noInference, "context readback never requests inference");
    report.context = { usage: true, injections: true, noInference: true, idempotentReadback: true };

    const shippedExtensions = [
        "llama",
        "mcp",
        "browser",
        "computer-use",
        "goal",
        "context",
        "trace",
        "qoder-models",
        "qoder-credits",
        "subagent-cost",
        "subagents-doctor",
        "subagents-guide",
        "subagents-detach",
        "subagents-stop",
        "subagents-models",
    ];

    for (const name of shippedExtensions) {
        const command = registry.commands.find((each: { name: string }) => each.name === name);

        assert.equal(command?.source, "extension", name);
        assert.ok(command.web?.label, name);
        assert.notEqual(command.web.label, "Unverified extension", name);
    }

    assert.equal(
        registry.commands.find((each: { name: string }) => each.name === "fixture-echo").web.label,
        "Unverified extension",
    );
    const beforeRejected = (await app.kernel!.executions.journal.receipts(String(id))).length;
    const startsBeforeRejected = readFileSync(startsFile, "utf8");
    const bindingBeforeRejected = (await app.kernel!.executions.journal.session(String(id)))
        .binding;

    for (const text of [
        "/llama",
        "/llama download fixture",
        "/subagents-stop",
        "/mcp enable fixture",
        "/mcp reconnect fixture extra",
    ]) {
        const rejected = await submit(alice, text);

        assert.equal(rejected.status, 400, await rejected.text());
    }

    assert.equal(
        (await app.kernel!.executions.journal.receipts(String(id))).length,
        beforeRejected,
    );
    assert.equal(readFileSync(startsFile, "utf8"), startsBeforeRejected);
    assert.deepEqual(
        (await app.kernel!.executions.journal.session(String(id))).binding,
        bindingBeforeRejected,
    );

    for (const text of [
        "/trace",
        "/computer-use",
        "/subagent-cost",
        "/subagents-doctor",
        "/subagents-guide overview",
        "/subagents-models",
        "/subagents-detach",
        "/browser status",
    ]) {
        const response = await json(await submit(alice, text));

        assert.equal(
            response.status,
            "handled",
            `${text}: recognized/read-only handler, not business success`,
        );
        assert.equal(calls.length, noInference, text);
    }

    report.dynamicCommands = {
        shipped: shippedExtensions.length,
        metadata: true,
        rejectedWithoutEffects: true,
        readOnlyHandlers: 8,
        noInference: true,
    };

    const beforeQoder = qoderCalls.length;

    const personalModels = await json(await submit(alice, "/qoder-models"));

    assert.equal(personalModels.nativeResult.catalog[0].id, `PRIVATE_CATALOG_${alice.id}`);
    assert.deepEqual(qoderCalls.slice(beforeQoder), [
        { memberId: alice.id, action: "models", force: undefined },
        { memberId: alice.id, action: "models", force: true },
    ]);
    const personalCredits = await json(await submit(alice, "/qoder-credits"));

    assert.match(personalCredits.nativeResult.text, /Qoder Credit snapshot/);
    assert.match(personalCredits.nativeResult.text, /7 \/ 10 credits/);
    assert.equal(
        personalCredits.nativeResult.credits.privateFixture,
        `PRIVATE_CREDITS_${alice.id}`,
    );
    assert.deepEqual(qoderCalls.slice(beforeQoder), [
        { memberId: alice.id, action: "models", force: undefined },
        { memberId: alice.id, action: "models", force: true },
        { memberId: alice.id, action: "credits" },
    ]);
    assert.equal(calls.length, noInference);
    assert.ok(!JSON.stringify(await app.room(id)).includes("PRIVATE_CREDITS_"));
    assert.ok(!JSON.stringify(await app.kernel!.snapshot(id, bob)).includes("PRIVATE_CREDITS_"));
    // A tracked resource change reloads the retained runtime: the live extension shadows the cached template and is
    // admitted without a second Team allowlist.
    writeFileSync(join(data, "team-agent/extensions/swap-command.flag"), "fixture");
    const swapped = await json(await submit(alice, "/runtime-swap"));

    rmSync(join(data, "team-agent/extensions/swap-command.flag"));
    assert.equal(swapped.status, "handled");
    assert.equal(calls.length, noInference);
    assert.ok(readFileSync(originalFile, "utf8").includes("hidden-command-effect"));
    const excludedReceipts = (await app.kernel!.executions.journal.receipts(String(id))).length;

    for (const text of ["/share", "/bug"]) {
        const response = await submit(alice, text);

        assert.equal(response.status, 400);
        assert.match(await response.text(), /not supported/);
    }

    assert.equal(
        (await app.kernel!.executions.journal.receipts(String(id))).length,
        excludedReceipts,
        "excluded external actions never start a native process",
    );

    for (const text of [
        "/unknown-fixture",
        "/team-kernel-tree anything",
        "/new",
        "/resume",
        "/export",
        "/import",
        "/quit",
        "/login",
        "/logout",
        "/hotkeys",
        "/scoped-models",
        "/changelog",
        "/trust",
    ]) {
        const response = await submit(alice, text);

        assert.equal(response.status, 400, await response.text());
        assert.equal(calls.length, noInference);
    }

    assert.equal((await json(await submit(alice, "/fixture-echo"))).status, "handled");
    assert.equal((await json(await submit(alice, "/future.点 generic"))).status, "handled");
    assert.equal((await json(await submit(alice, "/constructor generic"))).status, "handled");
    assert.equal((await json(await submit(alice, "/name allowed"))).status, "handled");
    assert.equal(app.sessionMeta(id)?.title, "allowed");
    assert.ok((await json(await submit(alice, "/session"))).nativeResult.stats);
    assert.equal(
        typeof (await json(await submit(alice, "/copy"))).nativeResult.clipboard,
        "string",
    );
    assert.equal(calls.length, noInference);
    assert.equal((await submit(viewer, "/name denied")).status, 403);
    assert.equal(await app.kernel!.executions.thinkingLevel(String(id)), "off");
    const reasoningOnly = await json(await submit(alice, "/model openai/model-c"));

    assert.equal(
        reasoningOnly.status,
        "handled",
        "a model without the current level restarts with its clamped level",
    );
    assert.equal(await app.kernel!.executions.thinkingLevel(String(id)), "low");
    // Native history still ends at "off": a later ordinary startup must accept Pi's clamp too.
    await app.close();
    app = await open();
    handler = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} });
    assert.equal(
        (await app.kernel!.agentInfo(id)).thinkingLevel,
        "low",
        "an idle session shows the level its model actually uses",
    );
    assert.equal(
        (await json(await submit(alice, "/thinking medium"))).status,
        "handled",
        "a restarted reasoning-only model starts from its clamped level",
    );
    assert.equal(await app.kernel!.executions.thinkingLevel(String(id)), "medium");
    const beforeModel = await app.kernel!.executions.journal.session(String(id));
    const changed = await json(
        await submit(alice, "/model openai/model-b", { requestId: "model-change" }),
    );

    assert.equal(changed.status, "handled");
    const afterModel = await app.kernel!.executions.journal.session(String(id));

    assert.equal(afterModel.segmentId, beforeModel.segmentId, "own model change keeps the segment");
    assert.equal(
        afterModel.sessionFile,
        beforeModel.sessionFile,
        "own model change keeps the session",
    );
    assert.ok(beforeModel.sessionFile, "the model change runs on an existing native session");
    assert.equal(afterModel.kernelSessionId, beforeModel.kernelSessionId);
    assert.ok(
        (await app.kernel!.executions.journal.segmentEntries(afterModel.segmentId)).some(
            (entry) => entry.type === "model_change" && entry.modelId === "model-b",
        ),
        "native history records the in-place model change",
    );
    const replayedModel = await json(
        await submit(alice, "/model openai/model-b", { requestId: "model-change" }),
    );

    assert.equal(replayedModel.id, changed.id);
    assert.equal(
        (await submit(alice, "/model openai/model-a", { requestId: "model-change" })).status,
        409,
    );
    assert.equal(calls.length, noInference, "model selection does not infer");
    assert.equal(
        (await app.kernel!.executions.journal.session(String(id))).binding.model,
        "model-b",
    );

    for (const viewer of [alice, bob]) {
        assert.equal(
            (await app.sessions(viewer)).find((session) => session.id === Number(id))?.model,
            "model-b",
            "sidebar uses the same current native model for every authorized viewer",
        );
    }

    const beforeThinking = await app.kernel!.executions.journal.session(String(id));
    const thinking = await json(await submit(alice, "/thinking high"));

    assert.equal(thinking.status, "handled");
    assert.equal(calls.length, noInference, "idle thinking selection does not infer");
    assert.equal(await app.kernel!.executions.thinkingLevel(String(id)), "high");
    const afterThinking = await app.kernel!.executions.journal.session(String(id));

    assert.equal(
        afterThinking.segmentId,
        beforeThinking.segmentId,
        "idle thinking keeps the segment",
    );
    assert.equal(
        afterThinking.sessionFile,
        beforeThinking.sessionFile,
        "idle thinking keeps the session",
    );
    await json(await submit(alice, "SECOND_USER_MARKER"));
    assert.equal(calls.at(-1)!.body.model, "model-b");
    assert.equal(
        calls.at(-1)!.body.reasoning_effort,
        "high",
        "idle thinking reaches the next request",
    );
    assert.equal(
        (await app.kernel!.executions.journal.session(String(id))).segmentId,
        beforeThinking.segmentId,
        "the next prompt runs in the same segment",
    );
    assert.equal(calls.at(-1)!.payer, alice.id);
    // Native title is fixture setup, not an exposed Team slash command.
    await app.kernel!.executions.run(
        String(id),
        "fixture-native-title",
        "/name Synchronized Native Name",
    );
    await json(await request(alice, `sessions/${id}`, { title: "Synchronized Native Name" }));
    assert.equal(app.sessionMeta(id)?.title, "Synchronized Native Name");
    const firstNamed = await app.kernel!.executions.journal.session(String(id));
    const native = await nativeSessionManager();

    assert.ok(
        readFileSync(firstNamed.sessionFile!, "utf8").includes(`PRIVATE_REASONING_${alice.id}`),
        "owner raw history must positively contain the private sentinel before filtering tests",
    );

    assert.equal(
        native.SessionManager.open(firstNamed.sessionFile).getSessionName(),
        "Synchronized Native Name",
    );
    await json(await submit(alice, "/thinking low"));
    await json(await submit(alice, "THIRD_USER_MARKER"));
    assert.equal(app.sessionMeta(id)?.title, "Synchronized Native Name");
    const named = await app.kernel!.executions.journal.session(String(id));
    const titleApi = await nativeSessionManager();

    assert.equal(
        titleApi.SessionManager.open(named.sessionFile!).getSessionName(),
        "Synchronized Native Name",
    );
    const beforeExport = calls.length;
    const nativeJsonl = await request(alice, `c/${id}/native-export?format=jsonl`);

    assert.equal(nativeJsonl.status, 200);
    assert.match(nativeJsonl.headers.get("cache-control") ?? "", /no-store/);
    const exported = await nativeJsonl.text();
    const rows = exported
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

    assert.equal(rows[0].type, "session");
    assert.ok(
        rows.some((row) => row.type === "session_info" && row.name === "Synchronized Native Name"),
    );
    assert.ok(rows.some((row) => row.type === "thinking_level_change"));
    assert.equal((await request(bob, `c/${id}/native-export?format=jsonl`)).status, 403);
    const html = await request(alice, `c/${id}/native-export?format=html`);

    assert.equal(html.status, 200, await html.clone().text());
    assert.match(await html.text(), /<!doctype html>/i);
    assert.equal(calls.length, beforeExport);
    // Reproduce a Team-only rename immediately before copying, without a prompt to synchronize native metadata.
    await json(await request(alice, `sessions/${id}`, { title: "Human readable source" }));
    const sourceBeforeCopy = readFileSync(named.sessionFile!, "utf8");
    const callsBeforeCopy = calls.length;
    const clone = await json(await submit(alice, "/clone", { requestId: "named-copy" }));
    const copyTitle = "Human readable source · Copy";

    await app.kernel!.mirror(clone.conversationId);
    assert.equal(app.sessionMeta(clone.conversationId)?.title, copyTitle);
    assert.equal(app.sessionMeta(id)?.title, "Human readable source");
    assert.equal(readFileSync(named.sessionFile!, "utf8"), sourceBeforeCopy);
    assert.equal(calls.length, callsBeforeCopy, "copying and naming do not infer");
    const replayedCopy = await json(await submit(alice, "/clone", { requestId: "named-copy" }));

    assert.equal(replayedCopy.conversationId, clone.conversationId);
    assert.equal(app.sessionMeta(clone.conversationId)?.title, copyTitle);
    const cloneSegment = await app.kernel!.executions.journal.session(String(clone.conversationId));

    assert.equal(clone.receipt.status, "settled");
    assert.notEqual(clone.conversationId, id);
    assert.notEqual(cloneSegment.sessionFile, named.sessionFile);
    assert.ok(
        native.SessionManager.open(cloneSegment.sessionFile)
            .getEntries()
            .some((entry: { type: string }) => entry.type === "session_info"),
    );
    assert.ok(readFileSync(named.sessionFile!, "utf8").includes(`PRIVATE_REASONING_${alice.id}`));
    assert.ok(
        readFileSync(cloneSegment.sessionFile!, "utf8").includes(`PRIVATE_REASONING_${alice.id}`),
        "same-member native clone retains private native entries",
    );
    const foreignClone = await json(await submit(bob, "/clone"));
    const foreignSegment = await app.kernel!.executions.journal.session(
        String(foreignClone.conversationId),
    );

    assert.ok(
        !readFileSync(foreignSegment.sessionFile!, "utf8").includes(
            `PRIVATE_REASONING_${alice.id}`,
        ),
        "cross-member clone projects the private-bearing owner history before persistence",
    );
    assert.equal(app.sessionMeta(foreignClone.conversationId)?.title, copyTitle);
    await json(await submit(bob, "BOB_CLONE_CONTINUE", {}, foreignClone.conversationId));
    assert.equal(app.sessionMeta(foreignClone.conversationId)?.title, copyTitle);
    await json(await request(alice, `sessions/${id}`, { title: "Synchronized Native Name" }));
    assert.equal(calls.at(-1)!.payer, bob.id);
    assert.ok(JSON.stringify(calls.at(-1)!.body).includes("THIRD_USER_MARKER"));
    assert.ok(!JSON.stringify(calls.at(-1)!.body).includes(`PRIVATE_REASONING_${alice.id}`));
    const entries = await app.kernel!.executions.journal.segmentEntries(named.segmentId);
    const selected = entries.find(
        (entry) =>
            entry.type === "message" &&
            JSON.stringify(entry.message).includes("SECOND_USER_MARKER"),
    )!;
    const fork = await json(await submit(bob, `/fork ${selected.id}`));

    assert.equal(app.sessionMeta(fork.conversationId)?.title, "Synchronized Native Name · Fork");
    assert.equal(fork.editorText, "SECOND_USER_MARKER");
    const forkMessages = (await app.kernel!.snapshot(fork.conversationId, bob)).messages;

    assert.ok(JSON.stringify(forkMessages).includes("FIRST_USER_MARKER"));
    assert.ok(!JSON.stringify(forkMessages).includes("SECOND_USER_MARKER"));
    assert.ok(!JSON.stringify(forkMessages).includes("THIRD_USER_MARKER"));
    assert.ok(!JSON.stringify(forkMessages).includes("private-response-"));
    const forkSegment = await app.kernel!.executions.journal.session(String(fork.conversationId));

    assert.ok(
        !readFileSync(forkSegment.sessionFile!, "utf8").includes(`PRIVATE_REASONING_${alice.id}`),
    );
    await json(await submit(bob, "BOB_FORK_CONTINUE", {}, fork.conversationId));
    assert.equal(calls.at(-1)!.payer, bob.id);
    assert.ok(!JSON.stringify(calls.at(-1)!.body).includes(`PRIVATE_REASONING_${alice.id}`));
    assert.equal(
        (await app.kernel!.executions.journal.session(String(fork.conversationId))).binding
            .memberId,
        bob.id,
    );
    const selection = await json(await submit(alice, "/tree"));

    assert.ok(selection.interaction.nodes.some((node: { id: string }) => node.id === selected.id));
    const treeResult = await json(
        await submit(alice, `/tree ${selected.id}`, { requestId: "tree-stable" }),
    );

    assert.equal(treeResult.nativeResult.navigation.editorText, "SECOND_USER_MARKER");
    assert.equal(treeResult.nativeResult.navigation.cancelled, false);
    await app.kernel!.mirror(id);
    const firstBranchState = await app.kernel!.roomState(id, alice);

    assert.ok("hasBranchedHistory" in firstBranchState && firstBranchState.hasBranchedHistory);
    await app.kernel!.mirror(id);
    const repeatedBranchState = await app.kernel!.roomState(id, alice);

    assert.ok(
        "hasBranchedHistory" in repeatedBranchState && repeatedBranchState.hasBranchedHistory,
    );
    await json(await submit(alice, "AFTER_TREE_MARKER"));
    assert.ok(JSON.stringify(calls.at(-1)!.body).includes("FIRST_USER_MARKER"));
    assert.ok(!JSON.stringify(calls.at(-1)!.body).includes("SECOND_USER_MARKER"));
    assert.ok(!JSON.stringify(calls.at(-1)!.body).includes("THIRD_USER_MARKER"));
    const branchExport = await request(alice, `c/${id}/native-export?format=jsonl`);

    assert.ok(
        !(await branchExport.text()).includes("THIRD_USER_MARKER"),
        "native JSONL must export the selected branch, not the abandoned path",
    );
    const oldFile = readFileSync(originalFile, "utf8");

    assert.ok(
        oldFile.includes("FIRST_USER_MARKER"),
        "original source file survives session creation and model handoff",
    );
    const catalogBeforeSettings = await json(await request(alice, `c/${id}/prompts`));
    const setting = await json(
        await request(alice, `c/${id}/native-settings`, {
            steeringMode: "all",
            enabledModels: ["openai/model-b"],
        }),
    );

    assert.equal(setting.steeringMode, "all");
    assert.deepEqual(setting.enabledModels, ["openai/model-b"]);
    const retainedCatalog = await json(await request(alice, `c/${id}/prompts`));

    assert.equal(retainedCatalog.dynamicReady, true);
    assert.notEqual(retainedCatalog.revision, catalogBeforeSettings.revision);
    assert.equal(retainedCatalog.capturedAt, catalogBeforeSettings.capturedAt);
    assert.equal(retainedCatalog.freshness, "configuration-changed");
    assert.ok(
        retainedCatalog.commands.some((command: { name: string }) => command.name === "goal"),
    );
    assert.equal(
        (await json(await submit(alice, "/thinking"))).interaction.type,
        "native-thinking",
    );
    assert.equal((await json(await submit(alice, "/goal"))).interaction.type, "native-goal");
    await json(await submit(alice, "/reload"));
    hold = true;
    let skillAccepted = false;
    const held = submit(alice, "/skill:pi-subagents HOLD_MARKER", { wait: true }).then(
        (response) => {
            skillAccepted = true;

            return json(response);
        },
    );

    await until(() => skillAccepted, "skill admission returns before inference finishes", 20_000);
    assert.equal((await held).operation, "prompt");
    await until(
        () => JSON.stringify(calls.at(-1)?.body).includes("HOLD_MARKER"),
        "held native inference",
        20_000,
    );

    const beforeChoice = app.accounts.choice(alice);
    const beforeBinding = (await app.kernel!.executions.journal.session(String(id))).binding;

    assert.equal(
        (
            await request(alice, `c/${id}/submit`, {
                text: {},
                mode: "steer",
                requestId: "malformed-busy-input",
            })
        ).status,
        400,
    );

    for (const [command, type] of [
        ["settings", "native-settings"],
        ["thinking", "native-thinking"],
        ["goal", "native-goal"],
    ]) {
        const result = await json(await submit(alice, `/${command}`, { mode: "steer" }));

        assert.equal(
            result.interaction.type,
            type,
            `busy /${command} uses its web adapter, not the queue`,
        );
    }

    assert.equal((await submit(alice, "/context", { mode: "steer" })).status, 409);
    assert.equal((await submit(alice, "/share", { mode: "steer" })).status, 400);
    assert.equal((await submit(alice, "/name queued bypass", { mode: "followUp" })).status, 409);
    assert.equal((await submit(alice, "/model openai/model-a", { mode: "steer" })).status, 409);

    assert.equal(
        (
            await request(alice, `c/${id}/configure`, {
                model: { provider: "openai", modelId: "model-a" },
            })
        ).status,
        409,
    );
    assert.deepEqual(app.accounts.choice(alice), beforeChoice);
    const beforeLive = (await app.kernel!.executions.journal.latest(String(id)))!;
    const startsBeforeThinking = readFileSync(startsFile, "utf8");
    const heldReasoning = calls.at(-1)!.body.reasoning_effort;

    for (const user of [bob, viewer]) {
        const response = await request(user, `c/${id}/configure`, { thinkingLevel: "high" });

        assert.ok(
            [403, 409].includes(response.status),
            "only the current payer may change thinking",
        );
    }

    assert.equal(
        (
            await request(alice, `c/${id}/configure`, {
                model: { provider: "openai", modelId: "model-b" },
                thinkingLevel: "high",
            })
        ).status,
        409,
    );
    await json(await request(alice, `c/${id}/configure`, { thinkingLevel: "medium" }));
    assert.equal((await app.kernel!.agentInfo(id)).thinkingLevel, "medium");
    await json(await submit(alice, "/thinking high", { mode: "steer" }));
    assert.equal((await app.kernel!.agentInfo(id)).thinkingLevel, "high");
    await json(await request(alice, `c/${id}/configure`, { thinkingLevel: "max" }));
    assert.equal(
        (await app.kernel!.agentInfo(id)).thinkingLevel,
        "high",
        "native clamps unsupported levels",
    );
    assert.equal((await json(await submit(alice, "/thinking"))).interaction.thinkingLevel, "high");
    assert.equal(
        calls.at(-1)!.body.reasoning_effort,
        heldReasoning,
        "already dispatched request unchanged",
    );
    assert.deepEqual(
        (await app.kernel!.executions.journal.session(String(id))).binding,
        beforeBinding,
    );
    const afterLive = (await app.kernel!.executions.journal.latest(String(id)))!;

    assert.equal(afterLive.id, beforeLive.id);
    assert.equal(readFileSync(startsFile, "utf8"), startsBeforeThinking);
    assert.equal(afterLive.segmentId, beforeLive.segmentId);
    assert.deepEqual(afterLive.binding, beforeLive.binding);
    await json(await submit(alice, "AFTER_LIVE_THINKING", { mode: "steer" }));
    releaseResponses();
    await until(() => !app.kernel!.isRunning(id), "live thinking follow-up settles", 20_000);
    assert.equal(calls.at(-1)!.body.reasoning_effort, "high");
    assert.ok(JSON.stringify(calls.at(-1)!.body).includes("AFTER_LIVE_THINKING"));
    await app.kernel!.abort(id, alice);
    await until(() => !app.kernel!.isRunning(id), "held native run closes", 20_000);
    hold = false;
    await app.close();
    app = await open();
    handler = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} });
    assert.equal(app.sessionMeta(id)?.title, "Synchronized Native Name");
    assert.equal(
        (await app.kernel!.executions.journal.session(String(id))).binding.model,
        "model-b",
    );
    assert.equal((await app.kernel!.agentInfo(id)).thinkingLevel, "high");
    const callsBeforeMirror = calls.length;

    await app.kernel!.mirror(id);
    const restoredBranchState = await app.kernel!.roomState(id, alice);

    assert.ok(
        "hasBranchedHistory" in restoredBranchState && restoredBranchState.hasBranchedHistory,
        "initial prefix inspection restores branch notices even when all entries were mirrored before restart",
    );
    await app.kernel!.mirror(id);
    assert.equal(calls.length, callsBeforeMirror, "mirror catch-up does not invoke a model");
    assert.equal(
        (await app.sessions(alice)).find((session) => session.id === Number(id))?.model,
        "model-b",
    );
    assert.equal(app.sessionMeta(clone.conversationId)?.title, copyTitle);
    await json(await submit(alice, "THINKING_AFTER_RESTART"));
    assert.equal(calls.at(-1)!.body.reasoning_effort, "high");
    const startsAfterRestart = readFileSync(startsFile, "utf8");
    const catalogAfterRestart = await json(await request(alice, `c/${id}/prompts`));

    assert.equal(catalogAfterRestart.dynamicReady, true);
    assert.ok(
        catalogAfterRestart.commands.some((command: { name: string }) => command.name === "goal"),
    );
    assert.equal(readFileSync(startsFile, "utf8"), startsAfterRestart);
    const restoredTree = await json(
        await request(alice, `c/${id}/kernel-request?requestId=tree-stable&operation=submit`),
    );

    assert.equal(restoredTree.receipt.operation, "command");
    assert.deepEqual(restoredTree.nativeResult, treeResult.nativeResult);
    const noOpSession = await json(
        await request(alice, "sessions", { backend: "rotom", cwd: workspace }),
    );

    await json(await submit(alice, "NOOP_BASELINE", {}, noOpSession.id));
    const noOpSegment = await app.kernel!.executions.journal.session(String(noOpSession.id));
    const noOpLeaf = native.SessionManager.open(noOpSegment.sessionFile!).getLeafId();
    const beforeNoOp = calls.length;
    const noOp = await json(await submit(alice, `/tree ${noOpLeaf}`, {}, noOpSession.id));

    assert.equal(noOp.nativeResult.navigation.cancelled, false);
    assert.equal(noOp.nativeResult.navigation.editorText, undefined);
    assert.equal(noOp.nativeResult.navigation.summaryEntry, undefined);
    assert.equal(native.SessionManager.open(noOpSegment.sessionFile!).getLeafId(), noOpLeaf);
    assert.equal(calls.length, beforeNoOp);
    await json(await submit(alice, "COMPACT_SECOND", {}, noOpSession.id));
    await json(await submit(alice, "COMPACT_THIRD", {}, noOpSession.id));
    const compactSettingsPath = join(data, "team-agent/settings.json");
    const compactSettings = JSON.parse(readFileSync(compactSettingsPath, "utf8"));

    compactSettings.compaction = { enabled: false, keepRecentTokens: 1, reserveTokens: 1024 };
    writeFileSync(compactSettingsPath, JSON.stringify(compactSettings));
    const beforeCompact = calls.length;
    const compacted = await json(
        await submit(
            alice,
            "/compact Preserve the concrete fixture results.",
            { requestId: "slash-compact" },
            noOpSession.id,
        ),
    );

    assert.equal(compacted.status, "settled");
    assert.equal(compacted.operation, "compact");
    const afterCompact = calls.length;
    const compaction = native.SessionManager.open(noOpSegment.sessionFile!)
        .getEntries()
        .findLast((entry: { type: string }) => entry.type === "compaction");

    // The pinned native split-turn compactor requests history and turn-prefix summaries concurrently.
    assert.equal(afterCompact - beforeCompact, 2);
    assert.ok(
        calls
            .slice(beforeCompact)
            .every((call) => call.payer === alice.id && call.body.model === "model-b"),
    );
    assert.ok(compaction.summary);
    assert.equal(compaction.usage.input, 22);
    assert.equal(compaction.usage.output, 14);
    report.compaction = { calls: afterCompact - beforeCompact, usage: compaction.usage };
    const compactReplay = await json(
        await submit(
            alice,
            "/compact Preserve the concrete fixture results.",
            { requestId: "slash-compact" },
            noOpSession.id,
        ),
    );

    assert.equal(compactReplay.id, compacted.id);
    assert.equal(calls.length, afterCompact);

    if (process.argv.includes("--ui")) {
        const browserSession = await json(
            await request(alice, "sessions", { backend: "rotom", cwd: workspace }),
        );

        bootstrap = { token: tokens.get(alice.id)!, id: Number(browserSession.id) };
        const { nativeCommandUiProof } = await import("./native-commands-ui-proof.ts");

        report.browser = await nativeCommandUiProof({
            root: data,
            base: base.replace(/\/api\/$/, ""),
            modelCalls: () => calls.length,
            lastImageCount: () => {
                const content = calls
                    .at(-1)
                    ?.body.messages.findLast(
                        (message: { role: string }) => message.role === "user",
                    )?.content;

                return Array.isArray(content)
                    ? content.filter((block: { type: string }) => block.type === "image_url").length
                    : 0;
            },
            hold: () => {
                hold = true;
            },
            release: releaseResponses,
            lastThinking: () => calls.at(-1)?.body.reasoning_effort,
            app,
            user: alice,
            id: browserSession.id,
        });
    }

    const queuedFailureSession = await json(
        await request(alice, "sessions", { backend: "rotom", cwd: workspace }),
    );

    await json(await submit(alice, "QUEUED_EFFECT_BASELINE", {}, queuedFailureSession.id));
    hold = true;
    await json(
        await submit(
            alice,
            "QUEUED_EFFECT_HOLD",
            { wait: false, requestId: "queued-owner" },
            queuedFailureSession.id,
        ),
    );
    await until(
        () => JSON.stringify(calls.at(-1)?.body).includes("QUEUED_EFFECT_HOLD"),
        "ordinary active prompt for queued effect",
        20000,
    );
    const queuedOwner = (await app.kernel!.executions.journal.latest(
        String(queuedFailureSession.id),
    ))!;
    // Exercise the trusted executor below Team admission. HTTP rejects fixture commands above.
    // These fixtures still prove the native effect/error fence; they are not an extra public command surface.
    const queuedFailurePending = app
        .kernel!.executions.queue(String(queuedFailureSession.id), "/fixture-error", "steer")
        .then(
            () => assert.fail("fixture must throw after its native effect"),
            (error) => error,
        );
    const queuedFile = (
        await app.kernel!.executions.journal.session(String(queuedFailureSession.id))
    ).sessionFile!;

    await until(
        () => readFileSync(queuedFile, "utf8").includes("fixture-effect"),
        "queued native effect before owner completion",
        20000,
    );
    await assert.rejects(
        app.kernel!.executions.queue(String(queuedFailureSession.id), "/fixture-error", "steer"),
        /pending or unknown/,
    );
    await app.kernel!.abort(queuedFailureSession.id, alice);
    const queuedFailure = await queuedFailurePending;

    assert.equal(queuedFailure.outcome, "unknown");
    assert.match(queuedFailure.message, /fixture-after-effect/);
    hold = false;
    await until(
        () => !app.kernel!.isRunning(queuedFailureSession.id),
        "queued effect owner closure",
        20000,
    );
    const queuedReceipt = await app.kernel!.executions.journal.receipt(queuedOwner.id);
    const queuedBytes = readFileSync(queuedFile, "utf8");

    assert.ok(queuedBytes.includes("fixture-effect"));
    assert.equal(
        queuedBytes.split("\n").filter((line) => line.includes('"customType":"fixture-effect"'))
            .length,
        1,
        "queued retry cannot repeat the effect",
    );
    const queuedRecoverable = await app.kernel!.executions.journal.canResume(queuedOwner.id);

    writeFileSync(
        join(data, "queued-effect-evidence.json"),
        JSON.stringify({
            receipt: queuedReceipt,
            recoverable: queuedRecoverable,
            effectPersisted: true,
        }),
    );
    assert.equal(queuedReceipt.status, "unknown");
    assert.equal(queuedReceipt.operation, "prompt", "do not rewrite the owning intent type");
    assert.equal(
        queuedRecoverable,
        false,
        "queued effect-then-error must fence ordinary prompt recovery",
    );
    const failureSession = await json(
        await request(alice, "sessions", { backend: "rotom", cwd: workspace }),
    );

    await json(await submit(alice, "ERROR_BASELINE", {}, failureSession.id));
    const unknownDiscoverySession = await json(
        await request(alice, "sessions", { backend: "rotom", cwd: workspace }),
    );

    writeFileSync(join(data, "force-discovery-unknown"), "fixture-only abrupt startup exit");
    const unknownDiscovery = await json(
        await request(alice, `c/${unknownDiscoverySession.id}/prompts`, {
            requestId: "discovery-unknown",
        }),
    );

    rmSync(join(data, "force-discovery-unknown"));
    assert.equal(unknownDiscovery.receipt.status, "unknown");
    const startsAfterUnknown = readFileSync(startsFile, "utf8");

    assert.equal(
        (await json(await request(alice, `c/${unknownDiscoverySession.id}/prompts`)))
            .discoveryBlocked,
        true,
    );
    assert.equal(
        (
            await request(alice, `c/${unknownDiscoverySession.id}/prompts`, {
                requestId: "must-not-start",
            })
        ).status,
        409,
    );
    assert.equal(
        (
            await request(alice, `c/${unknownDiscoverySession.id}/configure`, {
                thinkingLevel: "low",
            })
        ).status,
        409,
        "thinking does not bypass unknown leases",
    );
    const unknownReplay = await json(
        await request(alice, `c/${unknownDiscoverySession.id}/prompts`, {
            requestId: "discovery-unknown",
        }),
    );

    assert.equal(unknownReplay.receipt.id, unknownDiscovery.receipt.id);
    assert.equal(
        readFileSync(startsFile, "utf8"),
        startsAfterUnknown,
        "unknown discovery cannot start a second native process, even with a new request id",
    );
    const largeHistory = await json(
        await request(alice, "sessions", { backend: "rotom", cwd: workspace }),
    );

    await json(await submit(alice, "MATERIALIZE_LARGE_HISTORY", {}, largeHistory.id));
    const largeSettled = await json(
        await submit(alice, "FIXTURE_LARGE_HISTORY", {}, largeHistory.id),
    );

    assert.equal(
        largeSettled.status,
        "settled",
        "persisted history above 64 MiB must not become unknown at readback",
    );
    assert.equal(largeSettled.phase, "finalization");
    const largeMemory = await json(
        await request(alice, "sessions", { backend: "rotom", cwd: workspace }),
    );
    const memoryFailure = await json(
        await submit(alice, "FIXTURE_LARGE_MEMORY", {}, largeMemory.id),
    );

    assert.equal(memoryFailure.status, "unknown");
    assert.equal(memoryFailure.phase, "finalization");
    assert.equal(memoryFailure.failure, "rpc-record-limit");
    const failedRoom = await app.kernel!.roomState(largeMemory.id, alice);

    assert.ok("pending" in failedRoom);
    assert.equal(failedRoom.pending?.failure, "rpc-record-limit");
    const beforeFailure = calls.length;
    const failed = await app.kernel!.executions.run(
        String(failureSession.id),
        "error-stable",
        "/fixture-error",
    );

    assert.equal(
        failed.status,
        "unknown",
        "a handled RPC response cannot erase a post-effect extension error",
    );
    assert.equal(failed.operation, "command");
    const failureFile = (await app.kernel!.executions.journal.session(String(failureSession.id)))
        .sessionFile!;
    const failureBytes = readFileSync(failureFile, "utf8");

    assert.ok(
        failureBytes.includes("fixture-effect"),
        "the failing extension really appended its effect",
    );
    await app.close();
    app = await open();
    handler = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} });
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal((await app.kernel!.executions.journal.receipt(failed.id)).status, "unknown");
    assert.equal(
        (await app.kernel!.executions.journal.receipt(memoryFailure.id)).status,
        "unknown",
    );
    assert.equal(
        (await app.kernel!.executions.journal.receipt(memoryFailure.id)).failure,
        "rpc-record-limit",
    );
    assert.equal(await app.kernel!.executions.journal.resume(memoryFailure.id), undefined);
    assert.equal((await app.kernel!.executions.journal.receipts(String(largeMemory.id))).length, 1);

    if (process.argv.includes("--ui")) {
        bootstrap = { token: tokens.get(alice.id)!, id: Number(largeMemory.id) };
        const { nativeFailureBannerProof } = await import("./native-commands-ui-proof.ts");

        report.failureBanner = await nativeFailureBannerProof(
            data,
            base.replace(/\/api\/$/, ""),
            largeMemory.id,
        );
    }

    assert.equal((await app.kernel!.executions.journal.receipt(queuedOwner.id)).status, "unknown");
    assert.equal(await app.kernel!.executions.journal.resume(queuedOwner.id), undefined);
    assert.equal(readFileSync(queuedFile, "utf8"), queuedBytes);
    const queuedReadback = await json(
        await submit(
            alice,
            "QUEUED_EFFECT_HOLD",
            { requestId: "queued-owner" },
            queuedFailureSession.id,
        ),
    );

    assert.equal(queuedReadback.id, queuedOwner.id);
    assert.equal(queuedReadback.status, "unknown");
    const failedReadback = await app.kernel!.executions.journal.receipt(failed.id);

    assert.equal(failedReadback.id, failed.id);
    assert.equal(failedReadback.operation, "command");
    assert.equal(
        calls.length,
        beforeFailure,
        "restart must not continue an unknown command as model input",
    );
    assert.equal(readFileSync(failureFile, "utf8"), failureBytes);
    const replay = await app.kernel!.executions.run(
        String(failureSession.id),
        "error-stable",
        "/fixture-error",
    );

    assert.equal(replay.id, failed.id);
    assert.equal(replay.status, "unknown");
    assert.equal(readFileSync(failureFile, "utf8"), failureBytes);
    assert.equal(calls.length, beforeFailure);
    report.queuedCommand = {
        operation: queuedReceipt.operation,
        status: queuedReceipt.status,
        unresolvedCommandInput: queuedReceipt.unresolvedCommandInput,
        effectCount: 1,
        recoveryEligible: false,
        restartedWithoutReplay: true,
    };
    report.largeReadback = {
        persistedHistoryOver64MiB: largeSettled.status,
        unflushedSuffix: memoryFailure.failure,
        finalizationFencedAfterRestart: true,
    };
    report.passed = true;
    report.inferences = calls.length;
    report.checks = [
        "trusted executor fixture command effects remain unknown without restart/retry replay (below HTTP admission)",
        "queued effect-then-error durably fences the existing prompt; no duplicate effect or automatic resume",
        "actual unknown discovery cannot start a second native process with same or new request ID",
        "catalog retained after 30 seconds/restart without native startup; owner-only shared settings",
        "live native extensions exposed without a Team allowlist; protected account/upload/lifecycle commands rejected",
        "native context usage/injections before first message and after inference; no paid probe or raw text result",
        "first-session no-inference discovery and member-private snapshots",
        "Qoder account API private results",
        "native title readback before first message and after handoff",
        "model A→B then inference B and Alice payer",
        "thinking high persisted",
        "skill admission clears before held inference completes",
        "live thinking changes next provider request without replacing process, segment or receipt binding",
        "native thinking clamping, payer-only admission and unknown/mixed-model fences",
        "live thinking survives native process retirement and server restart",
        "fixture native title and Team rename persist across handoff",
        "native JSONL entries and HTML export/member privacy",
        "selected earlier-user fork with Bob payer",
        "native tree navigation and explicit branch summary usage",
        "native slash compaction receipt, persisted summary/usage and idempotency",
        "clone and selected-message fork create independent Team sessions; removed lifecycle commands rejected",
        "settings persist to real native startup",
        "unknown/private/excluded commands no inference",
        "busy model mutation rejected without preference change",
        "restart persistence",
    ];
} finally {
    await app.close();
    server.closeAllConnections();
    provider.closeAllConnections();
    await Promise.all([
        new Promise<void>((resolve) => server.close(() => resolve())),
        new Promise<void>((resolve) => provider.close(() => resolve())),
    ]);
    writeFileSync(join(data, "report.json"), JSON.stringify(report, null, 2));
}

console.log(JSON.stringify(report));
