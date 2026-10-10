import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { RotomExecutions } from "../src/server/rotom-executions.ts";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    RotomJournal,
    KernelRequestConflict,
    requireNoPendingKernel,
    type KernelBinding,
    type KernelEntry,
} from "../src/server/rotom-journal.ts";

function setup(t: TestContext) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "kernel-lifecycle-")));
    const data = join(root, "data"),
        workspace = join(root, "workspace");

    mkdirSync(data, { mode: 0o700 });
    mkdirSync(workspace, { mode: 0o700 });
    const f = {
        root,
        data,
        journal: new RotomJournal(data),
        member(name: string): KernelBinding {
            const home = join(data, "kernel-homes", name);

            mkdirSync(home, { recursive: true, mode: 0o700 });

            return {
                memberId: name,
                kernelVersion: "0.1.14",
                provider: "fixture",
                model: "model",
                accountGeneration: `grant-${name}`,
                configurationDigest: "frozen",
                home,
                workspace,
            };
        },
    };

    t.after(() => {
        f.journal.close();
        rmSync(root, { recursive: true, force: true });
    });

    return f;
}

const response = (id: string, provider = "fixture"): KernelEntry => ({
    type: "message",
    id,
    message: {
        role: "assistant",
        provider,
        model: "model",
        stopReason: "stop",
        content: [{ type: "text", text: "done" }],
        usage: { totalTokens: 12 },
    },
});

test("a handoff during asynchronous admission cannot reserve Bob while launching Alice", async (t) => {
    const f = setup(t),
        alice = f.member("alice"),
        bob = f.member("bob");

    f.journal.close();
    const admission = Promise.withResolvers<void>();
    const executions = new RotomExecutions(f.data, async () => admission.promise);

    f.journal = executions.journal;
    f.journal.bind("shared", alice);
    const pending = executions.run("shared", "stale-request", "must not dispatch");
    const handoff = f.journal.handoff("shared", "takeover", "shared", bob);

    f.journal.finish(handoff.id, "settled", []);
    admission.resolve();
    await assert.rejects(
        pending,
        (error: unknown) =>
            error instanceof KernelRequestConflict &&
            /head changed during admission/.test(error.message),
    );
    assert.equal(f.journal.receipts("shared").length, 1);
    assert.equal(f.journal.existing("shared", "stale-request", "must not dispatch"), undefined);
    executions.close();
});

for (const operation of ["prompt", "compact", "handoff", "fork"] as const) {
    test(`Stop during ${operation} admission prevents a new intent or materialization`, async (t) => {
        const f = setup(t),
            alice = f.member("alice"),
            bob = f.member("bob");

        f.journal.close();
        const admission = Promise.withResolvers<void>();
        const executions = new RotomExecutions(f.data, async () => admission.promise);

        f.journal = executions.journal;
        f.journal.bind("shared", alice);
        f.journal.bind("target", bob);
        const pending =
            operation === "prompt"
                ? executions.run("shared", "stopped", "Do not dispatch")
                : operation === "compact"
                  ? executions.compact("shared", "stopped")
                  : operation === "handoff"
                    ? executions.handoff("shared", "stopped", "shared", bob)
                    : executions.fork("shared", "target", "stopped", "shared");

        assert.throws(() => executions.close(), /still active/);
        await executions.abort(operation === "fork" ? "target" : "shared");
        admission.resolve();
        await assert.rejects(pending, KernelRequestConflict);
        assert.equal(f.journal.receipts("shared").length, 0);
        assert.equal(f.journal.receipts("target").length, 0);
        assert.equal(f.journal.session("shared").segmentId, "shared");
        assert.equal(f.journal.session("shared").sessionFile, undefined);
        assert.equal(f.journal.session("target").sessionFile, undefined);
        executions.close();
    });
}

