import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
    mkdtempSync,
    mkdirSync,
    realpathSync,
    rmSync,
    writeFileSync,
    readFileSync,
    existsSync,
    renameSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    MAX_RESUME_CHAIN,
    RotomJournal,
    requireNoPendingKernel,
    type KernelBinding,
    type KernelEntry,
} from "../src/server/rotom-journal.ts";
import { takeLock } from "../src/server/lock.ts";
import { backup, restore, inspectNative } from "../scripts/data.mjs";

function setup() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "kernel-journal-"))),
        data = join(root, "data");

    mkdirSync(data, { mode: 0o700 });
    const home = join(data, "kernel-homes", "alice"),
        workspace = join(root, "workspace");

    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(workspace, { mode: 0o700 });
    const binding: KernelBinding = {
        memberId: "alice",
        kernelVersion: "0.1.14",
        accountGeneration: "grant-1",
        provider: "fixture",
        model: "model-1",
        configurationDigest: "snapshot-1",
        home,
        workspace,
    };

    return { root, data, binding };
}

test("current thinking follows native ancestry without changing immutable receipt bindings", () => {
    const f = setup();
    let journal = new RotomJournal(f.data);

    try {
        journal.bind("native", { ...f.binding, thinkingLevel: "minimal" });
        assert.equal(journal.thinkingLevel("native"), "minimal");
        const run = journal.reserve("native", "thinking", "work");

        journal.attach(run.id, "/tmp/native-thinking.jsonl", "native-id");
        journal.progress(run.id, [
            { id: "high", parentId: null, type: "thinking_level_change", thinkingLevel: "high" },
            { id: "low", parentId: "high", type: "thinking_level_change", thinkingLevel: "low" },
        ]);
        assert.equal(journal.thinkingLevel("native"), "low");
        journal.progress(run.id, [
            { id: "branch", parentId: "high", type: "custom", customType: "branch" },
        ]);
        assert.equal(journal.thinkingLevel("native"), "high", "abandoned branch does not win");
        journal.progress(run.id, [
            { id: "off", parentId: "branch", type: "thinking_level_change", thinkingLevel: "off" },
        ]);
        assert.equal(journal.thinkingLevel("native"), "off");
        assert.equal(journal.receipt(run.id).binding.thinkingLevel, "minimal");
        assert.equal(journal.session("native").binding.thinkingLevel, "minimal");
        journal.close();
        journal = new RotomJournal(f.data);
        assert.equal(journal.thinkingLevel("native"), "off");
        assert.equal(journal.receipt(run.id).status, "unknown");
    } finally {
        journal.close();
        rmSync(f.root, { recursive: true, force: true });
    }
});

test("finalization is durable before readback: restart never turns it into another model request", () => {
    const f = setup();
    let journal = new RotomJournal(f.data);

    try {
        journal.bind("native", f.binding);
        const run = journal.reserve("native", "finalization", "done");

        journal.attach(run.id, "/tmp/native-finalization.jsonl", "native-id", 999999999);
        journal.setPhase(run.id, "finalization");
        assert.throws(() => journal.planResume(run.id), /cannot be resumed/);
        // Simulate a server crash before failure handling or finish can record an outcome.
        journal.close();
        journal = new RotomJournal(f.data);
        assert.equal(journal.receipt(run.id).status, "unknown");
        assert.equal(journal.receipt(run.id).phase, "finalization");
        assert.equal(journal.canResume(run.id), false);
        assert.throws(() => journal.planResume(run.id), /cannot be resumed/);
        assert.throws(() => journal.reserve("native", "retry", "do not replay"), /unknown attempt/);
    } finally {
        journal.close();
        rmSync(f.root, { recursive: true, force: true });
    }
});

test("an execution-phase size-limit failure is fenced even with a dead native PID", () => {
    const f = setup();
    let journal = new RotomJournal(f.data);

    try {
        journal.bind("native", f.binding);
        const run = journal.reserve("native", "large-event", "work");

        journal.attach(run.id, "/tmp/native-large.jsonl", "native-id", 999999999);
        journal.recordFailure(run.id, "rpc-record-limit");
        journal.fail(run.id, "unknown");
        journal.close();
        journal = new RotomJournal(f.data);
        assert.equal(journal.receipt(run.id).failure, "rpc-record-limit");
        assert.equal(inspectNative(f.data).pending?.[0]?.failure, "rpc-record-limit");
        assert.equal(journal.canResume(run.id), false);
        assert.throws(() => journal.planResume(run.id), /cannot be resumed/);
    } finally {
        journal.close();
        rmSync(f.root, { recursive: true, force: true });
    }
});

