// Plan mode: Pi reads and proposes, anything that changes something is blocked, and approving turns it off.
import {
    type App,
    cleanUp,
    context,
    seedHistoricalSession,
    openApp,
    owner,
    scriptedModel,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { PlanDoc, SubagentsDoc } from "../src/server/docs.ts";
import { blockedInPlanMode, commandWords, readOnlyCommand } from "../src/server/extensions/plan.ts";

test("command lines split into words the way bash would, and anything beyond plain words is refused", () => {
    assert.deepEqual(commandWords(`grep -rn "a|b" src | head -5 && echo 'it''s'`), [
        ["grep", "-rn", "a|b", "src"],
        ["head", "-5"],
        ["echo", "its"],
    ]);
    assert.deepEqual(commandWords(`echo "a \\" b \\x" one\\ word; ls`), [
        ["echo", 'a " b \\x', "one word"],
        ["ls"],
    ]);

    for (const refused of [
        "ls > out",
        "cat < in",
        "echo $HOME",
        'echo "$(id)"',
        "echo `id`",
        "ls *.ts",
        "(ls)",
        "ls &",
        "echo 'open",
        "ls \\\nfoo",
        "a=1 ls",
    ]) {
        const words = commandWords(refused);

        assert.ok(words === undefined || !readOnlyCommand(refused), refused);
    }
});

test("only commands that read pass, with arguments that keep them reading", () => {
    const reads = [
        "ls -la ~/src",
        "cat package.json | head -20",
        "cd src && grep -rn TODO .",
        "find . -name '*.ts' -not -path './node_modules/*'",
        "git status",
        "git --no-pager log --oneline -20",
        "git diff HEAD~1 -- src",
        "sort -u names.txt",
        "uniq -c names.txt",
        "rg --glob '*.md' pi",
        "wc -l src/server/app.ts",
        "git log --oneline -- src",
        "sort --check names.txt",
        "printf '%s\\n' a b",
        "test -f package.json",
    ];

    for (const command of reads) {
        assert.equal(readOnlyCommand(command), true, command);
    }

    const changes = [
        "rm -rf build",
        "npm test",
        "git commit -am x",
        "git -c core.pager=evil log",
        "git diff --output=patch.diff",
        "git grep -O foo",
        "find . -name x -delete",
        "find . -exec rm {} +",
        "sort -o out.txt in.txt",
        "sort -no out.txt in.txt",
        "uniq in.txt out.txt",
        "tree -o out.txt",
        "rg --pre ./run.sh foo",
        "fd -x rm",
        "file -C -m magic",
        // Long options shortened, as getopt and git accept them.
        "git grep --open-files-in-pa='touch pwned;' hello",
        "git log --outp=log.txt",
        "git diff --ext",
        "sort --outp=sorted.txt a",
        "sort --compress-program=sh big.txt",
        "sort --compress=sh big.txt",
        "file --comp",
        "printf b | uniq - out.txt",
        "tree -R -H . -L 2",
        "tree -RH .",
        // The subscript of a name runs what it substitutes.
        "printf -v 'a[$(touch pwned)]' x",
        "printf -vname x",
        "test -v 'a[$(touch pwned)]'",
        "sed -i s/a/b/ f",
        "ls && rm x",
        "",
    ];

    for (const command of changes) {
        assert.equal(readOnlyCommand(command), false, command);
    }
});

test("in plan mode only reading tools pass", () => {
    assert.equal(blockedInPlanMode("read", { path: "a" }), undefined);
    assert.equal(blockedInPlanMode("artifact", {}), undefined);
    assert.equal(blockedInPlanMode("codemode", { code: "" }), undefined);
    assert.equal(blockedInPlanMode("subagent", { action: "status" }), undefined);
    assert.equal(blockedInPlanMode("subagent", { action: "stop" }), undefined);
    assert.equal(blockedInPlanMode("bash", { command: "git log" }), undefined);
    assert.match(
        blockedInPlanMode("write", { path: "a", content: "" }) ?? "",
        /^Plan mode is on: The write tool can change things/,
    );
    assert.match(
        blockedInPlanMode("bash", { command: "npm install" }) ?? "",
        /not a simple read-only one/,
    );
    assert.match(blockedInPlanMode("subagent", { action: "spawn" }) ?? "", /blocked/);
    assert.match(
        blockedInPlanMode("schedule", {}) ?? "",
        /blocked/,
        "tools it does not know are blocked too",
    );
});

let app: App;

before(async () => {
    app = await openApp(scriptedModel());
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("legacy plan mutation is rejected without dispatch or file changes", async () => {
    const id = await seedHistoricalSession(app);

    await assert.rejects(app.commands.setPlan(id, owner(app), true), /read-only archive/);
    await assert.rejects(app.commands.approvePlan(id, owner(app)), /read-only archive/);
    assert.equal((await app.harness.snapshot(PlanDoc, id, context))?.on, undefined);
    assert.equal(existsSync(join(work, "planned.txt")), false);
});

test("legacy subagent plan mutation is rejected without creating a child", async () => {
    const id = await seedHistoricalSession(app);

    await assert.rejects(app.commands.setPlan(id, owner(app), true), /read-only archive/);
    assert.deepEqual((await app.harness.snapshot(SubagentsDoc, id, context))?.agents, {});
});

test("legacy plan extension changes remain blocked in archive mode", async () => {
    const id = await seedHistoricalSession(app);

    await assert.rejects(
        app.setExtensionEnabled(owner(app), "plan.ts", false),
        /Agent Extensions only|read-only archive/,
    );
    assert.equal((await app.harness.snapshot(PlanDoc, id, context))?.on, undefined);
});