test("busy and unknown fences reject a new identity as a known conflict without allocating it", (t) => {
    const f = setup(t);

    f.journal.bind("shared", f.member("alice"));
    const first = f.journal.reserve("shared", "first", "already running");

    for (const status of ["dispatch-intent", "unknown"] as const) {
        if (status === "unknown") {
            f.journal.fail(first.id, "unknown");
        }

        assert.throws(
            () => f.journal.reserve("shared", "second", "must not run"),
            KernelRequestConflict,
        );
        assert.equal(f.journal.request("shared", "second"), undefined);
        assert.equal(f.journal.receipt(first.id).status, status);
    }
});

test("handoff commits a new head atomically without rewriting receipts or rebilling inherited usage", (t) => {
    const f = setup(t),
        j = f.journal,
        alice = f.member("alice"),
        bob = f.member("bob");

    j.bind("shared", alice);
    const original = j.reserve("shared", "alice:first", "first");

    j.attach(original.id, "alice.jsonl", "native-alice");
    j.finish(original.id, "settled", [response("alice-reply")]);
    const handoff = j.handoff("shared", "bob:takeover", "shared", bob);

    assert.equal(handoff.sessionId, "shared");
    assert.notEqual(handoff.segmentId, "shared");
    assert.equal(j.session("shared").segmentId, "shared");
    assert.throws(() => j.reserve("shared", "alice:race", "race"), /running or unknown/);
    j.bind("bob-other", bob);
    assert.throws(() => j.reserve("bob-other", "bob:race", "race"), /running or unknown/);
    j.attach(handoff.id, "bob.jsonl", "native-bob");
    const seed = response("inherited", "team-public-history");

    j.finish(handoff.id, "settled", [seed]);
    assert.equal(j.session("shared").segmentId, handoff.segmentId);
    assert.equal(j.session("shared").binding.memberId, "bob");
    assert.equal(j.segment("shared").binding.memberId, "alice");
    assert.deepEqual(j.segmentEntries(handoff.segmentId), [seed]);
    assert.equal(j.entries("shared").length, 1, "do not duplicate handoff seed in shared history");
    assert.equal(j.usage("shared").length, 1, "historical usage is not a Bob charge");
    const next = j.reserve("shared", "bob:next", "next");

    j.finish(next.id, "settled", [seed, response("bob-reply")]);
    assert.deepEqual(
        j.usage("shared").map((row) => row.memberId),
        ["alice", "bob"],
    );
    assert.equal(j.entries("shared").length, 2);
    assert.equal(j.receipts("shared").length, 3);
    assert.equal(j.reserve("shared", "alice:first", "first").id, original.id);
    assert.equal(j.handoff("shared", "bob:takeover", "shared", bob).id, handoff.id);
    assert.equal(j.receipt(original.id).binding.memberId, "alice");
    assert.throws(() => j.handoff("shared", "stale", "shared", alice), /head changed/);
    assert.throws(() => j.reserve("shared", "bob:next", "next", "compact"), /different content/);
    f.journal.close();
    f.journal = new RotomJournal(f.data);
    assert.equal(f.journal.session("shared").binding.memberId, "bob");
    assert.deepEqual(
        f.journal.usage("shared").map((row) => row.memberId),
        ["alice", "bob"],
    );
});

test("interrupted seed keeps the old head and fences both conversation and destination HOME after restart", (t) => {
    const f = setup(t),
        alice = f.member("alice"),
        bob = f.member("bob");

    f.journal.bind("shared", alice);
    const receipt = f.journal.handoff("shared", "takeover", "shared", bob);

    f.journal.close();
    assert.throws(() => requireNoPendingKernel(f.data), /pending or unknown/);
    f.journal = new RotomJournal(f.data);
    assert.equal(f.journal.handoff("shared", "takeover", "shared", bob).status, "unknown");
    assert.equal(f.journal.session("shared").binding.memberId, "alice");
    assert.equal(f.journal.pending("bob")?.id, receipt.id);
    assert.throws(() => f.journal.reserve("shared", "new-id", "no bypass"), /unknown attempt/);
    f.journal.bind("bob-other", bob);
    assert.throws(() => f.journal.reserve("bob-other", "new-id", "no bypass"), /unknown attempt/);
    assert.throws(
        () => f.journal.handoff("shared", "new-handoff", "shared", alice),
        /unknown attempt/,
    );
});