test("v5 migration fences legacy unknowns while preserving settled shutdown plans", () => {
    const f = setup();
    let journal = new RotomJournal(f.data);

    try {
        journal.bind("native", f.binding);
        const run = journal.reserve("native", "legacy", "work");

        journal.attach(run.id, "/tmp/native-legacy.jsonl", "native-id", 999999999);
        journal.fail(run.id, "unknown");
        journal.bind("clean", f.binding);
        const clean = journal.reserve("clean", "legacy-clean", "work");

        journal.attach(clean.id, "clean.jsonl", "clean-native", 4242);
        journal.planResume(clean.id);
        journal.finish(clean.id, "settled", [response("clean-response")]);
        journal.close();
        const db = new DatabaseSync(join(f.data, "kernel.sqlite"));

        db.exec(
            "ALTER TABLE kernel_attempts DROP COLUMN phase; ALTER TABLE kernel_attempts DROP COLUMN failure; PRAGMA user_version=5;",
        );
        db.close();
        journal = new RotomJournal(f.data);
        assert.equal(journal.receipt(run.id).status, "unknown");
        assert.equal(journal.receipt(run.id).phase, undefined);
        assert.equal(journal.canResume(run.id), false);
        assert.equal(journal.receipt(clean.id).phase, undefined);
        assert.equal(journal.canResume(clean.id), true);
        assert.equal(journal.resume(clean.id)?.state, "pending");
        assert.equal(inspectNative(f.data).version, 6);
    } finally {
        journal.close();
        rmSync(f.root, { recursive: true, force: true });
    }
});

const response = (id: string, provider = "fixture"): KernelEntry => ({
    type: "message",
    id,
    message: {
        role: "assistant",
        provider,
        model: "model-1",
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
        usage: { totalTokens: 12 },
    },
});

test("disabling the backend cannot erase a pending or unknown fence; legacy writer checks the kernel lease", () => {
    const f = setup();
    let journal = new RotomJournal(f.data);

    try {
        journal.bind("native", f.binding);
        const receipt = journal.reserve("native", "pending", "never replay");

        assert.throws(() => takeLock(join(f.data, "harness.lock")), /Kernel writer lease/);
        journal.close();
        assert.equal(existsSync(join(f.data, "kernel.lock")), false);
        assert.throws(() => requireNoPendingKernel(f.data), /pending or unknown/);
        journal = new RotomJournal(f.data);
        assert.equal(journal.pending("alice")?.id, receipt.id);
        assert.equal(journal.pending("alice")?.status, "unknown");
        journal.close();
        assert.throws(() => requireNoPendingKernel(f.data), /pending or unknown/);
    } finally {
        journal.close();
        rmSync(f.root, { recursive: true, force: true });
    }
});

test("durable attempt identity: duplicate intent/unknown never dispatches again after restart", () => {
    const f = setup();
    let journal = new RotomJournal(f.data);

    try {
        journal.bind("conversation-1", f.binding);
        const receipt = journal.reserve("conversation-1", "request-1", "write once");

        assert.equal(journal.reserve("conversation-1", "request-1", "write once").id, receipt.id);
        assert.throws(
            () => journal.reserve("conversation-1", "request-1", "different"),
            /different content/,
        );
        journal.close();
        journal = new RotomJournal(f.data);
        assert.equal(
            journal.reserve("conversation-1", "request-1", "write once").status,
            "unknown",
        );
        assert.throws(
            () => journal.reserve("conversation-1", "request-2", "try again"),
            /unknown attempt/,
        );
        // Another session of the member runs; the unknown attempt still holds back account changes.
        journal.bind("conversation-2", f.binding);
        assert.equal(
            journal.reserve("conversation-2", "new-id", "other work").status,
            "dispatch-intent",
        );
        assert.ok(journal.pending(f.binding.memberId));
    } finally {
        journal.close();
        rmSync(f.root, { recursive: true, force: true });
    }
});

