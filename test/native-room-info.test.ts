import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationId } from "@earendil-works/pi-durable";
import { TeamKernel } from "../src/server/team-kernel.ts";
import { currentBranchGoalState } from "../src/server/rotom-executions.ts";
import { RotomJournal, type KernelBinding, type KernelEntry } from "../src/server/rotom-journal.ts";

test("room readback shares full entries by exact segment only within one call", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "room-info-")));
    const data = join(root, "data");
    const home = join(data, "kernel-homes", "alice");
    const workspace = join(root, "workspace");

    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(workspace, { mode: 0o700 });
    const binding: KernelBinding = {
        memberId: "alice",
        kernelVersion: "0.1.25",
        accountGeneration: "fixture-grant",
        provider: "fixture",
        model: "fixture",
        configurationDigest: "fixture",
        thinkingLevel: "minimal",
        home,
        workspace,
    };
    let journal = new RotomJournal(data);
    const originalEntries = journal.segmentEntries;
    let reads = 0;
    let goalSession = "native";
    let agentSession = "native";
    let liveGoal: { value: unknown } | undefined;
    let liveThinking: string | undefined;
    const fixture = {
        executions: { journal },
        nativeGoal(_id: ConversationId, readEntries: (segment: string) => KernelEntry[]) {
            if (liveGoal) {
                return liveGoal.value;
            }

            const { segmentId } = journal.session(goalSession);
            const entries = readEntries(segmentId);

            return currentBranchGoalState({ entries, leafId: entries.at(-1)?.id });
        },
        agentInfo(_id: ConversationId, readEntries: (segment: string) => KernelEntry[]) {
            return {
                thinkingLevel: liveThinking ?? journal.thinkingLevel(agentSession, readEntries),
            };
        },
    };
    const info = () =>
        TeamKernel.prototype.roomInfo.call(fixture as unknown as TeamKernel, 1 as ConversationId);

    const countReads = () => {
        fixture.executions.journal = journal;

        journal.segmentEntries = function (segmentId) {
            reads++;

            return originalEntries.call(this, segmentId);
        };
    };

    try {
        journal.bind("native", binding);
        const run = journal.reserve("native", "first", "fixture");

        journal.attach(run.id, join(home, "native.jsonl"), "native-id");
        journal.progress(run.id, [
            {
                id: "goal",
                parentId: null,
                type: "custom",
                customType: "goal-state",
                data: { goal: { id: "first", status: "active" } },
            },
            { id: "high", parentId: "goal", type: "thinking_level_change", thinkingLevel: "high" },
            { id: "low", parentId: "high", type: "thinking_level_change", thinkingLevel: "low" },
            { id: "branch", parentId: "high", type: "custom", customType: "branch" },
        ]);
        countReads();
        assert.deepEqual(info(), {
            goal: { goal: { id: "first", status: "active" } },
            agent: { thinkingLevel: "high" },
        });
        assert.equal(reads, 1, "Goal and dormant thinking parse the same full segment once");
        journal.progress(run.id, [
            {
                id: "clear",
                parentId: "branch",
                type: "custom",
                customType: "goal-state",
                data: { goal: null },
            },
            { id: "off", parentId: "clear", type: "thinking_level_change", thinkingLevel: "off" },
        ]);
        assert.deepEqual(info(), { goal: { goal: null }, agent: { thinkingLevel: "off" } });
        assert.equal(reads, 2, "the next call observes appended native state");
        liveGoal = { value: { goal: { id: "live", status: "waiting" } } };
        liveThinking = "max";
        assert.deepEqual(info(), { goal: liveGoal.value, agent: { thinkingLevel: "max" } });
        assert.equal(reads, 2, "live readback takes precedence and avoids unnecessary history");
        liveGoal = undefined;
        liveThinking = undefined;
        journal.bind("other", { ...binding, thinkingLevel: "low" });
        agentSession = "other";
        assert.deepEqual(info(), { goal: { goal: null }, agent: { thinkingLevel: "low" } });
        assert.equal(
            reads,
            4,
            "different segment IDs never share entries, including empty segments",
        );
        goalSession = "other";
        assert.deepEqual(info(), { goal: undefined, agent: { thinkingLevel: "low" } });
        assert.equal(reads, 5, "an empty full segment is shared, not mistaken for a cache miss");
        goalSession = "native";
        agentSession = "native";
        journal.close();
        journal = new RotomJournal(data);
        countReads();
        assert.deepEqual(info(), { goal: { goal: null }, agent: { thinkingLevel: "off" } });
        assert.equal(reads, 6);
        journal.close();
        const db = new DatabaseSync(join(data, "kernel.sqlite"));

        // This abandoned branch is not selected; full readback must nevertheless reject corrupted JSON.
        db.prepare("UPDATE kernel_entries SET body=? WHERE entry_id=?").run(
            "malformed-json",
            "low",
        );
        db.close();
        journal = new RotomJournal(data);
        countReads();
        assert.throws(info, SyntaxError);
        assert.equal(reads, 7, "sharing does not bypass complete history parsing or its errors");
    } finally {
        journal.close();
        rmSync(root, { recursive: true, force: true });
    }
});
