/** Actual pinned command adapters through Team HTTP, isolated synthetic accounts and loopback inference only. */
import { root, owner, until } from "./helpers.ts";
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
writeFileSync(
    join(data, "team-agent/extensions/commands.ts"),
    `import {appendFileSync,existsSync} from "node:fs";
export default function(pi) {
    pi.on("session_start", () => appendFileSync(${JSON.stringify(join(realpathSync(root), "native-commands/native-starts.jsonl"))}, JSON.stringify({home: process.env.HOME}) + "\\n"));
    pi.on("session_start", () => { if (existsSync(${JSON.stringify(join(data, "force-discovery-unknown"))})) process.exit(17); });
    pi.registerCommand("fixture-echo", {description: "fixture dynamic command", handler: async (_args, ctx) => ctx.ui.notify("native-echo")});
    pi.registerCommand("fixture-custom-message", {handler: async (_args, ctx) => {
        pi.sendMessage({customType: "fixture-text", content: [{type: "text", text: "CUSTOM_"}, {type: "text", text: "DRAFT"}], display: true}, {triggerTurn: false});
        await ctx.waitForIdle();
        pi.appendEntry("fixture-after-custom", {});
    }});
    pi.registerCommand("fixture-status", {handler: async (_args, ctx) => {
        for (let i = 0; i < 20; i++) { ctx.ui.setStatus("fixture-status", "STATUS_" + i); ctx.ui.setWidget("fixture-widget", ["WIDGET_" + i]); }
        await ctx.ui.confirm("Clear native slots?", "The latest status and widget should each occupy one slot.");
        ctx.ui.setStatus("fixture-status", undefined); ctx.ui.setWidget("fixture-widget", undefined);
        await ctx.ui.confirm("Native slots cleared", "Both slots must disappear while this command remains open.");
    }});
    pi.registerCommand("fixture-cancel-tree", {handler: async () => pi.appendEntry("fixture-tree-cancellation", {enabled: true})});
    pi.registerCommand("fixture-allow-tree", {handler: async () => pi.appendEntry("fixture-tree-cancellation", {enabled: false})});
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

    if (!hold) {
        emit({}, "stop");
        response.end("data: [DONE]\n\n");
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
            ["model-a", "model-b"].map((id) => ({
                id,
                name: id,
                api: "openai-completions" as const,
                provider: "openai",
                baseUrl,
                reasoning: true,
                input: ["text" as const],
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

            return { balance: 7, privateFixture: `PRIVATE_CREDITS_${user.id}` };
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
    const beforeDiscovery = app.kernel!.executions.journal.receipts(String(id)).length;

    assert.equal(
        (await request(viewer, `c/${id}/prompts`, { requestId: "viewer-discovery" })).status,
        403,
    );
    assert.equal(app.kernel!.executions.journal.receipts(String(id)).length, beforeDiscovery);
    const discovered = await json(
        await request(alice, `c/${id}/prompts`, { requestId: "first-discovery" }),
    );

    assert.equal(discovered.receipt.status, "handled");
    assert.equal(discovered.receipt.operation, "discover");
    assert.ok(discovered.commands.some((command: { name: string }) => command.name === "goal"));
    assert.equal(calls.length, 0, "first-session discovery must not require a paid prompt");
    const startsBeforeRead = readFileSync(startsFile, "utf8");
    const realNow = Date.now;

    try {
        Date.now = () => realNow() + 31_000;
        const retained = await json(await request(alice, `c/${id}/prompts`));

        assert.equal(retained.dynamicReady, true);
        assert.equal(retained.freshness, "last-known");
        assert.equal(retained.capturedAt, discovered.capturedAt);
        assert.deepEqual(retained.commands, discovered.commands);
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
    const beforeGenericNames = calls.length;

    for (const name of ["future.点", "constructor"]) {
        assert.equal(
            (await json(await submit(alice, `/${name} exact-argument`))).status,
            "handled",
        );
    }

    assert.equal(
        calls.length,
        beforeGenericNames,
        "generic names invoke native handlers, not inference or builtin object properties",
    );
    const sourceFirst = app.kernel!.executions.journal.session(String(id));

    for (const name of ["future.点", "constructor"]) {
        assert.ok(
            readFileSync(sourceFirst.sessionFile!, "utf8").includes(
                JSON.stringify({ name, args: "exact-argument" }),
            ),
        );
    }

    const originalFile = sourceFirst.sessionFile!;
    const registry = await json(await request(alice, `c/${id}/prompts`));

    assert.equal((await json(await request(viewer, `c/${id}/prompts`))).dynamicReady, false);

    assert.ok(registry.dynamicReady);
    assert.ok(
        registry.commands.some((command: { name: string }) => command.name === "fixture-echo"),
    );
    const noInference = calls.length;

    const privateDescription = registry.commands.find(
        (command: { name: string }) => command.name === "fixture-private",
    ).description;

    assert.match(privateDescription, /private-home:/);
    assert.ok(
        !JSON.stringify(await json(await request(bob, `c/${id}/prompts`))).includes(
            privateDescription,
        ),
    );
    const personalCredits = await json(await submit(alice, "/qoder-credits"));
    const personalCatalog = await json(await submit(alice, "/qoder-models"));

    assert.equal(
        personalCredits.nativeResult.credits.privateFixture,
        `PRIVATE_CREDITS_${alice.id}`,
    );
    assert.equal(personalCatalog.nativeResult.catalog[0].id, `PRIVATE_CATALOG_${alice.id}`);
    assert.ok(
        qoderCalls.some(
            (call) => call.memberId === alice.id && call.action === "models" && call.force,
        ),
    );
    assert.equal(calls.length, noInference);
    assert.ok(!JSON.stringify(await app.room(id)).includes("PRIVATE_CREDITS_"));
    assert.ok(!JSON.stringify(app.kernel!.snapshot(id, bob)).includes("PRIVATE_CREDITS_"));
    const excludedReceipts = app.kernel!.executions.journal.receipts(String(id)).length;

    for (const text of ["/share", "/bug"]) {
        const response = await submit(alice, text);

        assert.equal(response.status, 400);
        assert.match(await response.text(), /excluded/);
    }

    assert.equal(
        app.kernel!.executions.journal.receipts(String(id)).length,
        excludedReceipts,
        "excluded external actions never start a native process",
    );

    for (const text of ["/unknown-fixture", "/team-kernel-tree anything"]) {
        const response = await submit(alice, text);

        assert.equal(response.status, 400, await response.text());
        assert.equal(calls.length, noInference);
    }

    assert.equal((await submit(viewer, "/name denied")).status, 403);
    const changed = await json(
        await submit(alice, "/model openai/model-b", { requestId: "model-change" }),
    );

    assert.equal(changed.status, "settled");
    const replayedModel = await json(
        await submit(alice, "/model openai/model-b", { requestId: "model-change" }),
    );

    assert.equal(replayedModel.id, changed.id);
    assert.equal(
        (await submit(alice, "/model openai/model-a", { requestId: "model-change" })).status,
        409,
    );
    assert.equal(calls.length, noInference, "model selection does not infer");
    assert.equal(app.kernel!.executions.journal.session(String(id)).binding.model, "model-b");
    await json(await submit(alice, "/thinking high"));
    assert.equal(app.kernel!.executions.journal.session(String(id)).binding.thinkingLevel, "high");
    await json(await submit(alice, "SECOND_USER_MARKER"));
    assert.equal(calls.at(-1)!.body.model, "model-b");
    assert.equal(calls.at(-1)!.payer, alice.id);
    await json(await submit(alice, "/name Synchronized Native Name"));
    assert.equal(app.sessionMeta(id)?.title, "Synchronized Native Name");
    const firstNamed = app.kernel!.executions.journal.session(String(id));
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
    const named = app.kernel!.executions.journal.session(String(id));
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
    const clone = await json(await submit(alice, "/clone"));
    const cloneSegment = app.kernel!.executions.journal.session(String(clone.conversationId));

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
    const foreignSegment = app.kernel!.executions.journal.session(
        String(foreignClone.conversationId),
    );

    assert.ok(
        !readFileSync(foreignSegment.sessionFile!, "utf8").includes(
            `PRIVATE_REASONING_${alice.id}`,
        ),
        "cross-member clone projects the private-bearing owner history before persistence",
    );
    await json(await submit(bob, "BOB_CLONE_CONTINUE", {}, foreignClone.conversationId));
    assert.equal(calls.at(-1)!.payer, bob.id);
    assert.ok(JSON.stringify(calls.at(-1)!.body).includes("THIRD_USER_MARKER"));
    assert.ok(!JSON.stringify(calls.at(-1)!.body).includes(`PRIVATE_REASONING_${alice.id}`));
    const entries = app.kernel!.executions.journal.segmentEntries(named.segmentId);
    const selected = entries.find(
        (entry) =>
            entry.type === "message" &&
            JSON.stringify(entry.message).includes("SECOND_USER_MARKER"),
    )!;
    const fork = await json(await submit(bob, `/fork ${selected.id}`));

    assert.equal(fork.editorText, "SECOND_USER_MARKER");
    const forkMessages = app.kernel!.snapshot(fork.conversationId, bob).messages;

    assert.ok(JSON.stringify(forkMessages).includes("FIRST_USER_MARKER"));
    assert.ok(!JSON.stringify(forkMessages).includes("SECOND_USER_MARKER"));
    assert.ok(!JSON.stringify(forkMessages).includes("THIRD_USER_MARKER"));
    assert.ok(!JSON.stringify(forkMessages).includes("private-response-"));
    const forkSegment = app.kernel!.executions.journal.session(String(fork.conversationId));

    assert.ok(
        !readFileSync(forkSegment.sessionFile!, "utf8").includes(`PRIVATE_REASONING_${alice.id}`),
    );
    await json(await submit(bob, "BOB_FORK_CONTINUE", {}, fork.conversationId));
    assert.equal(calls.at(-1)!.payer, bob.id);
    assert.ok(!JSON.stringify(calls.at(-1)!.body).includes(`PRIVATE_REASONING_${alice.id}`));
    assert.equal(
        app.kernel!.executions.journal.session(String(fork.conversationId)).binding.memberId,
        bob.id,
    );
    const selection = await json(await submit(alice, "/tree"));

    assert.ok(selection.interaction.nodes.some((node: { id: string }) => node.id === selected.id));
    const treeResult = await json(
        await submit(alice, `/tree ${selected.id}`, { requestId: "tree-stable" }),
    );

    assert.equal(treeResult.nativeResult.navigation.editorText, "SECOND_USER_MARKER");
    assert.equal(treeResult.nativeResult.navigation.cancelled, false);
    await json(await submit(alice, "AFTER_TREE_MARKER"));
    assert.ok(JSON.stringify(calls.at(-1)!.body).includes("FIRST_USER_MARKER"));
    assert.ok(!JSON.stringify(calls.at(-1)!.body).includes("SECOND_USER_MARKER"));
    assert.ok(!JSON.stringify(calls.at(-1)!.body).includes("THIRD_USER_MARKER"));
    const branchExport = await request(alice, `c/${id}/native-export?format=jsonl`);

    assert.ok(
        !(await branchExport.text()).includes("THIRD_USER_MARKER"),
        "native JSONL must export the selected branch, not the abandoned path",
    );
    const newSession = await json(await submit(alice, "/new", { requestId: "new-stable" }));
    const sameNew = await json(await submit(alice, "/new", { requestId: "new-stable" }));

    assert.equal(newSession.conversationId, sameNew.conversationId);
    assert.equal(app.kernel!.snapshot(newSession.conversationId, alice).messages.length, 0);
    const resume = await json(await submit(alice, `/resume ${clone.conversationId}`));

    assert.equal(resume.conversationId, clone.conversationId);
    writeFileSync(join(workspace, "import.jsonl"), exported);
    const imported = await json(await submit(bob, "/import import.jsonl"));

    assert.equal(imported.status, "settled");
    assert.equal(
        app.kernel!.executions.journal.session(String(imported.conversationId)).binding.memberId,
        bob.id,
    );
    assert.ok(
        !JSON.stringify(app.kernel!.snapshot(imported.conversationId, bob).messages).includes(
            "private-response-",
        ),
    );
    const importedSegment = app.kernel!.executions.journal.session(String(imported.conversationId));

    assert.ok(
        !readFileSync(importedSegment.sessionFile!, "utf8").includes(
            `PRIVATE_REASONING_${alice.id}`,
        ),
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
        retainedCatalog.commands.some(
            (command: { name: string }) => command.name === "fixture-echo",
        ),
    );
    const info = await json(await submit(alice, "/session"));

    assert.equal(info.nativeResult.state.model.id, "model-b");
    assert.equal(info.nativeResult.state.thinkingLevel, "low");
    assert.equal(info.nativeResult.state.steeringMode, "all");
    assert.equal((await json(await submit(alice, "/fixture-echo"))).status, "handled");
    await json(await submit(alice, "/reload"));
    hold = true;
    const held = submit(alice, "HOLD_MARKER", { wait: false });

    await held;
    await until(
        () => JSON.stringify(calls.at(-1)?.body).includes("HOLD_MARKER"),
        "held native inference",
        20_000,
    );

    const beforeChoice = app.accounts.choice(alice);
    const beforeBinding = app.kernel!.executions.journal.session(String(id)).binding;

    assert.equal(
        (
            await request(alice, `c/${id}/configure`, {
                model: { provider: "openai", modelId: "model-a" },
            })
        ).status,
        409,
    );
    assert.deepEqual(app.accounts.choice(alice), beforeChoice);
    assert.deepEqual(app.kernel!.executions.journal.session(String(id)).binding, beforeBinding);
    await app.kernel!.abort(id, alice);
    await until(() => !app.kernel!.isRunning(id), "held native run closes", 20_000);
    hold = false;
    await app.close();
    app = await open();
    handler = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} });
    assert.equal(app.sessionMeta(id)?.title, "Synchronized Native Name");
    assert.equal(app.kernel!.executions.journal.session(String(id)).binding.model, "model-b");
    const startsAfterRestart = readFileSync(startsFile, "utf8");
    const catalogAfterRestart = await json(await request(alice, `c/${id}/prompts`));

    assert.equal(catalogAfterRestart.dynamicReady, true);
    assert.ok(
        catalogAfterRestart.commands.some(
            (command: { name: string }) => command.name === "fixture-echo",
        ),
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
    const noOpSegment = app.kernel!.executions.journal.session(String(noOpSession.id));
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
    const queuedOwner = app.kernel!.executions.journal.latest(String(queuedFailureSession.id))!;
    const queuedFailurePending = submit(
        alice,
        "/fixture-error",
        { mode: "steer", requestId: "queued-effect" },
        queuedFailureSession.id,
    );
    const queuedFile = app.kernel!.executions.journal.session(
        String(queuedFailureSession.id),
    ).sessionFile!;

    await until(
        () => readFileSync(queuedFile, "utf8").includes("fixture-effect"),
        "queued native effect before owner completion",
        20000,
    );
    let queuedRetry: Response | undefined;
    const queuedRetryPending = submit(
        alice,
        "/fixture-error",
        { mode: "steer", requestId: "queued-effect" },
        queuedFailureSession.id,
    ).then((response) => {
        queuedRetry = response;
    });

    await until(() => queuedRetry !== undefined, "pending queued command retry refused", 5000);
    await queuedRetryPending;
    assert.equal(queuedRetry!.status, 409);
    await app.kernel!.abort(queuedFailureSession.id, alice);
    const queuedFailure = await queuedFailurePending;

    assert.equal(queuedFailure.status, 409);
    assert.ok((await queuedFailure.text()).includes("unknown"));
    hold = false;
    await until(
        () => !app.kernel!.isRunning(queuedFailureSession.id),
        "queued effect owner closure",
        20000,
    );
    const queuedReceipt = app.kernel!.executions.journal.receipt(queuedOwner.id);
    const queuedBytes = readFileSync(queuedFile, "utf8");

    assert.ok(queuedBytes.includes("fixture-effect"));
    assert.equal(
        queuedBytes.split("\n").filter((line) => line.includes('"customType":"fixture-effect"'))
            .length,
        1,
        "queued retry cannot repeat the effect",
    );
    const queuedRecoverable = app
        .kernel!.executions.journal.unknownPrompts()
        .some((row) => row.id === queuedOwner.id);

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
    const beforeFailure = calls.length;
    const failed = await json(
        await submit(alice, "/fixture-error", { requestId: "error-stable" }, failureSession.id),
    );

    assert.equal(
        failed.status,
        "unknown",
        "a handled RPC response cannot erase a post-effect extension error",
    );
    assert.equal(failed.operation, "command");
    const failureFile = app.kernel!.executions.journal.session(
        String(failureSession.id),
    ).sessionFile!;
    const failureBytes = readFileSync(failureFile, "utf8");

    assert.ok(
        failureBytes.includes("fixture-effect"),
        "the failing extension really appended its effect",
    );
    await app.close();
    app = await open();
    handler = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} });
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(app.kernel!.executions.journal.receipt(failed.id).status, "unknown");
    assert.equal(app.kernel!.executions.journal.receipt(queuedOwner.id).status, "unknown");
    assert.equal(app.kernel!.executions.journal.resume(queuedOwner.id), undefined);
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
    const failedReadback = await json(
        await request(
            alice,
            `c/${failureSession.id}/kernel-request?requestId=error-stable&operation=submit`,
        ),
    );

    assert.equal(failedReadback.receipt.id, failed.id);
    assert.equal(failedReadback.receipt.operation, "command");
    assert.equal(
        calls.length,
        beforeFailure,
        "restart must not continue an unknown command as model input",
    );
    assert.equal(readFileSync(failureFile, "utf8"), failureBytes);
    const replay = await json(
        await submit(alice, "/fixture-error", { requestId: "error-stable" }, failureSession.id),
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
    report.passed = true;
    report.inferences = calls.length;
    report.checks = [
        "command effects remain unknown without restart/retry replay",
        "queued effect-then-error durably fences the existing prompt; no duplicate effect or automatic resume",
        "actual unknown discovery cannot start a second native process with same or new request ID",
        "catalog retained after 30 seconds/restart without native startup; owner-only shared settings",
        "generic dotted/non-ASCII/prototype-property command names reach native handlers",
        "first-session no-inference discovery and member-private snapshots",
        "Qoder account API private results",
        "native title readback before first message and after handoff",
        "model A→B then inference B and Alice payer",
        "thinking high persisted",
        "native and Team name synchronization",
        "native JSONL entries and HTML export/member privacy",
        "selected earlier-user fork with Bob payer",
        "native tree navigation and explicit branch summary usage",
        "native slash compaction receipt, persisted summary/usage and idempotency",
        "new/resume/import/clone mapped to independent Team sessions",
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