test("response and immutable payer usage are ingested atomically and deduplicated by native entry", () => {
    const f = setup();
    const journal = new RotomJournal(f.data);

    try {
        journal.bind("conversation", f.binding);
        const first = journal.reserve("conversation", "first", "first");

        journal.attach(first.id, join(f.binding.home, "session.jsonl"), "native-session");
        journal.finish(first.id, "settled", [response("one")]);
        const second = journal.reserve("conversation", "second", "second");

        journal.finish(second.id, "settled", [response("one"), response("two")]);
        assert.equal(journal.entries("conversation").length, 2);
        const usage = journal.usage("conversation");

        assert.deepEqual(
            usage.map((row) => [row.memberId, row.attemptId, row.costStatus]),
            [
                ["alice", first.id, "unknown"],
                ["alice", second.id, "unknown"],
            ],
        );
        assert.throws(
            () =>
                journal.bind("conversation", {
                    ...f.binding,
                    accountGeneration: "replacement-grant",
                }),
            /immutable/,
        );
        assert.throws(
            () => journal.bind("foreign", { ...f.binding, memberId: "bob" }),
            /HOME must belong/,
        );
        const third = journal.reserve("conversation", "third", "third");

        assert.throws(
            () =>
                journal.finish(third.id, "settled", [
                    response("three"),
                    response("foreign", "borrowed"),
                ]),
            /payer/,
        );
        assert.equal(journal.entries("conversation").length, 2);
        assert.equal(journal.usage("conversation").length, 2);
        assert.equal(journal.receipt(third.id).status, "dispatch-intent");
        journal.fail(third.id, "unknown");
    } finally {
        journal.close();
        rmSync(f.root, { recursive: true, force: true });
    }
});

test("changed native entry cannot silently rewrite committed history or charge twice", () => {
    const f = setup();
    const journal = new RotomJournal(f.data);

    try {
        journal.bind("conversation", f.binding);
        const first = journal.reserve("conversation", "first", "first");

        journal.attach(first.id, "session.jsonl", "native");
        journal.finish(first.id, "settled", [response("one")]);
        const second = journal.reserve("conversation", "second", "second");

        assert.throws(
            () => journal.finish(second.id, "settled", [{ ...response("one"), label: "changed" }]),
            /changed after ingestion/,
        );
        assert.equal(journal.entries("conversation").length, 1);
        assert.equal(journal.usage("conversation").length, 1);
    } finally {
        journal.close();
        rmSync(f.root, { recursive: true, force: true });
    }
});

test("only known rejection can forget a fresh absent native file", () => {
    const f = setup();
    const journal = new RotomJournal(f.data);

    try {
        journal.bind("conversation", f.binding);
        const first = journal.reserve("conversation", "oversized", "too large");

        journal.attach(first.id, "absent.jsonl", "ephemeral-native");
        journal.fail(first.id, "rejected", true);
        assert.equal(journal.session("conversation").sessionFile, undefined);
        assert.equal(journal.receipt(first.id).status, "rejected");
        const next = journal.reserve("conversation", "valid", "valid");

        journal.attach(next.id, "next.jsonl", "next-native");
        assert.throws(() => journal.fail(next.id, "unknown", true), /Unknown dispatch/);
        assert.equal(journal.session("conversation").kernelSessionId, "next-native");
    } finally {
        journal.close();
        rmSync(f.root, { recursive: true, force: true });
    }
});

test("lexical aliases are rejected before binding rather than poisoning a successful run", () => {
    const f = setup();

    assert.throws(() => new RotomJournal(`${f.data}/.`), /canonical/);
    const journal = new RotomJournal(f.data);

    try {
        for (const workspace of [
            `${f.binding.workspace}/.`,
            `${f.binding.workspace}/../workspace`,
        ]) {
            assert.throws(() => journal.bind("alias", { ...f.binding, workspace }), /canonical/);
            assert.throws(() => journal.session("alias"), /Unknown kernel session/);
        }

        journal.bind("canonical", f.binding);
    } finally {
        journal.close();
        rmSync(f.root, { recursive: true, force: true });
    }
});

test("a fresh handled prompt retains its receipt without binding a nonexistent native file", () => {
    const f = setup();
    const journal = new RotomJournal(f.data);

    try {
        journal.bind("conversation", f.binding);
        const first = journal.reserve("conversation", "handled", "intercepted input");

        journal.attach(first.id, "not-materialized.jsonl", "ephemeral-native");
        journal.finish(first.id, "handled", []);
        assert.equal(
            journal.existing("conversation", "handled", "intercepted input")?.status,
            "handled",
        );
        assert.equal(journal.session("conversation").sessionFile, undefined);
        const next = journal.reserve("conversation", "next", "real prompt");

        journal.attach(next.id, "new-session.jsonl", "materialized-native");
        journal.finish(next.id, "settled", [response("one")]);
        const badClear = journal.reserve("conversation", "bad-clear", "must keep prior history");

        assert.throws(() => journal.finish(badClear.id, "handled", []), /materialized session/);
        assert.equal(journal.session("conversation").kernelSessionId, "materialized-native");
    } finally {
        journal.close();
        rmSync(f.root, { recursive: true, force: true });
    }
});

