/** Team admits the live native registry while protecting terminal-only account/session operations. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
    supportedTeamCommand,
    teamCommandCatalog,
    teamCommandUsesAdapter,
} from "../src/server/team-command-policy.ts";

const adapters = ["settings", "model", "thinking", "tree", "fork", "clone", "compact", "reload"];
const protectedBuiltins = [
    "new",
    "resume",
    "export",
    "import",
    "quit",
    "login",
    "logout",
    "hotkeys",
    "scoped-models",
    "changelog",
    "trust",
    "share",
    "bug",
];

test("Team admits discovered extensions by default but protects terminal-only builtins", () => {
    for (const name of [
        ...adapters,
        "name",
        "session",
        "copy",
        "goal",
        "browser",
        "computer-use",
        "context",
        "llama",
        "mcp",
        "qoder-credits",
        "qoder-models",
        "fixture.echo",
    ]) {
        assert.equal(supportedTeamCommand({ name, source: "extension" }), true, name);
    }

    for (const name of protectedBuiltins) {
        assert.equal(supportedTeamCommand({ name, source: "builtin" }), false, name);
    }

    assert.equal(supportedTeamCommand({ name: "skill:pi-subagents", source: "skill" }), true);
    assert.equal(supportedTeamCommand({ name: "review", source: "prompt" }), true);
    assert.equal(supportedTeamCommand({ name: "team-kernel-tree", source: "prompt" }), false);
});

test("native name precedence is resolved before protection or execution", () => {
    assert.deepEqual(
        teamCommandCatalog([
            { name: "export", source: "builtin" },
            { name: "export", source: "prompt" },
            { name: "context", source: "extension" },
            { name: "context", source: "prompt" },
            { name: "skill:shadowed", source: "extension" },
            { name: "skill:shadowed", source: "skill" },
            { name: "goal", source: "extension" },
            { name: "goal", source: "prompt" },
            { name: "review", source: "prompt" },
        ]),
        [
            { name: "context", source: "extension" },
            { name: "skill:shadowed", source: "extension" },
            { name: "goal", source: "extension" },
            { name: "review", source: "prompt" },
        ],
    );
});

test("busy Web-adapter commands do not enter steer/follow-up dispatch", () => {
    for (const command of adapters) {
        assert.equal(teamCommandUsesAdapter(`/${command}`), true);
        assert.equal(teamCommandUsesAdapter(`/${command} argument`), true);
    }

    assert.equal(teamCommandUsesAdapter(" /goal  "), true);
    assert.equal(teamCommandUsesAdapter("/goal pause"), false);
    assert.equal(teamCommandUsesAdapter("/context"), true);
    assert.equal(teamCommandUsesAdapter("/context injections"), true);
    assert.equal(teamCommandUsesAdapter("/browser status"), false);
    assert.equal(teamCommandUsesAdapter("ordinary text"), false);
    assert.equal(teamCommandUsesAdapter(null), false);
    assert.equal(teamCommandUsesAdapter({ text: "/thinking" }), false);
});
