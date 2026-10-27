// Changes without re-reading history: Pi's edits are folded once per entry, and concurrent requests share Git runs
// that started after they arrived.
import {
    type App,
    cleanUp,
    context,
    lastText,
    openApp,
    owner,
    root,
    scriptedModel,
    seedHistoricalSession,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { PiEditLog } from "../src/server/changes.ts";
import { FreshRuns } from "../src/server/fresh-runs.ts";
import type { ClientEntry } from "../src/server/projection.ts";

/** What the fold did before it was kept: set every edit, in order, on one map. */
function reference(entries: readonly ClientEntry[], cwd: string): Map<string, number> {
    const edits = new Map<string, number>();
    const callers = new Map<string, number>();

    for (const entry of entries) {
        if (entry.kind === "assistant") {
            for (const block of entry.blocks) {
                if (block.type !== "toolCall") {
                    continue;
                }

                callers.set(block.id, entry.id);
                const path = block.args.path;

                if (["write", "edit"].includes(block.name) && typeof path === "string" && path) {
                    edits.set(resolve(cwd, path), entry.id);
                }
            }
        } else if (entry.kind === "toolResult" && entry.name === "codemode") {
            for (const call of (entry.details as { calls: Record<string, unknown>[] }).calls) {
                if (
                    ["write", "edit"].includes(call.name as string) &&
                    call.status === "ok" &&
                    typeof call.path === "string" &&
                    call.path
                ) {
                    edits.set(resolve(cwd, call.path), callers.get(entry.callId) ?? entry.id);
                }
            }
        }
    }

    return edits;
}

const call = (id: string, name: string, path: unknown) => ({
    type: "toolCall",
    id,
    name,
    args: { path },
});
const assistant = (id: number, ...blocks: unknown[]) =>
    ({ id, kind: "assistant", blocks }) as unknown as ClientEntry;
const script = (id: number, callId: string, calls: unknown[]) =>
    ({
        id,
        kind: "toolResult",
        callId,
        name: "codemode",
        text: "",
        isError: false,
        details: { calls },
    }) as ClientEntry;

test("the kept fold of Pi's edits gives what folding the whole history did, aliases and scripts included", () => {
    const cwd = "/work/project";
    const entries = [
        assistant(1, call("c1", "write", "b.txt"), call("c2", "read", "z.txt")),
        assistant(2, call("c3", "edit", "./a.txt"), call("c4", "write", "")),
        assistant(3, call("c5", "codemode", undefined)),
        script(4, "c5", [
            { name: "write", status: "ok", path: "c.txt" },
            { name: "write", status: "error", path: "d.txt" },
            { name: "edit", status: "ok", path: "/work/project/b.txt" },
        ]),
        assistant(5, call("c6", "write", "a.txt")),
        script(6, "missing-call", [{ name: "write", status: "ok", path: "../up.txt" }]),
        assistant(7, call("c7", "edit", "sub/../c.txt")),
        assistant(8, call("c8", "write", "./a.txt")),
    ];

    // Every split point: the log is caught up in two parts, as consecutive requests do.
    for (let split = 0; split <= entries.length; split++) {
        const log = new PiEditLog();

        entries.slice(0, split).forEach((entry) => log.add(entry));
        assert.deepEqual(
            [...log.edits(cwd)],
            [...reference(entries.slice(0, split), cwd)],
            `first ${split}`,
        );
        entries.slice(split).forEach((entry) => log.add(entry));
        assert.deepEqual([...log.edits(cwd)], [...reference(entries, cwd)], `after ${split}`);
    }

    assert.deepEqual([...new PiEditLog().edits(cwd)], [], "no history, no edits");
});

test("joined runs never answer with a run that started before the call", async () => {
    const runs = new FreshRuns<number>();
    const releases: (() => void)[] = [];
    let started = 0;

    const work = () => {
        const run = ++started;

        return new Promise<number>((done) => releases.push(() => done(run)));
    };

    const settle = () => new Promise((done) => setImmediate(done));

    const first = runs.run("k", work);

    await settle();
    // Asked while run 1 is going: they share run 2, queued behind it, not run 1.
    const second = runs.run("k", work);
    const third = runs.run("k", work);
    const other = runs.run("other key", work);

    await settle();
    assert.equal(started, 2, "run 1 and the other key's run; run 2 waits for run 1");
    releases.shift()!();
    assert.equal(await first, 1);
    await settle();
    assert.equal(started, 3, "run 2 starts once run 1 is done");
    // Asked while run 2 is going: a new run 3.
    const fourth = runs.run("k", work);

    releases.shift()!();
    assert.equal(await other, 2);
    releases.shift()!();
    assert.deepEqual([await second, await third], [3, 3]);
    await settle();
    releases.shift()!();
    assert.equal(await fourth, 4);
    assert.equal(started, 4);
    await settle();
    assert.equal(runs.size, 0, "idle keys are forgotten");

    const failing = runs.run("k", () => Promise.reject(new Error("git failed")));
    const joined = runs.run("k", async () => 5);

    await assert.rejects(failing, /git failed/);
    assert.equal(await joined, 5, "a failed run does not fail the run queued behind it");
});

const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText("done")]);
    }

    const write = /^write (.+)$/.exec(text);

    if (write) {
        return fauxAssistantMessage(
            [fauxToolCall("write", { path: write[1]!, content: `${write[1]}\n` })],
            { stopReason: "toolUse" },
        );
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

let app: App;
const repo = join(root, "incremental-repo");
const gitIn = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

before(async () => {
    mkdirSync(repo, { recursive: true });
    gitIn("init", "-q");
    gitIn("config", "user.email", "t@example.com");
    gitIn("config", "user.name", "T");
    writeFileSync(join(repo, "base.txt"), "base\n");
    gitIn("add", "-A");
    gitIn("commit", "-qm", "init");
    app = await openApp(scriptedModel(route));
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("Changes reads historical entries while archive edits remain unchanged", async () => {
    const id = await seedHistoricalSession(app, repo);
    const before = await (await app.harness.conversation(id, context))!.entries(
        {},
        100,
        undefined,
        context,
    );

    await assert.rejects(
        app.commands.submit(id, owner(app), {
            text: "write first.txt",
            requestId: "changes-archive",
        }),
        /read-only archive/,
    );
    const changes = await app.workspace.changes(id, owner(app));

    assert.deepEqual(changes.files, []);
    const after = await (await app.harness.conversation(id, context))!.entries(
        {},
        100,
        undefined,
        context,
    );

    assert.deepEqual(after, before);
});
