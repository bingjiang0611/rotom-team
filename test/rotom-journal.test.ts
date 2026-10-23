import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync, StatementSync } from "node:sqlite";
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

test("journal prepares each SQL once, reads fresh values and never reuses a closed connection statement", (t) => {
    const f = setup();
    let journal = new RotomJournal(f.data);
    const original = DatabaseSync.prototype.prepare;
    const prepared: StatementSync[] = [];

    t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
        const statement = original.call(this, sql);

        if (sql === "SELECT 1 FROM kernel_heads WHERE conversation_id=?") {
            prepared.push(statement);
        }

        return statement;
    });

    try {
        assert.equal(journal.hasConversation("cached"), false);
        assert.equal(journal.hasConversation("missing"), false);
        journal.bind("cached", f.binding);
        assert.equal(
            journal.hasConversation("cached"),
            true,
            "cached SQL does not cache query results",
        );
        assert.equal(prepared.length, 1);
        journal.close();
        assert.throws(() => journal.hasConversation("cached"), /not open|closed/i);
        journal = new RotomJournal(f.data);
        assert.equal(journal.hasConversation("cached"), true);
        assert.equal(prepared.length, 2);
        assert.notEqual(prepared[0], prepared[1]);
    } finally {
        journal.close();
        rmSync(f.root, { recursive: true, force: true });
    }
});

test("batch model projection follows current heads and model intents, not immutable identity or old segments", () => {
    const f = setup();
    let journal = new RotomJournal(f.data);

    try {
        assert.equal(journal.modelNames().size, 0);
        journal.bind("a", f.binding);
        journal.bind("b", f.binding);
        const first = journal.reserve("a", "original", "/name first", "command");

        journal.attach(first.id, join(f.root, "first.jsonl"), "first-native");
        journal.finish(first.id, "handled", []);
        const changed = journal.reserve("a", "switch", "/model fixture/model-2", "command", {
            expectedHead: "a",
            binding: { ...f.binding, model: "model-2" },
        });

        assert.deepEqual(
            journal.modelNames(),
            new Map([
                ["a", "model-2"],
                ["b", "model-1"],
            ]),
        );
        assert.equal(journal.receipt(first.id).binding.model, "model-1");
        journal.fail(changed.id, "unknown");
        const next = journal.handoff("b", "handoff", "b", {
            ...f.binding,
            accountGeneration: "grant-2",
            model: "model-3",
        });

        assert.equal(
            journal.modelNames().get("b"),
            "model-1",
            "uncommitted handoff is not the head",
        );
        journal.finish(next.id, "settled", []);
        assert.equal(journal.modelNames().get("b"), "model-3");
        assert.equal(
            journal.modelNames().has(next.segmentId),
            false,
            "only conversation heads are listed",
        );
        journal.close();
        journal = new RotomJournal(f.data);
        assert.deepEqual(
            journal.modelNames(),
            new Map([
                ["a", "model-2"],
                ["b", "model-3"],
            ]),
        );
        assert.equal(journal.receipt(first.id).binding.model, "model-1");
        assert.equal(
            journal.receipt(changed.id).status,
            "unknown",
            "projection never reconciles or replays",
        );
    } finally {
        journal.close();
        rmSync(f.root, { recursive: true, force: true });
    }
});

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

