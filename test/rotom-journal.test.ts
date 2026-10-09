import assert from "node:assert/strict";
import { test } from "node:test";
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
    RotomJournal,
    requireNoPendingKernel,
    type KernelBinding,
    type KernelEntry,
} from "../src/server/rotom-journal.ts";
import { takeLock } from "../src/server/lock.ts";
import { backup, restore } from "../scripts/data.mjs";

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
        journal.bind("conversation-2", f.binding);
        assert.throws(
            () => journal.reserve("conversation-2", "new-id", "cannot hide unknown"),
            /unknown attempt/,
        );
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