test("empty handoff needs no fabricated assistant or absent resume-file binding; rejected seed never switches head", (t) => {
    const f = setup(t),
        j = f.journal,
        alice = f.member("alice"),
        bob = f.member("bob");

    j.bind("shared", alice);
    const rejected = j.handoff("shared", "rejected", "shared", bob);

    j.fail(rejected.id, "rejected");
    assert.equal(j.session("shared").binding.memberId, "alice");
    const empty = j.handoff("shared", "empty", "shared", bob);

    j.finish(empty.id, "settled", []);
    assert.equal(j.session("shared").binding.memberId, "bob");
    assert.equal(j.session("shared").sessionFile, undefined);
    assert.equal(j.usage("shared").length, 0);
    assert.equal(j.reserve("shared", "first-real-request", "now start").binding.memberId, "bob");
});

test("fork seed is visible context but not billed; compaction requires its own persisted result and preserves unknown usage", (t) => {
    const f = setup(t),
        j = f.journal,
        bob = f.member("bob");

    j.bind("fork", bob);
    const fork = j.reserve("fork", "fork-seed", "public source digest", "fork");

    j.attach(fork.id, "fork.jsonl", "native-fork");
    const inherited = response("inherited", "team-public-history");

    j.finish(fork.id, "settled", [inherited]);
    assert.equal(j.entries("fork").length, 1);
    assert.equal(j.usage("fork").length, 0);
    assert.throws(() => j.reserve("fork", "reseed", "bad", "fork"), /fresh/);
    const compact = j.reserve("fork", "compact", "summarize", "compact");

    assert.throws(
        () => j.finish(compact.id, "settled", [inherited, response("not-a-compaction")]),
        /terminal response/,
    );
    assert.equal(j.usage("fork").length, 0, "failed ingestion rolls back atomically");
    const summary = {
        type: "compaction",
        id: "summary",
        summary: "public summary",
        firstKeptEntryId: "inherited",
        tokensBefore: 1000,
    };

    j.finish(compact.id, "settled", [inherited, summary]);
    assert.deepEqual(j.usage("fork"), [
        { memberId: "bob", attemptId: compact.id, raw: null, costStatus: "unknown" },
    ]);
    assert.equal(j.reserve("fork", "compact", "summarize", "compact").id, compact.id);
});

test("cross-store reconciliation discards only untouched orphan bindings and preserves all execution evidence atomically", (t) => {
    const f = setup(t),
        j = f.journal,
        alice = f.member("alice");

    j.bind("kept", alice);
    j.bind("abandoned-create", alice);
    j.reconcileOrphans(new Set(["kept"]));
    assert.equal(j.hasConversation("kept"), true);
    assert.equal(j.hasConversation("abandoned-create"), false);
    j.bind("empty-orphan", alice);
    j.bind("execution-orphan", alice);
    const attempt = j.reserve("execution-orphan", "intent", "never replay");

    assert.throws(() => j.reconcileOrphans(new Set(["kept"])), /without application metadata/);
    assert.equal(j.hasConversation("empty-orphan"), true);
    assert.equal(j.hasConversation("execution-orphan"), true);
    assert.equal(j.receipt(attempt.id).status, "dispatch-intent");
});

