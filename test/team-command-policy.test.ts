/** Team filters discovery and execution together, without changing native skill/template names. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
    supportedTeamCommand,
    teamCommandCatalog,
    teamCommandUsesAdapter,
} from "../src/server/team-command-policy.ts";

const supported = [
    "settings",
    "model",
    "thinking",
    "tree",
    "fork",
    "clone",
    "compact",
    "reload",
    "goal",
    "browser",
    "computer-use",
    "mcp",
    "qoder-credits",
];
const excluded = [
    "new",
    "resume",
    "name",
    "export",
    "import",
    "session",
    "copy",
    "quit",
    "login",
    "logout",
    "hotkeys",
    "scoped-models",
    "changelog",
    "trust",
    "qoder-models",
    "share",
    "bug",
    "fixture.echo",
];

test("Team exposes only the agreed builtins/extensions, plus skills/templates", () => {
    for (const name of supported) {
        assert.equal(supportedTeamCommand({ name }), true, name);
    }

    for (const name of excluded) {
        assert.equal(supportedTeamCommand({ name, source: "extension" }), false, name);
    }

    assert.equal(supportedTeamCommand({ name: "skill:pi-subagents", source: "skill" }), true);
    assert.equal(supportedTeamCommand({ name: "review", source: "prompt" }), true);
    assert.equal(supportedTeamCommand({ name: "team-kernel-tree", source: "prompt" }), false);
});

test("native name precedence cannot turn a hidden command into a permitted template", () => {
    assert.deepEqual(
        teamCommandCatalog([
            { name: "name", source: "builtin" },
            { name: "name", source: "prompt" },
            { name: "hidden", source: "extension" },
            { name: "hidden", source: "prompt" },
            { name: "skill:shadowed", source: "extension" },
            { name: "skill:shadowed", source: "skill" },
            { name: "goal", source: "extension" },
            { name: "goal", source: "prompt" },
            { name: "review", source: "prompt" },
        ]),
        [
            { name: "goal", source: "extension" },
            { name: "review", source: "prompt" },
        ],
    );
});

test("busy adapter commands and bare Goal do not enter steer/follow-up dispatch", () => {
    for (const command of supported.slice(0, 8)) {
        assert.equal(teamCommandUsesAdapter(`/${command}`), true);
        assert.equal(teamCommandUsesAdapter(`/${command} argument`), true);
    }

    assert.equal(teamCommandUsesAdapter(" /goal  "), true);
    assert.equal(teamCommandUsesAdapter("/goal pause"), false);
    assert.equal(teamCommandUsesAdapter("/browser status"), false);
    assert.equal(teamCommandUsesAdapter("ordinary text"), false);
    assert.equal(teamCommandUsesAdapter(null), false);
    assert.equal(teamCommandUsesAdapter({ text: "/thinking" }), false);
});
