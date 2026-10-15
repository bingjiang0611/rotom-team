import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadMcpConfig } from "../runtime/rotom/node_modules/@bingjiang0611/rotom/runtime/pi/node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/config.js";
import { teamResourceRevision } from "../src/server/rotom-resources.ts";

test("project MCP uses native replacement, partial override, scopes and credential restrictions", (t) => {
    const root = mkdtempSync(join(tmpdir(), "team-project-mcp-"));
    const shared = join(root, "team-agent"),
        project = join(root, "project");

    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(shared);
    mkdirSync(join(project, ".pi"), { recursive: true });
    writeFileSync(
        join(shared, "mcp.json"),
        JSON.stringify({
            mcpServers: {
                shared: { command: "shared", exposure: "direct" },
                replaced: { command: "must-not-run" },
                disabled: { url: "https://example.invalid/mcp", auth: { provider: "openai" } },
            },
        }),
    );
    writeFileSync(
        join(project, ".pi/mcp.json"),
        JSON.stringify({
            autoEnableCodemode: false,
            mcpServers: {
                local: { command: "local" },
                replaced: { command: "project" },
                disabled: { enabled: false },
                forbidden: { url: "https://example.invalid/steal", auth: { provider: "openai" } },
            },
        }),
    );
    const loaded = loadMcpConfig({ agentDir: shared, cwd: project, projectTrusted: true });

    const replaced = loaded.servers.find((entry) => entry.name === "replaced")!.config;

    assert.ok("command" in replaced);
    assert.equal(replaced.command, "project");
    assert.equal(loaded.servers.find((entry) => entry.name === "replaced")!.scope, "project");
    assert.equal(loaded.servers.find((entry) => entry.name === "shared")!.scope, "global");
    assert.equal(loaded.servers.find((entry) => entry.name === "disabled")!.config.enabled, false);
    assert.equal(
        loaded.servers.find((entry) => entry.name === "disabled")!.override,
        join(project, ".pi/mcp.json"),
    );
    assert.equal(loaded.autoEnableCodemode, false);
    assert.equal(loaded.projectConfig, join(project, ".pi/mcp.json"));
    assert.ok(!loaded.servers.some((entry) => entry.name === "forbidden"));
    assert.match(loaded.errors.join("\n"), /auth is only allowed in the global mcp.json/);
});

test("MCP config errors stay visible and project changes invalidate command freshness without affecting other projects", (t) => {
    const root = mkdtempSync(join(tmpdir(), "team-mcp-revision-"));
    const shared = join(root, "team-agent"),
        project = join(root, "project"),
        other = join(root, "other");

    t.after(() => rmSync(root, { recursive: true, force: true }));

    for (const dir of [shared, join(project, ".pi"), other]) {
        mkdirSync(dir, { recursive: true });
    }

    const before = teamResourceRevision(shared, project);
    const otherBefore = teamResourceRevision(shared, other);

    writeFileSync(join(project, ".pi/mcp.json"), "{malformed");
    assert.notEqual(teamResourceRevision(shared, project), before);
    assert.equal(teamResourceRevision(shared, other), otherBefore);
    const loaded = loadMcpConfig({ agentDir: shared, cwd: project, projectTrusted: true });

    assert.equal(loaded.errors.length, 1);
    assert.match(loaded.errors[0]!, /mcp.json/);
    assert.deepEqual(loaded.servers, []);
});
