/**
 * Opt-in: the pinned rotom signs a member in to a project's OAuth MCP server, with a loopback OAuth server and no real
 * account. The project declares the server once; each member's sign-in is their own, and a run sends only its member's
 * token. Nothing opens a browser on the server: the member's browser is played by plain HTTP here.
 */
import assert from "node:assert/strict";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    realpathSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpSignIns } from "../src/server/mcp-sign-in.ts";
import { startRotomKernel } from "../src/server/rotom-kernel.ts";
import { startOAuthMcp } from "./fixtures/mcp-oauth.ts";

process.umask(0o077);
const root = realpathSync(mkdtempSync(join(tmpdir(), "mcp-sign-in-proof-")));
const workspace = join(root, "workspace");
const homes = { alice: join(root, "alice"), bob: join(root, "bob") };

for (const path of [workspace, ...Object.values(homes)]) {
    mkdirSync(path, { mode: 0o700 });
}

// A browser opened on the server would be the service user's: a recording `open` stands in for the real one, so a
// sign-in that tried to open one shows up here instead of on the desktop.
const opened = join(root, "opened.txt");
const recorder = join(root, "bin");

mkdirSync(recorder);

for (const name of ["open", "xdg-open"]) {
    writeFileSync(join(recorder, name), `#!/bin/sh\necho "$@" >> ${JSON.stringify(opened)}\n`);
    chmodSync(join(recorder, name), 0o755);
}

process.env.PATH = `${recorder}:${process.env.PATH}`;

const oauth = await startOAuthMcp();
const { origin } = oauth;

mkdirSync(join(workspace, ".pi"));
writeFileSync(
    join(workspace, ".pi/mcp.json"),
    JSON.stringify({ mcpServers: { team: { url: `${origin}/mcp`, exposure: "direct" } } }),
);

const signIns = new McpSignIns();
const report: Record<string, unknown> = { realProvider: false, status: "not-verified" };

try {
    const before = await signIns.list(homes.alice, workspace);

    assert.equal(before.servers[0]?.state, "needs-auth", JSON.stringify(before));

    // Alice signs in: her browser goes to the address, approves, and lands on the loopback callback, which it cannot
    // reach from her machine. She pastes that address.
    const open = await signIns.start("alice", homes.alice, workspace, "team");

    assert.equal(open.status, "open", JSON.stringify(open));
    assert.ok(open.status === "open");
    oauth.approving = "alice";
    const landed = (await fetch(open.url, { redirect: "manual" })).headers.get("location")!;

    assert.ok(landed.startsWith(open.callback), landed);
    // Only the sign-in's own callback receives a pasted address.
    await assert.rejects(
        signIns.finish("alice", landed.replace(/^http:\/\/127\.0\.0\.1:\d+/, origin)),
        /Paste the address your browser ended on/,
    );
    const done = await signIns.finish("alice", landed);

    assert.deepEqual(done, {
        status: "done",
        message: 'Signed in to MCP server "team" (1 tools).',
    });

    const alice = await signIns.list(homes.alice, workspace);
    const bob = await signIns.list(homes.bob, workspace);

    assert.deepEqual(alice.servers[0]?.tools, ["whoami_alice"]);
    assert.equal(bob.servers[0]?.state, "needs-auth", "Alice's sign-in is not Bob's");

    // A run of Alice's sends her token. `/mcp` reports what the run connected to, without a model call.
    writeFileSync(
        join(homes.alice, ".pi/agent/models.json"),
        JSON.stringify({
            providers: {
                fixture: {
                    baseUrl: "http://127.0.0.1:9/v1",
                    api: "openai-completions",
                    apiKey: "fixture-not-secret",
                    models: [
                        { id: "fixture", contextWindow: 32000, maxTokens: 1024, input: ["text"] },
                    ],
                },
            },
        }),
    );
    const kernel = await startRotomKernel({
        home: homes.alice,
        workspace,
        provider: "fixture",
        model: "fixture",
    });
    const notices: string[] = [];

    kernel.onEvent((event) => {
        if (event.type === "extension_ui_request" && event.method === "notify") {
            notices.push(String(event.message));
        }
    });
    oauth.callers.length = 0;
    assert.equal(await kernel.prompt("/mcp"), "handled");
    await kernel.close();
    assert.match(notices.join("\n"), /team.*connected/i, notices.join("\n"));
    assert.ok(oauth.callers.length > 0 && oauth.callers.every((member) => member === "alice"));

    // Signing in recorded the project's trust in Alice's HOME. A session with a frozen configuration still does not
    // open the project.
    const frozenContext = join(root, "frozen.md");

    writeFileSync(frozenContext, "Frozen configuration.");
    const frozen = await startRotomKernel({
        home: homes.alice,
        workspace,
        provider: "fixture",
        model: "fixture",
        configuration: { contextFile: frozenContext, skills: [] },
    });

    notices.length = 0;
    frozen.onEvent((event) => {
        if (event.type === "extension_ui_request" && event.method === "notify") {
            notices.push(String(event.message));
        }
    });
    assert.equal(await frozen.prompt("/mcp"), "handled");
    await frozen.close();
    assert.match(notices.join("\n"), /No MCP servers configured/, notices.join("\n"));

    // `open` starts detached, after the address is printed; the run above took long enough for one to show.
    assert.ok(!existsSync(opened), "a sign-in must never open a browser on the server");

    // Signing out removes only Alice's tokens.
    assert.equal((await signIns.logout(homes.alice, workspace, "team")).status, "done");
    assert.equal((await signIns.list(homes.alice, workspace)).servers[0]?.state, "needs-auth");

    Object.assign(report, {
        status: "passed",
        needsSignInFirst: true,
        pastedRedirectDelivered: true,
        foreignAddressRefused: true,
        browserOpenedOnServer: false,
        perMemberTokens: true,
        runSentMembersToken: true,
        signOut: true,
        frozenConfigurationStaysClosed: true,
    });
} finally {
    signIns.close();
    oauth.close();
    console.log(JSON.stringify(report, null, 2));
}
