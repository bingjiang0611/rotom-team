/** Team admits the live native registry while protecting terminal-only account/session operations. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
    supportedTeamCommand,
    teamCommandCatalog,
    teamCommandUsesAdapter,
    teamCommandWebInfo,
    teamCommandInputError,
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

test("every shipped dynamic command has Web guidance without replacing native admission", () => {
    const names = [
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

    for (const name of names) {
        const command = { name, source: "extension" };

        assert.ok(teamCommandWebInfo(command)?.label, name);
        assert.notEqual(teamCommandWebInfo(command)?.label, "Unverified extension", name);
        assert.equal(
            supportedTeamCommand(command),
            true,
            "capability is distinct from native name discovery",
        );
    }

    for (const name of ["future.点", "constructor", "__proto__"]) {
        assert.equal(
            teamCommandWebInfo({ name, source: "extension" })?.label,
            "Unverified extension",
        );
        assert.equal(teamCommandInputError({ name, source: "extension" }, "anything"), undefined);
    }

    assert.equal(teamCommandWebInfo({ name: "llama", source: "prompt" })?.label, "Runs your model");
    assert.equal(teamCommandInputError({ name: "llama", source: "prompt" }), undefined);
    assert.equal(
        teamCommandWebInfo({ name: "skill:test", source: "skill" })?.label,
        "Runs your model",
    );
});

test("known unsupported and argument-dependent paths reject without native no-op success", () => {
    for (const args of ["", "download model", "load model"]) {
        assert.match(
            teamCommandInputError({ name: "llama", source: "extension" }, args)!,
            /local terminal/,
        );
    }

    assert.match(
        teamCommandInputError({ name: "subagents-stop", source: "extension" })!,
        /explicit|run-id/,
    );
    assert.equal(
        teamCommandInputError({ name: "subagents-stop", source: "extension" }, "owned-id"),
        undefined,
    );

    for (const args of [
        "list",
        "enable x",
        "disable x",
        "add x",
        "login x extra",
        "reconnect x extra",
    ]) {
        assert.match(
            teamCommandInputError({ name: "mcp", source: "extension" }, args)!,
            /owner-managed/,
        );
    }

    for (const args of [
        "",
        "login",
        "login fixture",
        "logout fixture",
        "reconnect",
        "reconnect fixture",
    ]) {
        assert.equal(teamCommandInputError({ name: "mcp", source: "extension" }, args), undefined);
    }
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