test("progress journals each finished message of a running prompt, and finish still decides the outcome", () => {
    const f = setup();
    const journal = new RotomJournal(f.data);

    try {
        journal.bind("native", f.binding);
        const run = journal.reserve("native", "run", "work");

        journal.attach(run.id, "session.jsonl", "native-session", 4242);
        const user: KernelEntry = {
            type: "message",
            id: "u1",
            message: { role: "user", content: "work" },
        };

        assert.equal(journal.progress(run.id, [user]), 1);
        assert.equal(journal.progress(run.id, [user]), 0, "a message is recorded once");
        assert.equal(journal.receipt(run.id).status, "dispatch-intent");
        assert.equal(journal.pending("alice")?.id, run.id, "progress keeps the account fenced");
        journal.finish(run.id, "settled", [user, response("a1")]);
        assert.deepEqual(
            journal.entries("native").map(({ entry }) => entry.id),
            ["u1", "a1"],
        );
        assert.throws(() => journal.progress(run.id, [response("late")]), /not an active prompt/);
    } finally {
        journal.close();
        rmSync(f.root, { recursive: true, force: true });
    }
});

test("subagent usage is charged to the run's member while the run is active, never after", () => {
    const f = setup();
    const journal = new RotomJournal(f.data);

    try {
        journal.bind("native", f.binding);
        const run = journal.reserve("native", "run", "work");

        journal.attach(run.id, "session.jsonl", "native-session", 4242);
        journal.childUsage(run.id, { input: 3, output: 2 });
        journal.finish(run.id, "settled", [response("a1")]);
        assert.throws(() => journal.childUsage(run.id, { input: 1 }), /after its run ended/);
        assert.deepEqual(
            journal
                .usage("native")
                .map(({ memberId, raw, subagent }) => ({ memberId, raw, subagent })),
            [
                { memberId: "alice", raw: { totalTokens: 12 }, subagent: undefined },
                { memberId: "alice", raw: { input: 3, output: 2 }, subagent: true },
            ],
        );
    } finally {
        journal.close();
        rmSync(f.root, { recursive: true, force: true });
    }
});

test("an explicitly planned and settled stop retains one bounded continuation across restart", () => {
    const f = setup();
    let journal = new RotomJournal(f.data);

    try {
        journal.bind("native", f.binding);
        const run = journal.reserve("native", "run", "work");

        journal.attach(run.id, "session.jsonl", "native-session", 4242);
        journal.planResume(run.id);
        journal.finish(run.id, "settled", [response("partial")]);
        journal.close();
        journal = new RotomJournal(f.data);
        assert.equal(journal.receipt(run.id).status, "settled");
        assert.equal(journal.pending("alice"), undefined);

        // Each cleanly stopped continuation counts up, until a person has to say Continue.
        let plan = journal.resume(run.id)!;

        assert.deepEqual([plan.chain, plan.state], [1, "pending"]);
        assert.equal(journal.planResume(run.id).chain, 1, "planning twice keeps the first plan");

        for (let chain = 2; chain <= MAX_RESUME_CHAIN + 1; chain++) {
            const next = journal.reserve("native", `alice:#resume-${plan.attemptId}`, "continue");

            plan = journal.planResume(next.id);
            journal.finish(next.id, "settled", [response(`partial-${chain}`)]);
            assert.equal(plan.chain, chain);
        }

        assert.equal(plan.state, "capped");
        assert.deepEqual(
            journal.resumes("pending").map((each) => each.chain),
            [1, 2, 3],
        );
        assert.equal(journal.latest("native")?.id, plan.attemptId);
    } finally {
        journal.close();
        rmSync(f.root, { recursive: true, force: true });
    }
});

test("settlement without a newly persisted terminal response cannot release the attempt", () => {
    const f = setup();
    const journal = new RotomJournal(f.data);

    try {
        journal.bind("conversation", f.binding);
        const receipt = journal.reserve("conversation", "event-before-append", "one request");

        journal.attach(receipt.id, "session.jsonl", "native");
        assert.throws(
            () =>
                journal.finish(receipt.id, "settled", [
                    {
                        type: "message",
                        id: "user-only",
                        message: { role: "user", content: "one request" },
                    },
                ]),
            /no new persisted terminal/,
        );
        assert.equal(journal.entries("conversation").length, 0);
        assert.equal(journal.receipt(receipt.id).status, "dispatch-intent");
        journal.fail(receipt.id, "unknown");
        assert.throws(
            () => journal.reserve("conversation", "different-key", "do not replay"),
            /unknown attempt/,
        );
    } finally {
        journal.close();
        rmSync(f.root, { recursive: true, force: true });
    }
});