test("native credit subtotals preserve payer, conflicts and absent metering without charging seeds", (t) => {
    const f = setup(t),
        j = f.journal;
    const alice = { ...f.member("alice"), provider: "qoder" },
        bob = { ...f.member("bob"), provider: "qoder" };
    const credit = (id: string, requestId: string, credits: number, extra = {}): KernelEntry => ({
        id,
        type: "custom",
        customType: "qoder-credit-observation-v1",
        data: {
            version: 1,
            sessionId: "native-alice",
            modelId: "model",
            requestId,
            status: "reported",
            outcome: "complete",
            credits,
            billable: true,
            ...extra,
        },
    });

    j.bind("shared", alice);
    const first = j.reserve("shared", "first", "first");

    j.attach(first.id, "alice.jsonl", "native-alice");
    j.finish(first.id, "settled", [
        response("reply", "qoder"),
        credit("c1", "one", 0.25),
        credit("c2", "one", 0.25),
        credit("c3", "conflict", 1),
        credit("c4", "conflict", 2),
        credit("c5", "free", 3, { billable: false }),
        credit("c6", "aborted", 9, { status: "unknown", outcome: "aborted" }),
    ]);
    assert.deepEqual(j.credits("shared"), [
        {
            segmentId: "shared",
            memberId: "alice",
            credits: 0.25,
            reported: 2,
            unknown: 2,
            unmeteredOperations: 0,
            partial: true,
        },
    ]);
    const handoff = j.handoff("shared", "handoff", "shared", bob);

    j.attach(handoff.id, "bob.jsonl", "native-bob");
    j.finish(handoff.id, "settled", [response("seed")]);
    assert.equal(j.credits("shared").length, 1);
    const next = j.reserve("shared", "no-metering", "next");

    j.finish(next.id, "settled", [response("bob-reply", "qoder")]);
    assert.deepEqual(j.credits("shared")[1], {
        segmentId: handoff.segmentId,
        memberId: "bob",
        credits: null,
        reported: 0,
        unknown: 0,
        unmeteredOperations: 1,
        partial: true,
    });
    j.bind("fork", alice);
    const fork = j.reserve("fork", "fork", "source", "fork");

    j.attach(fork.id, "fork.jsonl", "native-fork");
    j.finish(fork.id, "settled", [response("seed"), credit("historical", "old", 100)]);
    assert.deepEqual(j.credits("fork"), []);
});

test("schema-1 migration preserves bindings, hashes, receipts and usage, including the disabled-backend fence", (t) => {
    const f = setup(t);

    f.journal.bind("legacy", f.member("alice"));
    const settled = f.journal.reserve("legacy", "old-request", "old prompt");

    f.journal.attach(settled.id, "old.jsonl", "old-native");
    f.journal.finish(settled.id, "settled", [response("old-reply")]);
    const pending = f.journal.reserve("legacy", "old-pending", "pending prompt");

    f.journal.close();
    const db = new DatabaseSync(join(f.data, "kernel.sqlite"));

    try {
        // Reconstruct the previous schema with real persisted rows, not a mock migration result.
        db.exec(`DROP TABLE kernel_heads; DROP TABLE kernel_resume; DROP TABLE kernel_child_usage;
            ALTER TABLE kernel_attempts DROP COLUMN pid;
            DROP INDEX one_conversation_request; DROP INDEX one_conversation_writer;
            ALTER TABLE kernel_attempts DROP COLUMN conversation_id;
            ALTER TABLE kernel_attempts DROP COLUMN operation;
            ALTER TABLE kernel_sessions DROP COLUMN conversation_id;
            ALTER TABLE kernel_sessions DROP COLUMN parent_segment_id;
            PRAGMA user_version=1;`);
    } finally {
        db.close();
    }

    assert.throws(() => requireNoPendingKernel(f.data), /pending or unknown/);
    f.journal = new RotomJournal(f.data);
    assert.equal(f.journal.session("legacy").segmentId, "legacy");
    assert.equal(f.journal.existing("legacy", "old-request", "old prompt")?.id, settled.id);
    assert.equal(f.journal.receipt(pending.id).status, "unknown");
    assert.equal(f.journal.receipt(settled.id).operation, "prompt");
    assert.equal(f.journal.usage("legacy").length, 1);
    assert.equal(f.journal.entries("legacy").length, 1);
});
