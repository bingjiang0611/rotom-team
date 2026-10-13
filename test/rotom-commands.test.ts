import assert from "node:assert/strict";
import { test } from "node:test";
import {
    isKnownNativeCommand,
    isTeamPrompt,
    nativeCommandName,
    normalizeNativePrompt,
} from "../src/server/rotom-executions.ts";
import { nativeBuiltinCommands, nativeSessionManager } from "../src/server/rotom-kernel.ts";

test("native slash admission distinguishes registry commands from model text", () => {
    const commands = [
        { name: "export" },
        { name: "skill:project" },
        { name: "team-kernel-stop-children" },
    ];

    assert.equal(normalizeNativePrompt("\n\t /goal\tstart\nnext line"), "/goal start\nnext line");
    assert.equal(normalizeNativePrompt("/goal\nstatus"), "/goal status");
    assert.equal(normalizeNativePrompt("  ordinary text"), "  ordinary text");
    assert.equal(nativeCommandName("/export .jsonl"), "export");
    assert.equal(nativeCommandName("\n\t  /goal --tokens 1 do it"), "goal");
    assert.equal(isTeamPrompt("\n\t  /export .jsonl"), true);
    assert.equal(isTeamPrompt("/etc/hosts"), true);
    assert.equal(isKnownNativeCommand("ordinary text", commands), true);
    assert.equal(isKnownNativeCommand("/export .jsonl", commands), true);
    assert.equal(isKnownNativeCommand("\n /skill:project explain", commands), true);
    assert.equal(isKnownNativeCommand("/SKILL:project explain", commands), false);
    assert.equal(isKnownNativeCommand("/missing", commands), false);
    assert.equal(isKnownNativeCommand("/team-kernel-stop-children", commands), false);
});

test("builtin catalog is loaded from the pinned native runtime", async () => {
    const commands = await nativeBuiltinCommands();

    assert.ok(commands.length >= 24);
    assert.ok(commands.some((command) => command.name === "compact"));
    assert.ok(commands.some((command) => command.name === "fork"));
});

test("native fork/tree draft extraction preserves string and concatenated text semantics", async () => {
    const { contentText } = await nativeSessionManager();

    assert.equal(contentText("plain", ""), "plain");
    assert.equal(
        contentText(
            [
                { type: "text", text: "FIRST" },
                { type: "image", data: "AA==", mimeType: "image/png" },
                { type: "text", text: "SECOND" },
            ],
            "",
        ),
        "FIRSTSECOND",
    );
    assert.equal(contentText([{ type: "image", data: "AA==", mimeType: "image/png" }], ""), "");
    assert.equal(contentText([], ""), "");
});
