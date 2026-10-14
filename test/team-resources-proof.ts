/** Actual pinned native resource and generic-command proof. No real provider or external side effects. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { RotomExecutions } from "../src/server/rotom-executions.ts";
import {
    existsSync,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    nativeSessionManager,
    startRotomKernel,
    verifyRotomKernel,
} from "../src/server/rotom-kernel.ts";

process.umask(0o077);
const root = realpathSync(mkdtempSync(join(tmpdir(), "team-resources-proof-")));
const home = join(root, "kernel-homes/fixture-member"),
    workspace = join(root, "workspace"),
    teamAgentDir = join(root, "team-agent");

for (const directory of [
    home,
    join(workspace, ".pi/extensions"),
    join(workspace, ".pi/skills/project"),
    join(teamAgentDir, "extensions"),
    join(teamAgentDir, "skills/shared"),
]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
}

const forbidden = join(root, "PROJECT_EXECUTED");
const malicious = `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(forbidden)}, 'loaded'); export default pi => pi.registerCommand('project-forbidden', {handler: async () => {}});`;

writeFileSync(join(workspace, ".pi/extensions/forbidden.ts"), malicious);
writeFileSync(
    join(workspace, ".pi/settings.json"),
    JSON.stringify({
        extensions: ["./extensions/forbidden.ts"],
        packages: ["./extension-package"],
        skills: [],
    }),
);
mkdirSync(join(workspace, ".pi/extension-package"));
writeFileSync(
    join(workspace, ".pi/extension-package/package.json"),
    '{"name":"project-package","pi":{"extensions":["index.ts"]}}',
);
writeFileSync(join(workspace, ".pi/extension-package/index.ts"), malicious);
writeFileSync(join(workspace, "AGENTS.md"), "PROJECT_CONTEXT_ALLOWED\n");
writeFileSync(
    join(workspace, ".pi/computer-use.json"),
    JSON.stringify({
        browser_use: false,
        headless: true,
        cursor_overlay: false,
        managed_browser: "helium",
    }),
);
mkdirSync(join(home, ".pi/agent"), { recursive: true, mode: 0o700 });
writeFileSync(join(home, ".pi/agent/trust.json"), JSON.stringify({ [workspace]: true }));
writeFileSync(
    join(workspace, ".pi/skills/project/SKILL.md"),
    "---\nname: project-allowed\ndescription: permitted project skill\n---\nPROJECT_SKILL_ALLOWED\n",
);
writeFileSync(
    join(teamAgentDir, "skills/shared/SKILL.md"),
    "---\nname: shared-allowed\ndescription: shared agent skill\n---\nSHARED_SKILL_ALLOWED\n",
);
writeFileSync(join(teamAgentDir, "AGENTS.md"), "SHARED_CONTEXT_ALLOWED\n");
writeFileSync(
    join(teamAgentDir, "team.json"),
    JSON.stringify({ configFiles: ["fixture-config.json"] }),
);
writeFileSync(join(teamAgentDir, "fixture-config.json"), '{"enabled":true}');
const extension = `import {writeFileSync,appendFileSync} from 'node:fs';
export default function(pi) {
    appendFileSync(${JSON.stringify(join(root, "native-starts"))},"start\\n");
    pi.registerCommand('future-alpha', { description: 'unknown name one', handler: async(args, ctx) => {
        const selected = await ctx.ui.select('Native selection', ['one', 'two']);
        const input = await ctx.ui.input('Native input');
        const confirmed = await ctx.ui.confirm('Native confirmation', args);
        pi.appendEntry('future-alpha-effect', {args, selected, input, confirmed});
        pi.appendEntry('future-context-effect', {system: ctx.getSystemPrompt()});
        ctx.ui.setStatus('future-slot', args);
        ctx.ui.setWidget('future-widget', ['actual native widget']);
        ctx.ui.notify('future-alpha-done');
    }});
    pi.registerCommand('future-context', {handler: async (_args,ctx) => { pi.appendEntry('future-frozen-context', {system:ctx.getSystemPrompt()}); }});
    pi.registerCommand('future-config-write', {handler: async () => { writeFileSync(process.env.HOME+'/.pi/agent/fixture-config.json', '{"enabled":false}'); }});
    pi.registerCommand('future-native-reload', {handler: async (_args,ctx) => { await ctx.reload(); }});
    pi.registerCommand('future-followup', { handler: async () => {
        await new Promise(resolve => setTimeout(resolve, 30));
        pi.sendUserMessage('ASYNC_FOLLOWUP_REQUEST');
    }});
    pi.registerCommand('future-beta', { description: 'unknown name two', handler: async(args) => {
        pi.appendEntry('future-beta-effect', {args});
        throw new Error('AFTER_REAL_EFFECT');
    }});
}`;

writeFileSync(join(teamAgentDir, "extensions/future.ts"), extension);
mkdirSync(join(teamAgentDir, "agents"));
writeFileSync(
    join(teamAgentDir, "agents/shared-owner.md"),
    "---\nname: shared-owner\ndescription: shared owner role\nmodel: resource-fixture/resource-fixture\n---\nShared role",
);
mkdirSync(join(teamAgentDir, "role-package/agents"), { recursive: true });
writeFileSync(
    join(teamAgentDir, "role-package/package.json"),
    '{"name":"role-package","pi-subagents":{"agents":["agents"]}}',
);
writeFileSync(
    join(teamAgentDir, "role-package/agents/shared-package-role.md"),
    "---\nname: shared-package-role\ndescription: shared package role\nmodel: resource-fixture/resource-fixture\n---\nPackage role",
);
writeFileSync(
    join(teamAgentDir, "settings.json"),
    JSON.stringify({ packages: ["./role-package"] }),
);

const events: Record<string, unknown>[] = [];
const calls: unknown[] = [];
const provider = createServer(async (request, response) => {
    let text = "";

    for await (const chunk of request) {
        text += chunk;
    }

    const body = JSON.parse(text);

    calls.push(body);
    const user = body.messages.findLast((message: { role: string }) => message.role === "user");
    const last = body.messages.at(-1);
    const probing = JSON.stringify(user).includes("POLICY_ROLE_PROBE");
    const searchResult =
        last?.role === "tool" && JSON.stringify(last).includes("Loaded specialized tools");
    const probe = probing && (last?.role === "user" || searchResult);
    const needSearch = !body.tools.some(
        (tool: { function: { name: string } }) => tool.function.name === "subagent",
    );

    response.writeHead(200, { "Content-Type": "text/event-stream" });

    for (const [delta, finish_reason] of [
        [
            probe
                ? {
                      role: "assistant",
                      tool_calls: [
                          {
                              index: 0,
                              id: `policy-${calls.length}`,
                              type: "function",
                              function: {
                                  name: needSearch ? "search_tools" : "subagent",
                                  arguments: needSearch
                                      ? JSON.stringify({ query: "subagent", limit: 3 })
                                      : JSON.stringify({ action: "list" }),
                              },
                          },
                      ],
                  }
                : { role: "assistant", content: "ASYNC_FOLLOWUP_COMPLETED" },
            null,
        ],
        [{}, probe ? "tool_calls" : "stop"],
    ]) {
        response.write(
            `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "resource-fixture", choices: [{ index: 0, delta, finish_reason }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } })}\n\n`,
        );
    }

    response.end("data: [DONE]\n\n");
});

provider.listen(0, "127.0.0.1");
await once(provider, "listening");
mkdirSync(join(home, ".pi/agent"), { recursive: true, mode: 0o700 });
writeFileSync(
    join(home, ".pi/agent/models.json"),
    JSON.stringify({
        providers: {
            "resource-fixture": {
                baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
                api: "openai-completions",
                apiKey: "synthetic",
                models: [
                    {
                        id: "resource-fixture",
                        contextWindow: 128000,
                        maxTokens: 1024,
                        reasoning: false,
                        input: ["text"],
                    },
                ],
            },
        },
    }),
);
const { SessionManager } = await nativeSessionManager();
const seed = SessionManager.create(workspace, join(home, ".pi/agent/sessions"));

seed.appendMessage({ role: "user", content: "Synthetic history seed", timestamp: Date.now() });
seed.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Synthetic history seed, not inference" }],
    api: "openai-completions",
    provider: "resource-fixture",
    model: "resource-fixture",
    stopReason: "stop",
    usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: Date.now(),
});
const client = await startRotomKernel({
    home,
    workspace,
    teamAgentDir,
    sessionFile: seed.getSessionFile(),
    provider: "resource-fixture",
    model: "resource-fixture",
});

client.forwardDialogs();
client.onEvent((event) => {
    events.push(event);

    if (event.type === "extension_ui_request") {
        if (event.method === "select") {
            client.answer(String(event.id), { value: "two" });
        }

        if (event.method === "input") {
            client.answer(String(event.id), { value: "editable response" });
        }

        if (event.method === "confirm") {
            client.answer(String(event.id), { confirmed: true });
        }
    }
});

try {
    const catalog = (await client.request({ type: "get_commands" })) as {
        commands: { name: string; source: string }[];
    };

    for (const name of [
        "future-alpha",
        "future-beta",
        "skill:project-allowed",
        "skill:shared-allowed",
    ]) {
        assert.ok(
            catalog.commands.some((command) => command.name === name),
            `native catalog missing ${name}`,
        );
    }

    assert.equal(
        catalog.commands.some((command) => command.name === "project-forbidden"),
        false,
    );
    assert.equal(existsSync(forbidden), false);
    await client.command("/future-alpha exact native arguments");
    const state = (await client.request({ type: "get_state" })) as { sessionFile: string };
    const rows = readFileSync(state.sessionFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    const effect = rows.find((row) => row.customType === "future-alpha-effect");

    assert.deepEqual(effect.data, {
        args: "exact native arguments",
        selected: "two",
        input: "editable response",
        confirmed: true,
    });
    assert.ok(events.some((event) => event.method === "setStatus"));
    assert.ok(events.some((event) => event.method === "setWidget"));
    const context = rows.find((row) => row.customType === "future-context-effect").data.system;

    assert.ok(context.includes("SHARED_CONTEXT_ALLOWED"));
    assert.ok(context.includes("PROJECT_CONTEXT_ALLOWED"));
    const observedCommands: Record<string, unknown> = {};

    for (const command of [
        "/trace",
        "/browser status",
        "/computer-use",
        "/subagent-cost",
        "/subagents-doctor",
        "/subagents-guide",
        "/subagents-models",
        "/subagents-stop",
        "/subagents-detach",
    ]) {
        const eventStart = events.length;
        const before = (await client.request({ type: "get_entries" })) as { entries: unknown[] };

        await client.command(command);
        const after = (await client.request({ type: "get_entries" })) as { entries: unknown[] };
        const notices = events.slice(eventStart).filter((event) => event.method === "notify");
        const added = after.entries.slice(before.entries.length);

        assert.ok(
            notices.length || added.length,
            `${command} produced neither a native notice nor native data`,
        );
        observedCommands[command] = { notices, entries: added };
    }

    await client.prompt("POLICY_ROLE_PROBE");
    const roleEntries = readFileSync(seed.getSessionFile()!, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    const roleEntry = roleEntries.findLast(
        (row) =>
            row.type === "message" &&
            row.message.role === "toolResult" &&
            row.message.toolName === "subagent",
    );

    assert.ok(roleEntry, JSON.stringify(events.slice(-18)));
    const roleList = roleEntry.message.content;

    assert.ok(JSON.stringify(roleList).includes("shared-owner"), JSON.stringify(roleList));
    assert.ok(JSON.stringify(roleList).includes("shared-package-role"), JSON.stringify(roleList));
    const originalProjectSettings = readFileSync(join(workspace, ".pi/settings.json"), "utf8");

    writeFileSync(
        join(workspace, ".pi/settings.json"),
        JSON.stringify({ subagents: { defaultExtensions: ["./extensions/forbidden.ts"] } }),
    );
    await client.prompt("POLICY_ROLE_PROBE");
    assert.ok(
        readFileSync(seed.getSessionFile()!, "utf8").includes("Team resource policy blocked"),
    );
    writeFileSync(join(workspace, ".pi/settings.json"), originalProjectSettings);
    const memberSettings = join(home, ".pi/agent/settings.json");
    const originalMemberSettings = readFileSync(memberSettings, "utf8");

    writeFileSync(
        memberSettings,
        JSON.stringify({
            ...JSON.parse(originalMemberSettings),
            packages: [join(workspace, "private-role-package")],
        }),
    );
    await client.prompt("POLICY_ROLE_PROBE");
    const lastTool = () =>
        readFileSync(seed.getSessionFile()!, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
            .findLast(
                (row) =>
                    row.type === "message" &&
                    row.message.role === "toolResult" &&
                    row.message.toolName === "subagent",
            ).message;

    assert.ok(lastTool().isError);
    assert.ok(JSON.stringify(lastTool()).includes("Team resource policy blocked"));
    writeFileSync(memberSettings, originalMemberSettings);
    mkdirSync(join(home, ".pi/agent/extensions"), { recursive: true });
    const privateExtension = join(home, ".pi/agent/extensions/private.ts");

    writeFileSync(
        privateExtension,
        `import {writeFileSync} from 'node:fs';export default ()=>writeFileSync(${JSON.stringify(forbidden)},'PRIVATE_EXTENSION_RAN');`,
    );
    await client.prompt("POLICY_ROLE_PROBE");
    assert.ok(lastTool().isError);
    assert.ok(JSON.stringify(lastTool()).includes("Team resource policy blocked"));
    assert.equal(existsSync(forbidden), false);
    rmSync(privateExtension);
    const computerUse = events.find(
        (event) =>
            event.method === "notify" &&
            String(event.message).startsWith("pi-computer-use configuration"),
    );

    assert.match(String(computerUse?.message), /managed_browser: chrome/);
    assert.match(String(computerUse?.message), /headless: disabled/);
    writeFileSync(
        join(teamAgentDir, "extensions/live-install.ts"),
        "export default pi => pi.registerCommand('future-live-installed', {handler: async()=>{}});",
    );
    await client.command("/future-native-reload");
    const reloaded = (await client.request({ type: "get_commands" })) as {
        commands: { name: string }[];
    };

    assert.ok(reloaded.commands.some((command) => command.name === "future-live-installed"));
    assert.equal(
        reloaded.commands.some((command) => command.name === "project-forbidden"),
        false,
    );
    assert.equal(existsSync(forbidden), false);
    writeFileSync(
        join(root, "report.json"),
        JSON.stringify(
            {
                root,
                realAccounts: false,
                catalog,
                effect,
                observedCommands,
                forbiddenProjectExecuted: existsSync(forbidden),
                checks: [
                    "shared and project skills",
                    "native registration",
                    "native select/input/confirm",
                    "exact arguments",
                    "persisted effect",
                    "status/widget",
                    "project auto/settings/package extensions blocked",
                ],
            },
            null,
            2,
        ),
    );
} finally {
    await client.close();
}

const beforeRejectedStartup = readFileSync(join(root, "native-starts"), "utf8");

mkdirSync(join(workspace, ".pi/agents"), { recursive: true });
writeFileSync(
    join(workspace, ".pi/agents/project.md"),
    "---\nname: project-role\nextensions: ../extensions/forbidden.ts\n---\nUntrusted role",
);
await assert.rejects(
    startRotomKernel({
        home,
        workspace,
        teamAgentDir,
        provider: "resource-fixture",
        model: "resource-fixture",
    }),
    /Project agent definitions/,
);
assert.equal(readFileSync(join(root, "native-starts"), "utf8"), beforeRejectedStartup);
assert.equal(existsSync(forbidden), false);
rmSync(join(workspace, ".pi/agents/project.md"));
const frozenFile = join(root, "frozen-context.md");

writeFileSync(frozenFile, "FROZEN_PROJECT_CONTEXT");
mkdirSync(join(teamAgentDir, "prompts"), { recursive: true });
writeFileSync(join(teamAgentDir, "prompts/shared-template.md"), "Shared prompt template");
const frozenSkill = join(root, "frozen-skill/SKILL.md");

mkdirSync(join(frozenSkill, ".."), { recursive: true });
writeFileSync(frozenSkill, "---\nname: frozen-only\ndescription: frozen skill\n---\nfrozen");
const frozen = await startRotomKernel({
    home,
    workspace,
    teamAgentDir,
    provider: "resource-fixture",
    model: "resource-fixture",
    sessionFile: seed.getSessionFile(),
    configuration: { contextFile: frozenFile, skills: [frozenSkill] },
});

try {
    const frozenCommands = (await frozen.request({ type: "get_commands" })) as {
        commands: { name: string }[];
    };

    for (const name of ["shared-template", "skill:shared-allowed", "skill:frozen-only"]) {
        assert.ok(
            frozenCommands.commands.some((command) => command.name === name),
            name,
        );
    }

    assert.ok(!frozenCommands.commands.some((command) => command.name === "skill:project-allowed"));
    await frozen.command("/future-context");
    const frozenRows = readFileSync(seed.getSessionFile()!, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    const context = frozenRows.findLast((row) => row.customType === "future-frozen-context").data
        .system;

    assert.ok(context.includes("SHARED_CONTEXT_ALLOWED"));
    assert.ok(context.includes("FROZEN_PROJECT_CONTEXT"));
    assert.ok(!context.includes("PROJECT_CONTEXT_ALLOWED"));
    assert.equal(readFileSync(frozenFile, "utf8"), "FROZEN_PROJECT_CONTEXT");
} finally {
    await frozen.close();
}

let executions = new RotomExecutions(root, async (_binding, operation) => {
    assert.ok(["admission", "inference", "fork"].includes(operation), operation);
});

executions.journal.bind("generic", {
    memberId: "fixture-member",
    kernelVersion: verifyRotomKernel().version,
    accountGeneration: "synthetic",
    provider: "resource-fixture",
    model: "resource-fixture",
    configurationDigest: "shared-test",
    home,
    workspace,
});

try {
    const imported = await executions.importHistory(
        "generic",
        "seed",
        "synthetic-seed",
        seed.getEntries(),
    );

    assert.equal(imported.status, "settled");
    const beforeFollowup = calls.length;
    const followed = await executions.run("generic", "followup", "/future-followup");

    assert.equal(followed.status, "handled", JSON.stringify(followed));
    assert.equal(followed.operation, "command");
    assert.equal(calls.length, beforeFollowup + 1);
    assert.ok(JSON.stringify(calls.at(-1)).includes("ASYNC_FOLLOWUP_REQUEST"));
    const sessionFile = executions.journal.session("generic").sessionFile!;

    assert.ok(readFileSync(sessionFile, "utf8").includes("ASYNC_FOLLOWUP_COMPLETED"));
    writeFileSync(
        join(teamAgentDir, "extensions/after-install.ts"),
        "export default pi => pi.registerCommand('future-after-install', {handler: async(args) => pi.appendEntry('future-installed-effect', {args})});",
    );
    assert.equal((await executions.run("generic", "reload", "/reload")).status, "handled");
    assert.equal(
        (await executions.run("generic", "installed", "/future-after-install exact-after-install"))
            .status,
        "handled",
    );
    const failed = await executions.run("generic", "error-once", "/future-beta never-replay");

    assert.equal(failed.status, "unknown");
    assert.equal(failed.operation, "command");
    const beforeRestart = readFileSync(sessionFile, "utf8");

    assert.ok(beforeRestart.includes("future-beta-effect"));
    executions.close();
    executions = new RotomExecutions(root, async () => {});
    const retried = await executions.run("generic", "error-once", "/future-beta never-replay");

    assert.equal(retried.id, failed.id);
    assert.equal(retried.status, "unknown");
    assert.equal(readFileSync(sessionFile, "utf8"), beforeRestart);
    assert.equal(calls.length, beforeFollowup + 1);
    await assert.rejects(
        executions.discover("generic", "blocked-after-unknown", {}),
        /running or unknown attempt/,
    );
    executions.journal.bind("new-after-restart", executions.journal.session("generic").binding);
    let restartedNames: string[] = [];
    const discovery = await executions.discover("new-after-restart", "after-restart", {
        onCommands: (commands) => {
            restartedNames = commands.map((command) => String(command.name));
        },
    });

    assert.equal(discovery.status, "handled");
    assert.ok(restartedNames.includes("future-after-install"));
    assert.equal(existsSync(forbidden), false);
    const configurationEvents: Record<string, unknown>[] = [];
    const configurationWrite = await executions.run(
        "new-after-restart",
        "configuration-write",
        "/future-config-write",
        {
            onEvent: (event) => configurationEvents.push(event),
        },
    );

    assert.equal(configurationWrite.status, "unknown");
    assert.ok(
        configurationEvents.some(
            (event) =>
                event.method === "notify" && String(event.message).includes("Team did not accept"),
        ),
    );
    assert.equal(
        readFileSync(join(teamAgentDir, "fixture-config.json"), "utf8"),
        '{"enabled":true}',
    );
    executions.journal.bind("fresh-derived-view", executions.journal.session("generic").binding);
    assert.equal(
        (await executions.discover("fresh-derived-view", "restore-shared", {})).status,
        "handled",
    );
    assert.equal(
        readFileSync(join(home, ".pi/agent/fixture-config.json"), "utf8"),
        '{"enabled":true}',
    );
    const report = JSON.parse(readFileSync(join(root, "report.json"), "utf8"));

    report.generic = {
        followed: followed.id,
        samePayer: followed.binding.memberId,
        paidCalls: calls.length,
        errorReceipt: failed.id,
        replayAddedBytes: false,
        restartedNames,
    };
    report.checks.push(
        "native async follow-up under same receipt and payer",
        "new extension without Team code changes",
        "reload and restart discovery",
        "post-effect error remains unknown without replay",
        "project roles rejected before native startup, late role settings blocked at real native model-only tool boundary, shared direct/package roles load; live private member packages/autodiscovered extensions blocked",
        "frozen project context/skills retain current shared base context, skills and prompts without rewriting the snapshot",
        "declared member configuration mutation warns, stays unknown and never changes shared configuration",
    );
    writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2));
    console.log(`Shared native proof passed: ${root}`);
} finally {
    executions.close();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
}