test("optional head session is one fresh read and distinguishes absence from corruption", () => {
    const f = setup();
    let journal = new RotomJournal(f.data);
    const originalGet = StatementSync.prototype.get;
    let headReads = 0;
    let sessionReads = 0;

    const counted = <T>(read: () => T) => {
        headReads = 0;
        sessionReads = 0;

        StatementSync.prototype.get = function (...args) {
            if (/FROM kernel_heads/i.test(this.sourceSQL)) {
                headReads++;
            }

            if (/FROM kernel_sessions/i.test(this.sourceSQL)) {
                sessionReads++;
            }

            return Reflect.apply(originalGet, this, args);
        };

        try {
            return read();
        } finally {
            StatementSync.prototype.get = originalGet;
        }
    };

    try {
        assert.equal(
            counted(() => journal.sessionIfPresent("missing")),
            undefined,
        );
        assert.equal(headReads, 1);
        assert.equal(sessionReads, 0);
        journal.bind("native", f.binding);
        assert.deepEqual(
            counted(() => journal.sessionIfPresent("native")),
            journal.session("native"),
        );
        assert.equal(headReads, 1);
        assert.equal(sessionReads, 0, "the joined read is classified once by its leading table");
        const switched = journal.reserve("native", "switch", "/model model-2", "command", {
            expectedHead: "native",
            binding: { ...f.binding, model: "model-2", thinkingLevel: "high" },
        });
        const file = join(f.binding.home, "session.jsonl");

        journal.attach(switched.id, file, "native-id");
        const current = journal.sessionIfPresent("native")!;

        assert.deepEqual(current, journal.session("native"));
        assert.equal(current.binding.model, "model-2");
        assert.equal(current.binding.thinkingLevel, "high");
        assert.equal(current.sessionFile, file);
        assert.equal(current.kernelSessionId, "native-id");
        current.binding.model = "must-not-mutate-the-next-read";
        assert.equal(journal.sessionIfPresent("native")?.binding.model, "model-2");
        journal.fail(switched.id, "rejected");
        const bobHome = join(f.data, "kernel-homes", "bob");

        mkdirSync(bobHome, { mode: 0o700 });
        const bobBinding = { ...f.binding, memberId: "bob", home: bobHome };
        const handoff = journal.handoff("native", "handoff", "native", bobBinding);

        assert.equal(
            journal.sessionIfPresent("native")?.segmentId,
            "native",
            "uncommitted seed is not the head",
        );
        journal.finish(handoff.id, "settled", []);
        assert.deepEqual(journal.sessionIfPresent("native"), journal.session("native"));
        assert.equal(journal.sessionIfPresent("native")?.segmentId, handoff.segmentId);
        assert.deepEqual(journal.sessionIfPresent("native")?.binding, bobBinding);
        assert.equal(
            journal.segment("native").binding.model,
            "model-2",
            "old segment stays readable",
        );
        journal.close();
        journal = new RotomJournal(f.data);
        assert.deepEqual(journal.sessionIfPresent("native"), journal.session("native"));
        assert.deepEqual(journal.sessionIfPresent("native")?.binding, bobBinding);
        journal.close();
        let db = new DatabaseSync(join(f.data, "kernel.sqlite"));

        db.prepare("UPDATE kernel_sessions SET binding=? WHERE id=?").run(
            "invalid-json",
            handoff.segmentId,
        );
        db.close();
        journal = new RotomJournal(f.data);
        assert.throws(() => journal.sessionIfPresent("native"), SyntaxError);
        assert.throws(() => journal.session("native"), SyntaxError);
        journal.close();
        db = new DatabaseSync(join(f.data, "kernel.sqlite"));
        db.exec("PRAGMA foreign_keys=OFF");
        db.prepare("DELETE FROM kernel_sessions WHERE id=?").run(handoff.segmentId);
        db.close();
        journal = new RotomJournal(f.data);
        assert.equal(journal.hasConversation("native"), true);
        assert.throws(
            () => journal.sessionIfPresent("native"),
            /Unknown kernel session/,
            "a dangling head is corruption, not an initializing conversation",
        );
        assert.throws(() => journal.session("native"), /Unknown kernel session/);
        assert.equal(journal.sessionIfPresent("missing"), undefined);
        assert.throws(() => journal.session("missing"), /Unknown kernel session/);
    } finally {
        StatementSync.prototype.get = originalGet;
        journal.close();
        rmSync(f.root, { recursive: true, force: true });
    }
});

