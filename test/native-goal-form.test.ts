/** Compare form encoding/budgets directly to the pinned Goal parser, without starting an account. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

const web = readFileSync(new URL("../web/sheets/native-goal.js", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "")
    .replace(/^export /gm, "");
const { validGoalBudget, quoteGoalObjective } = new Function(
    `${web}\nreturn {validGoalBudget, quoteGoalObjective};`,
)();
const source = readFileSync(
    new URL(
        "../runtime/rotom/node_modules/@bingjiang0611/rotom/extensions/third-party/node_modules/@narumitw/pi-goal/src/command.ts",
        import.meta.url,
    ),
    "utf8",
);
const native = new Function(
    `${stripTypeScriptTypes(source).replace(/^export /gm, "")}\nreturn {parseCommand, parseTokenBudget, isRemovedQueueCommand};`,
)();

test("Goal form token budgets match the actual native parser", () => {
    for (const budget of [
        "100k",
        "1M",
        "25000",
        "1.5k",
        "0.001k",
        " 200 ",
        "2.5",
        "0",
        "0.0001k",
        "-1",
        "NaN",
        "Infinity",
        "1e3",
        "2mb",
        ".5k",
        "",
        "9007199254740991",
        "9007199254740992",
    ]) {
        assert.equal(
            validGoalBudget(budget),
            native.parseTokenBudget(budget) !== undefined,
            budget,
        );
    }
});

test("literal form objectives preserve quotes/newlines and cannot become native control commands", () => {
    for (const objective of [
        "add regression tests",
        "clear old caches",
        "edit the settings",
        "--tokens 0 should be documented",
        `It's a \"quoted\" objective`,
        "first line\nsecond line",
        `a'b'c`,
        `\"double\" and 'single'`,
    ]) {
        const encoded = quoteGoalObjective(objective);
        const parsed = native.parseCommand(encoded);

        assert.equal(parsed.kind, "start", objective);
        assert.equal(parsed.objective, objective);
        assert.equal(native.isRemovedQueueCommand(encoded), false);
    }

    // Single-word reserved objectives need an explicit budget; the form blocks the ambiguous unbudgeted case.
    assert.equal(native.parseCommand(quoteGoalObjective("clear")).kind, "clear");
    assert.deepEqual(native.parseCommand(`--tokens 100k ${quoteGoalObjective("clear")}`), {
        kind: "start",
        objective: "clear",
        tokenBudget: 100000,
    });
    assert.deepEqual(native.parseCommand(`edit ${quoteGoalObjective("clear")}`), {
        kind: "edit",
        objective: "clear",
        tokenBudget: undefined,
    });
});
