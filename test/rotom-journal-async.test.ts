import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    createAsyncRotomJournal,
    RotomJournal,
    type KernelBinding,
} from "../src/server/rotom-journal.ts";

test("async journal writes do not acknowledge before the awaited core call", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "rotom-journal-async-")));

    chmodSync(root, 0o700);
    const workspace = join(root, "workspace");
    const data = join(root, "data");
    const home = join(data, "kernel-homes", "alice");

    mkdirSync(workspace);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const journal = new RotomJournal(data);
    const asyncJournal = createAsyncRotomJournal(journal);

    assert.equal((asyncJournal as Record<PropertyKey, unknown>).then, undefined);
    assert.equal((asyncJournal as Record<PropertyKey, unknown>)[Symbol.toStringTag], undefined);
    assert.equal((asyncJournal as Record<PropertyKey, unknown>).missing, undefined);
    assert.equal(await asyncJournal, asyncJournal);
    const binding: KernelBinding = {
        memberId: "alice",
        kernelVersion: "fixture",
        accountGeneration: "fixture",
        provider: "fixture",
        model: "fixture",
        configurationDigest: "fixture",
        home,
        workspace,
    };

    try {
        let acknowledged = false;
        const write = asyncJournal.bind("conversation", binding).then(() => {
            acknowledged = true;
        });

        assert.equal(acknowledged, false);
        await write;
        assert.equal(acknowledged, true);
        assert.equal(await asyncJournal.hasConversation("conversation"), true);

        const rejected = asyncJournal.bind("rejected", {
            ...binding,
            memberId: "not valid",
        });

        await assert.rejects(rejected, /Kernel HOME must belong to this deployment member/);
        assert.equal(await asyncJournal.hasConversation("rejected"), false);
    } finally {
        await asyncJournal.close();
        rmSync(root, { recursive: true, force: true });
    }
});