test("entry cursors preserve journal order across foreign rows, handoff seeds and forks", () => {
    const f = setup();
    let journal = new RotomJournal(f.data);
    const entry = (id: string, role: "user" | "assistant" = "assistant"): KernelEntry => ({
        type: "message",
        id,
        message: {
            role,
            ...(role === "assistant"
                ? { provider: f.binding.provider, model: f.binding.model, stopReason: "stop" }
                : {}),
        },
    });

    try {
        journal.bind("shared", f.binding);
        const bobHome = join(f.data, "kernel-homes", "bob");

        mkdirSync(bobHome, { mode: 0o700 });
        const bob = { ...f.binding, memberId: "bob", home: bobHome };

        journal.bind("foreign", f.binding);
        journal.bind("forked", bob);

        const nativeIds = new Map([
            ["shared", "native-alice"],
            ["foreign", "native-foreign"],
            ["forked", "native-fork"],
        ]);
        const sessionFiles = new Map([
            ["shared", "shared.jsonl"],
            ["foreign", "foreign.jsonl"],
            ["forked", "forked.jsonl"],
        ]);

        const append = (
            sessionId: string,
            requestId: string,
            entries: KernelEntry[],
            operation: "prompt" | "fork" = "prompt",
        ) => {
            const run = journal.reserve(sessionId, requestId, requestId, operation);

            journal.attach(run.id, sessionFiles.get(sessionId)!, nativeIds.get(sessionId)!);
            journal.finish(run.id, "settled", entries);

            return run;
        };

        append("shared", "shared-first", [
            entry("shared-first-user", "user"),
            entry("shared-first"),
        ]);
        append("foreign", "foreign-only", [entry("foreign-user", "user"), entry("foreign-answer")]);
        const handoff = journal.handoff("shared", "handoff", "shared", bob);

        journal.attach(handoff.id, "handoff.jsonl", "native-bob");
        journal.finish(handoff.id, "settled", [
            { ...entry("copied-handoff-seed"), customType: "team-kernel-branch" },
        ]);
        nativeIds.set("shared", "native-bob");
        sessionFiles.set("shared", "handoff.jsonl");
        append("shared", "shared-after-handoff", [
            entry("shared-next-user", "user"),
            entry("shared-next"),
        ]);
        append(
            "forked",
            "fork-seed",
            [{ ...entry("included-fork-seed"), customType: "team-kernel-branch" }],
            "fork",
        );
        assert.equal(journal.hasBranchedHistory("shared"), false, "handoff copies are excluded");
        assert.equal(
            journal.hasBranchedHistory("foreign"),
            false,
            "other conversations are excluded",
        );
        assert.equal(journal.hasBranchedHistory("forked"), true, "fork history remains eligible");

        const all = journal.entries("shared");

        assert.deepEqual(
            all.map((row) => row.entry.id),
            ["shared-first-user", "shared-first", "shared-next-user", "shared-next"],
        );
        assert.equal(
            all.some((row) => row.entry.id === "copied-handoff-seed"),
            false,
        );
        assert.equal(journal.entryCursor("shared", 0), 0);
        assert.equal(journal.entriesAfter("shared", 0).length, all.length);
        const prefixCursor = journal.entryCursor("shared", 2);
        const suffix = journal.entriesAfter("shared", prefixCursor);

        assert.ok(suffix[0]!.rowid > prefixCursor);
        assert.equal(typeof suffix[0]!.rowid, "number");
        assert.deepEqual(
            suffix.map((row) => ({
                id: row.entry.id,
                requestId: row.requestId,
                memberId: row.memberId,
            })),
            [
                { id: "shared-next-user", requestId: "shared-after-handoff", memberId: "bob" },
                { id: "shared-next", requestId: "shared-after-handoff", memberId: "bob" },
            ],
        );
        assert.equal(
            journal.entriesAfter("shared", journal.entryCursor("shared", all.length)).length,
            0,
        );
        assert.deepEqual(
            journal
                .entriesAfter("forked", journal.entryCursor("forked", 0))
                .map((row) => row.entry.id),
            ["included-fork-seed"],
        );
        assert.throws(
            () => journal.entryCursor("shared", all.length + 1),
            /exceeds journal history/,
        );
        const beforeRestart = journal.entries("shared");

        journal.close();
        journal = new RotomJournal(f.data);
        assert.deepEqual(
            journal.entries("shared"),
            beforeRestart,
            "the old entries API remains stable after reopen",
        );
        assert.deepEqual(journal.entriesAfter("shared", prefixCursor), suffix);
    } finally {
        journal.close();
        rmSync(f.root, { recursive: true, force: true });
    }
});

