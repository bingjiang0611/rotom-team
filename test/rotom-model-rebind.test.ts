import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    KernelRequestConflict,
    RotomJournal,
    type KernelBinding,
} from "../src/server/rotom-journal.ts";

test("an own model change keeps the segment and its immutable identity anchor", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "kernel-rebind-"))),
        data = join(root, "data");

    mkdirSync(data, { mode: 0o700 });
    const workspace = join(root, "workspace");

    for (const member of ["alice", "bob"]) {
        mkdirSync(join(data, "kernel-homes", member), { recursive: true, mode: 0o700 });
    }

    mkdirSync(workspace, { mode: 0o700 });
    const original: KernelBinding = {
        memberId: "alice",
        kernelVersion: "0.1.14",
        accountGeneration: "grant-1",
        provider: "fixture",
        model: "model-1",
        configurationDigest: "snapshot-1",
        home: join(data, "kernel-homes", "alice"),
        workspace,
    };
    const model = (name: string): KernelBinding => ({ ...original, model: name });
    const rebind = (journal: RotomJournal, requestId: string, binding: KernelBinding) =>
        journal.reserve(
            "native",
            requestId,
            `/model ${binding.accountGeneration}/${binding.model}`,
            "command",
            { expectedHead: "native", binding },
        );
    let journal = new RotomJournal(data);

    try {
        journal.bind("native", original);
        const switched = rebind(journal, "model-2", model("model-2"));

        assert.equal(switched.segmentId, "native");
        assert.equal(switched.binding.model, "model-2");
        journal.attach(switched.id, join(root, "native.jsonl"), "native-id");
        journal.finish(switched.id, "handled", [
            { id: "change", parentId: null, type: "model_change", modelId: "model-2" },
        ]);
        assert.equal(journal.session("native").binding.model, "model-2");
        assert.equal(journal.session("native").kernelSessionId, "native-id");

        // Startup re-binds with the original setup identity; that must still be accepted.
        journal.close();
        journal = new RotomJournal(data);
        journal.bind("native", original);
        assert.equal(journal.session("native").binding.model, "model-2", "survives restart");

        const before = journal.session("native").binding;
        const rejected = rebind(journal, "model-3", model("model-3"));

        assert.equal(journal.session("native").binding.model, "model-3");
        journal.fail(rejected.id, "rejected", false, before);
        assert.equal(journal.session("native").binding.model, "model-2", "rejected restores");

        const toOriginal = rebind(journal, "model-1", original);

        journal.fail(toOriginal.id, "rejected", false, original);
        assert.deepEqual(journal.session("native").binding, original);

        assert.throws(
            () =>
                rebind(journal, "payer", {
                    ...original,
                    memberId: "bob",
                    home: join(data, "kernel-homes", "bob"),
                }),
            KernelRequestConflict,
        );
        assert.throws(
            () =>
                journal.reserve("native", "stale", "/model grant-1/model-5", "command", {
                    expectedHead: "elsewhere",
                    binding: model("model-5"),
                }),
            KernelRequestConflict,
        );
        assert.deepEqual(journal.session("native").binding, original, "refusals change nothing");

        const unknown = rebind(journal, "model-4", model("model-4"));

        journal.fail(unknown.id, "unknown", false, original);
        assert.equal(journal.session("native").binding.model, "model-4", "unknown keeps it");
    } finally {
        journal.close();
        rmSync(root, { recursive: true, force: true });
    }
});

test("a kernel upgrade keeps the payer's native session and its identity anchor", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "kernel-upgrade-"))),
        data = join(root, "data");

    mkdirSync(data, { mode: 0o700 });
    const workspace = join(root, "workspace");

    mkdirSync(join(data, "kernel-homes", "alice"), { recursive: true, mode: 0o700 });
    mkdirSync(workspace, { mode: 0o700 });
    const original: KernelBinding = {
        memberId: "alice",
        kernelVersion: "0.1.25",
        accountGeneration: "grant-1",
        provider: "fixture",
        model: "model-1",
        configurationDigest: "snapshot-1",
        home: join(data, "kernel-homes", "alice"),
        workspace,
    };
    let journal = new RotomJournal(data);

    try {
        journal.bind("native", original);
        const first = journal.reserve("native", "first", "/thinking high", "command");

        journal.attach(first.id, join(root, "native.jsonl"), "native-id");
        assert.throws(
            () => journal.upgradeKernel("native", "native", "0.1.26"),
            KernelRequestConflict,
            "a running attempt blocks the move",
        );
        journal.finish(first.id, "handled", [
            { id: "level", parentId: null, type: "thinking_level_change", thinkingLevel: "high" },
        ]);

        assert.throws(
            () => journal.upgradeKernel("native", "elsewhere", "0.1.26"),
            KernelRequestConflict,
        );
        assert.deepEqual(journal.session("native").binding, original, "refusals change nothing");

        journal.upgradeKernel("native", "native", "0.1.26");
        assert.deepEqual(journal.session("native"), {
            segmentId: "native",
            binding: { ...original, kernelVersion: "0.1.26" },
            sessionFile: join(root, "native.jsonl"),
            kernelSessionId: "native-id",
        });
        assert.equal(journal.receipt(first.id).binding.kernelVersion, "0.1.25", "receipts stay");

        // Startup re-binds with the original setup identity; that must still be accepted.
        journal.close();
        journal = new RotomJournal(data);
        journal.bind("native", original);
        assert.equal(journal.session("native").binding.kernelVersion, "0.1.26", "survives restart");

        // A later rejected model change restores the upgraded binding, not the anchor.
        const upgraded = journal.session("native").binding;
        const model = { ...upgraded, model: "model-2" };
        const switched = journal.reserve("native", "model-2", "/model grant-1/model-2", "command", {
            expectedHead: "native",
            binding: model,
        });

        journal.fail(switched.id, "rejected", false, upgraded);
        assert.deepEqual(journal.session("native").binding, upgraded);

        // Rolling back to the anchor's kernel needs no override row and loses nothing.
        journal.upgradeKernel("native", "native", "0.1.25");
        assert.deepEqual(journal.session("native").binding, original);
        assert.equal(journal.session("native").kernelSessionId, "native-id");
    } finally {
        journal.close();
        rmSync(root, { recursive: true, force: true });
    }
});