test("writer and backup share an exclusion fence; restore strips native grants and gate capabilities", () => {
    const f = setup();
    const journal = new RotomJournal(f.data);

    try {
        assert.throws(() => new RotomJournal(f.data), /EEXIST/);
        assert.throws(() => backup(f.data, join(f.root, "blocked")), /Kernel writer/);
        assert.equal(existsSync(join(f.data, "harness.lock")), false);
        journal.bind("conversation", f.binding);
    } finally {
        journal.close();
    }

    try {
        const agent = join(f.binding.home, ".pi/agent");

        mkdirSync(agent, { recursive: true, mode: 0o700 });
        writeFileSync(join(agent, "auth.json"), '{"fixture":"not-a-real-grant"}', { mode: 0o600 });
        writeFileSync(join(agent, "settings.json"), "{}", { mode: 0o600 });
        mkdirSync(join(f.data, "kernel-gates"), { mode: 0o700 });
        writeFileSync(join(f.data, "kernel-gates", "expired.json"), "{}", { mode: 0o600 });
        backup(f.data, join(f.root, "backup"));
        const manifest = JSON.parse(readFileSync(join(f.root, "backup/manifest.json"), "utf8"));

        assert.ok(
            !manifest.files.some((file: { path: string }) => file.path.startsWith("kernel-gates/")),
        );
        renameSync(f.data, join(f.root, "old"));
        restore(join(f.root, "backup"), f.data);
        assert.equal(existsSync(join(agent, "auth.json")), false);
        assert.equal(existsSync(join(agent, "settings.json")), true);
        const restored = new RotomJournal(f.data);

        assert.equal(restored.session("conversation").binding.memberId, "alice");
        restored.close();
        writeFileSync(join(f.data, "harness.lock"), "2147483647\n");
        assert.throws(() => new RotomJournal(f.data), /offline backup/);
        assert.equal(existsSync(join(f.data, "kernel.lock")), false);
        rmSync(join(f.data, "harness.lock"));
        writeFileSync(join(f.data, "kernel.lock"), "2147483647\n");
        assert.throws(
            () => new RotomJournal(f.data),
            /EEXIST/,
            "dead parent is not proof its tools stopped",
        );
    } finally {
        rmSync(f.root, { recursive: true, force: true });
    }
});

test("queued command intent fences prompt settlement and recovery until confirmed handled", () => {
    const f = setup();
    let journal = new RotomJournal(f.data);

    try {
        journal.bind("native", f.binding);
        const receipt = journal.reserve("native", "owner", "ordinary prompt");

        journal.attach(receipt.id, join(f.binding.home, "session.jsonl"), "native-id", 123);
        const known = journal.beginCommandInput(receipt.id, "/goal pause");

        assert.equal(journal.receipt(receipt.id).unresolvedCommandInput, true);
        assert.throws(() => journal.beginCommandInput(receipt.id, "/another"), /unresolved/);
        journal.completeCommandInput(known);
        assert.equal(journal.receipt(receipt.id).unresolvedCommandInput, undefined);
        journal.beginCommandInput(receipt.id, "/effect-then-error");
        assert.throws(
            () => journal.finish(receipt.id, "settled", [response("answer")]),
            /unresolved/,
        );
        journal.close();
        journal = new RotomJournal(f.data);
        assert.equal(journal.receipt(receipt.id).operation, "prompt");
        assert.equal(journal.receipt(receipt.id).status, "unknown");
        assert.equal(journal.receipt(receipt.id).unresolvedCommandInput, true);
        const inspected = inspectNative(f.data);

        assert.equal(inspected.pending![0]!.operation, "prompt");
        assert.equal(inspected.pending![0]!.unresolvedCommandInput, true);
        assert.ok(!JSON.stringify(inspected).includes("effect-then-error"));
        assert.equal(journal.canResume(receipt.id), false);
        assert.throws(() => journal.planResume(receipt.id), /unresolved/);
        assert.equal(journal.resume(receipt.id), undefined);
        assert.equal(journal.existing("native", "owner", "ordinary prompt")?.id, receipt.id);
    } finally {
        journal.close();
        rmSync(f.root, { recursive: true, force: true });
    }
});