test("schema 6 journal indexes drive every hot-path query plan", () => {
    const f = setup();
    let journal = new RotomJournal(f.data);

    try {
        journal.bind("native", f.binding);
        const run = journal.reserve("native", "plan", "plan");

        journal.attach(run.id, "plan.jsonl", "native-id");
        journal.finish(run.id, "settled", [
            { type: "message", id: "plan-user", message: { role: "user" } },
            {
                type: "message",
                id: "plan-answer",
                message: {
                    role: "assistant",
                    provider: f.binding.provider,
                    model: f.binding.model,
                    stopReason: "stop",
                },
            },
        ]);
        journal.close();

        const db = new DatabaseSync(join(f.data, "kernel.sqlite"));
        const plan = (sql: string) =>
            db
                .prepare(`EXPLAIN QUERY PLAN ${sql}`)
                .all()
                .map((row) => String(row.detail));
        const entriesPlan = plan(
            "SELECT e.attempt_id,e.body,a.operation,a.request_id,a.binding FROM kernel_attempts a CROSS JOIN kernel_entries e ON e.attempt_id=a.id WHERE a.conversation_id='native' AND a.operation<>'handoff' ORDER BY e.rowid LIMIT -1 OFFSET 0",
        );
        const afterPlan = plan(
            "SELECT e.rowid,e.attempt_id,e.body,a.operation,a.request_id,a.binding FROM kernel_attempts a CROSS JOIN kernel_entries e ON e.attempt_id=a.id WHERE a.conversation_id='native' AND a.operation<>'handoff' AND e.rowid>0 ORDER BY e.rowid",
        );
        const usagePlan = plan(
            "SELECT u.* FROM kernel_usage u JOIN kernel_attempts a ON a.id=u.attempt_id WHERE a.conversation_id='native' ORDER BY u.rowid",
        );
        const creditsPlan = plan(
            "SELECT a.id,a.session_id,a.binding,a.status,s.kernel_session_id,e.body FROM kernel_attempts a JOIN kernel_sessions s ON s.id=a.session_id LEFT JOIN kernel_entries e ON e.attempt_id=a.id AND json_extract(e.body,'$.customType')='qoder-credits' WHERE a.conversation_id='native' AND a.operation IN ('prompt','compact','command') ORDER BY a.rowid,e.rowid",
        );
        const terminalPlan = plan(
            "SELECT body FROM kernel_entries WHERE attempt_id='plan' ORDER BY rowid",
        );
        const segmentPlan = plan(
            "SELECT body FROM kernel_entries WHERE session_id='native' ORDER BY rowid",
        );
        const indexes = db
            .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'kernel_%'")
            .all()
            .map((row) => String(row.name));

        assert.equal(Number(db.prepare("PRAGMA user_version").get()!.user_version), 6);
        assert.deepEqual(indexes.sort(), [
            "kernel_child_usage_attempt",
            "kernel_entries_attempt",
            "kernel_entries_session",
            "kernel_usage_attempt",
        ]);

        for (const details of [entriesPlan, afterPlan, usagePlan]) {
            assert.match(details[0]!, /SEARCH a USING INDEX one_conversation_request/);
            assert.match(details[1]!, /SEARCH (e|u) USING INDEX kernel_(entries|usage)_attempt/);
            assert.ok(!details.some((detail) => /SCAN e\b/.test(detail)), details.join("; "));
        }

        assert.match(creditsPlan[0]!, /SEARCH a USING INDEX one_conversation_request/);
        assert.ok(
            creditsPlan.some((detail) =>
                /SEARCH e USING INDEX kernel_entries_attempt/.test(detail),
            ),
        );
        assert.ok(!creditsPlan.some((detail) => /SCAN e\b/.test(detail)), creditsPlan.join("; "));
        assert.match(segmentPlan[0]!, /SEARCH kernel_entries USING INDEX kernel_entries_session/);
        assert.match(terminalPlan[0]!, /SEARCH kernel_entries USING INDEX kernel_entries_attempt/);
        db.close();
    } finally {
        journal.close();
        rmSync(f.root, { recursive: true, force: true });
    }
});

