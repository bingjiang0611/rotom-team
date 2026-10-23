import { cleanUp, noInferenceModels, owner, root, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationId } from "@earendil-works/pi-durable";
import { PocketApp } from "../src/server/app.ts";
import { TeamKernel } from "../src/server/team-kernel.ts";
import { currentBranchGoalState } from "../src/server/rotom-executions.ts";
import { RotomJournal, type KernelBinding, type KernelEntry } from "../src/server/rotom-journal.ts";

test.after(cleanUp);

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

test("real TeamKernel caches idle native readback without stale segment state", async (t) => {
    const dataDir = join(realpathSync(root), "native-room-info-real-data");
    const app = await PocketApp.open({
        dataDir,
        defaultCwd: realpathSync(work),
        supervised: false,
        kernel: true,
        browser: null,
        log: () => {},
        configureUserModels: noInferenceModels,
    });
    const member = owner(app);
    const session = await app.commands.createSession(member, { backend: "rotom" });
    const id = String(session.id);
    const journal = app.kernel!.executions.journal;
    let segmentEntriesReads = 0;
    const originalSegmentEntries = RotomJournal.prototype.segmentEntries;

    // Count the raw prototype, not executions.journal: performance subscribers expose that value through a Proxy.
    t.mock.method(
        RotomJournal.prototype,
        "segmentEntries",
        function (this: RotomJournal, segmentId: string) {
            segmentEntriesReads++;

            return originalSegmentEntries.call(this, segmentId);
        },
    );

    const compactInfo = () => {
        const info = app.kernel!.roomInfo(session.id);

        return { goal: info.goal, thinkingLevel: info.agent.thinkingLevel };
    };

    const attach = (attemptId: string, segmentId: string) => {
        const segment = journal.segment(segmentId);

        journal.attach(
            attemptId,
            segment.sessionFile ?? join(dataDir, `${segmentId}.jsonl`),
            segment.kernelSessionId ?? `synthetic-${segmentId}`,
        );
    };

    try {
        const initial = compactInfo();

        assert.equal(initial.goal, undefined, "an empty segment has no cached Goal");
        assert.equal(segmentEntriesReads, 1);
        assert.deepEqual(compactInfo(), initial);
        assert.equal(segmentEntriesReads, 1, "the next idle roomInfo reads no segment history");

        const binding = journal.session(id).binding;
        const revisionBeforeSwitch = journal.segmentRevision(journal.session(id).segmentId);
        const rebound = journal.reserve(
            id,
            "switch-fallback",
            "/model synthetic/image-fixture",
            "command",
            {
                expectedHead: journal.session(id).segmentId,
                binding: { ...binding, thinkingLevel: "minimal" },
            },
        );

        attach(rebound.id, rebound.segmentId);
        journal.finish(rebound.id, "handled", []);

        assert.equal(
            journal.segmentRevision(journal.session(id).segmentId),
            revisionBeforeSwitch,
            "model switch fallback update appends no history",
        );
        assert.deepEqual(compactInfo(), { goal: undefined, thinkingLevel: "minimal" });
        assert.equal(
            segmentEntriesReads,
            2,
            "a binding fallback change invalidates thinking without appending history",
        );

        const activeGoal = { goal: { id: "goal-1", status: "active" } };
        const progress = journal.reserve(id, "goal-progress", "goal-progress", "command");

        attach(progress.id, progress.segmentId);
        journal.progress(progress.id, [
            {
                id: "goal-1",
                parentId: null,
                type: "custom",
                customType: "goal-state",
                data: activeGoal,
            },
            {
                id: "user-1",
                parentId: "goal-1",
                type: "message",
                message: {
                    role: "user",
                    content: [{ type: "text", text: "continue" }],
                    timestamp: 1,
                },
            },
            {
                id: "thinking-high",
                parentId: "user-1",
                type: "thinking_level_change",
                thinkingLevel: "high",
            },
        ]);
        assert.deepEqual(compactInfo(), { goal: activeGoal, thinkingLevel: "high" });
        assert.equal(segmentEntriesReads, 3, "progress is immediately visible to roomInfo");

        journal.finish(progress.id, "handled", [
            {
                id: "goal-2",
                parentId: "thinking-high",
                type: "custom",
                customType: "goal-state",
                data: { goal: { id: "goal-2", status: "queued" } },
            },
            {
                id: "thinking-low",
                parentId: "goal-2",
                type: "thinking_level_change",
                thinkingLevel: "low",
            },
        ]);
        assert.deepEqual(compactInfo(), {
            goal: { goal: { id: "goal-2", status: "queued" } },
            thinkingLevel: "low",
        });
        assert.equal(segmentEntriesReads, 4, "finish-appended branch state is immediately visible");

        const previousHead = journal.session(id).segmentId;
        const inheritedEntries = journal.segmentEntries(previousHead);
        const readsBeforeHandoff = segmentEntriesReads;
        const handoff = journal.handoff(
            id,
            "synthetic-handoff",
            previousHead,
            journal.session(id).binding,
        );

        attach(handoff.id, handoff.segmentId);
        journal.finish(handoff.id, "settled", inheritedEntries);
        assert.deepEqual(compactInfo(), {
            goal: { goal: { id: "goal-2", status: "queued" } },
            thinkingLevel: "low",
        });
        assert.equal(
            segmentEntriesReads,
            readsBeforeHandoff + 1,
            "a new handoff head reads inherited state once",
        );
        assert.deepEqual(compactInfo(), {
            goal: { goal: { id: "goal-2", status: "queued" } },
            thinkingLevel: "low",
        });
        assert.equal(
            segmentEntriesReads,
            readsBeforeHandoff + 1,
            "the inherited handoff head is cached while idle",
        );

        const fork = await app.kernel!.fork(
            session.id,
            member,
            "synthetic-fork",
            journal.session(id).segmentId,
        );

        assert.equal(fork.receipt?.status, "settled");
        const forkedId = fork.id;
        const forkedInfo = app.kernel!.roomInfo(forkedId);

        assert.equal(forkedInfo.goal, undefined, "fork does not inherit private Goal state");
        assert.equal(
            forkedInfo.agent.thinkingLevel,
            journal.session(String(forkedId)).binding.thinkingLevel,
            "fork uses its own binding fallback rather than the source cache",
        );
        const readsBeforeUpgrade = segmentEntriesReads;

        journal.upgradeKernel(id, journal.session(id).segmentId, "synthetic-kernel-upgrade");
        assert.deepEqual(compactInfo(), {
            goal: { goal: { id: "goal-2", status: "queued" } },
            thinkingLevel: "low",
        });
        assert.equal(
            segmentEntriesReads,
            readsBeforeUpgrade + 1,
            "kernel version invalidation refreshes historical projections",
        );
    } finally {
        await app.close();
    }
});