test("history suffix reads preserve ordering, bindings and restart without replaying the prefix", () => {
    const f = setup();
    let journal = new RotomJournal(f.data);

    try {
        journal.bind("native", f.binding);
        const run = journal.reserve("native", "suffix", "work");

        journal.attach(run.id, "/tmp/native-suffix.jsonl", "suffix-id");
        journal.progress(run.id, [
            { id: "first", parentId: null, type: "message", message: { role: "user" } },
            { id: "second", parentId: "first", type: "custom", customType: "team-kernel-branch" },
        ]);
        const prefix = journal.entries("native");

        assert.deepEqual(journal.entries("native", 1), prefix.slice(1));
        assert.deepEqual(journal.entries("native", prefix.length), []);
        assert.deepEqual(journal.entries("native", prefix.length + 1), []);
        journal.progress(run.id, [{ id: "third", parentId: "second", type: "custom" }]);
        const suffix = journal.entries("native", prefix.length);

        assert.equal(suffix.length, 1);
        assert.equal(suffix[0]!.entry.id, "third");
        assert.equal(suffix[0]!.memberId, f.binding.memberId);
        assert.deepEqual([...prefix, ...suffix], journal.entries("native"));
        journal.close();
        journal = new RotomJournal(f.data);
        assert.deepEqual(journal.entries("native", prefix.length), suffix);
        assert.equal(journal.receipt(run.id).status, "unknown");
        assert.throws(() => journal.entries("native", -1), RangeError);
        assert.throws(() => journal.entries("native", 0.5), RangeError);
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

test("native auxiliary model usage is payer-bound, atomic and deduplicated", () => {
    const f = setup();
    const journal = new RotomJournal(f.data);

    try {
        journal.bind("native", f.binding);
        const run = journal.reserve("native", "reducer", "work");
        const entry: KernelEntry = {
            id: "reducer-usage",
            parentId: null,
            type: "usage",
            kind: "sol_pi_reducer",
            provider: f.binding.provider,
            model: f.binding.model,
            usage: { totalTokens: 17 },
        };

        journal.attach(run.id, "/tmp/native-reducer.jsonl", "native-id");
        assert.throws(
            () => journal.progress(run.id, [entry, { ...entry, id: "foreign", model: "other" }]),
            /Native response model does not match admitted payer\/model/,
        );
        assert.equal(journal.entries("native").length, 0, "invalid snapshot rolls back entries");
        assert.equal(journal.usage("native").length, 0, "invalid snapshot rolls back charges");
        assert.equal(journal.progress(run.id, [entry]), 1);
        assert.equal(journal.progress(run.id, [entry]), 0);
        assert.deepEqual(
            journal.usage("native").map((row) => [row.memberId, row.attemptId, row.raw]),
            [["alice", run.id, { totalTokens: 17 }]],
        );
        assert.throws(
            () =>
                journal.progress(run.id, [{ ...entry, id: "foreign-provider", provider: "other" }]),
            /Native response model does not match admitted payer\/model/,
        );
        journal.finish(run.id, "settled", [entry, response("done")]);
        assert.equal(journal.usage("native").length, 2, "reducer and response each charged once");
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

test("latest and pending read one complete receipt row and preserve fresh fences after restart", () => {
    const f = setup();
    let journal = new RotomJournal(f.data);
    const originalGet = StatementSync.prototype.get;
    let attemptReads = 0;
    let fenceReads = 0;

    const counted = <T>(read: () => T) => {
        attemptReads = 0;
        fenceReads = 0;

        StatementSync.prototype.get = function (...args) {
            if (/FROM kernel_attempts/i.test(this.sourceSQL)) {
                attemptReads++;
            }

            if (/FROM kernel_command_inputs/i.test(this.sourceSQL)) {
                fenceReads++;
            }

            return Reflect.apply(originalGet, this, args);
        };

        try {
            return read();
        } finally {
            StatementSync.prototype.get = originalGet;
        }
    };

    try {
        journal.bind("native", f.binding);
        assert.equal(
            counted(() => journal.latest("native")),
            undefined,
        );
        assert.equal(attemptReads, 1);
        assert.equal(fenceReads, 0);
        assert.equal(
            counted(() => journal.pendingConversation("native")),
            undefined,
        );
        assert.equal(attemptReads, 1);
        assert.equal(fenceReads, 0);
        const prior = journal.reserve("native", "prior", "rejected prompt");

        journal.fail(prior.id, "rejected");
        assert.equal(journal.latest("native")?.id, prior.id);
        assert.equal(
            counted(() => journal.pendingConversation("native")),
            undefined,
        );
        assert.equal(attemptReads, 1, "a known rejection is not a pending fence");
        assert.equal(fenceReads, 0);
        const first = journal.reserve("native", "first", "ordinary");

        journal.attach(first.id, join(f.binding.home, "session.jsonl"), "native-id", 123);
        const input = journal.beginCommandInput(first.id, "/queued");
        const expected = journal.receipt(first.id);

        assert.deepEqual(
            counted(() => journal.latest("native")),
            expected,
        );
        assert.equal(attemptReads, 1);
        assert.equal(fenceReads, 1, "full receipt still checks unresolved input");
        assert.deepEqual(
            counted(() => journal.pendingConversation("native")),
            expected,
        );
        assert.equal(attemptReads, 1);
        assert.equal(fenceReads, 1);
        journal.completeCommandInput(input);
        assert.equal(journal.latest("native")?.unresolvedCommandInput, undefined);
        assert.equal(journal.pendingConversation("native")?.unresolvedCommandInput, undefined);
        journal.setPhase(first.id, "finalization");
        journal.recordFailure(first.id, "rpc-record-limit");
        journal.fail(first.id, "unknown");
        const failed = journal.receipt(first.id);

        assert.deepEqual(journal.latest("native"), failed);
        assert.deepEqual(journal.pendingConversation("native"), failed);
        assert.equal(failed.phase, "finalization");
        assert.equal(failed.failure, "rpc-record-limit");
        const bobHome = join(f.data, "kernel-homes", "bob");

        mkdirSync(bobHome, { mode: 0o700 });
        journal.bind("other", { ...f.binding, memberId: "bob", home: bobHome });
        const second = journal.reserve("other", "second", "another");

        assert.notEqual(second.id, first.id);
        assert.equal(journal.latest("native")?.id, first.id, "lookup is conversation scoped");
        assert.equal(journal.pendingConversation("native")?.id, first.id);
        journal.close();
        journal = new RotomJournal(f.data);
        assert.deepEqual(
            counted(() => journal.latest("native")),
            failed,
        );
        assert.equal(attemptReads, 1);
        assert.equal(fenceReads, 1);
        assert.deepEqual(
            counted(() => journal.pendingConversation("native")),
            failed,
        );
        assert.equal(attemptReads, 1);
        assert.equal(fenceReads, 1);
        assert.throws(() => journal.receipt("missing"), /Unknown kernel receipt/);
    } finally {
        StatementSync.prototype.get = originalGet;
        journal.close();
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
