import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
    RotomJournal,
    type KernelEntry,
    type KernelBinding,
} from "../../src/server/rotom-journal.ts";

const CREDIT_ENTRY = "qoder-credit-observation-v1";

type JournalEntry = ReturnType<RotomJournal["entries"]>[number];

export type JournalLargeWorkload = {
    conversations: number;
    attempts: number;
    entriesPerAttempt: number;
    entryChars: number;
};

type JournalCursor = {
    entryCursor?: (sessionId: string, count: number) => number;
    entriesAfter?: (sessionId: string, cursor: number) => JournalEntry[];
};

export type JournalLargeFixture = {
    journal: RotomJournal;
    sessions: string[];
    workload: JournalLargeWorkload;
    cursor: number;
    close(): void;
};

export type JournalLargeTimings = {
    entriesSuffixMs: number;
    segmentEntriesMs: number;
    creditsMs: number;
};

const binding: KernelBinding = {
    memberId: "journal-large-member",
    kernelVersion: "fixture",
    accountGeneration: "fixture-generation",
    provider: "qoder",
    model: "fixture-model",
    configurationDigest: "fixture-configuration",
    home: "/fixture/home",
    workspace: "/fixture/workspace",
};

function messageEntry(
    session: number,
    attempt: number,
    index: number,
    workload: JournalLargeWorkload,
): KernelEntry {
    return {
        type: "message",
        id: `entry-${session}-${attempt}-${index}`,
        message: {
            role: "assistant",
            content: [{ type: "text", text: "x".repeat(workload.entryChars) }],
        },
    };
}

function creditEntry(session: number, attempt: number): KernelEntry {
    return {
        type: "custom",
        id: `credit-${session}-${attempt}`,
        customType: CREDIT_ENTRY,
        data: {
            version: 1,
            sessionId: `kernel-${session}`,
            modelId: binding.model,
            requestId: `request-${session}-${attempt}`,
            status: "reported",
            outcome: "complete",
            credits: 0.25,
            billable: true,
        },
    };
}

function body(entry: KernelEntry): string {
    return JSON.stringify(entry);
}

/**
 * Create the same scale as journal-query-bench.mjs in an isolated real RotomJournal database.
 * The fixture is seeded before the measured calls, so setup work is not part of journal.large.
 */
export function createJournalLargeFixture(
    root: string,
    workload: JournalLargeWorkload,
): JournalLargeFixture {
    const data = mkdtempSync(join(realpathSync(root), "journal-large-"));

    const schema = new RotomJournal(data);

    schema.close();

    const db = new DatabaseSync(join(data, "kernel.sqlite"));
    const bindingJson = JSON.stringify(binding);
    const session = db.prepare(
        "INSERT INTO kernel_sessions(id,binding,kernel_session_id,conversation_id) VALUES (?,?,?,?)",
    );
    const attempt = db.prepare(
        "INSERT INTO kernel_attempts(id,session_id,request_id,prompt_hash,binding,home,status,conversation_id,operation) VALUES (?,?,?,?,?,?,?,?,?)",
    );
    const entry = db.prepare("INSERT INTO kernel_entries VALUES (?,?,?,?,?,?)");
    const usage = db.prepare("INSERT INTO kernel_usage VALUES (?,?,?,?,?)");
    const sessions = Array.from(
        { length: workload.conversations },
        (_, index) => `conversation-${index}`,
    );

    try {
        db.exec("BEGIN");

        for (let conversation = 0; conversation < workload.conversations; conversation++) {
            const segmentId = `segment-${conversation}`;
            const conversationId = sessions[conversation]!;

            session.run(segmentId, bindingJson, `kernel-${conversation}`, conversationId);

            for (let attemptIndex = 0; attemptIndex < workload.attempts; attemptIndex++) {
                const attemptId = `attempt-${conversation}-${attemptIndex}`;

                attempt.run(
                    attemptId,
                    segmentId,
                    `request-${conversation}-${attemptIndex}`,
                    "fixture-prompt-hash",
                    bindingJson,
                    binding.home,
                    "settled",
                    conversationId,
                    "prompt",
                );

                for (let entryIndex = 0; entryIndex < workload.entriesPerAttempt; entryIndex++) {
                    const value =
                        entryIndex === workload.entriesPerAttempt - 1
                            ? creditEntry(conversation, attemptIndex)
                            : messageEntry(conversation, attemptIndex, entryIndex, workload);

                    entry.run(
                        `kernel-${conversation}`,
                        `${attemptId}-${entryIndex}`,
                        segmentId,
                        attemptId,
                        body(value),
                        "fixture-digest",
                    );
                }

                usage.run(
                    `kernel-${conversation}`,
                    `${attemptId}-0`,
                    attemptId,
                    binding.memberId,
                    "{}",
                );
            }
        }

        db.exec("COMMIT; ANALYZE;");
    } catch (error) {
        db.exec("ROLLBACK");

        throw error;
    } finally {
        db.close();
    }

    const journal = new RotomJournal(data);

    return {
        journal,
        sessions,
        workload,
        cursor:
            (journal as RotomJournal & JournalCursor).entryCursor?.(
                sessions[workload.conversations - 1]!,
                (workload.attempts - 1) * workload.entriesPerAttempt,
            ) ?? 0,
        close: () => {
            journal.close();
            rmSync(data, { recursive: true, force: true });
        },
    };
}

function entriesSuffix(
    fixture: JournalLargeFixture,
    sessionId: string,
    skip: number,
): JournalEntry[] {
    // Equivalent warm suffix reads across revisions. Resolve the persisted count once during setup,
    // just as the mirror resolves it once after restart; count is never a rowid.
    const journal = fixture.journal as RotomJournal & JournalCursor;

    return typeof journal.entriesAfter === "function"
        ? journal.entriesAfter(sessionId, fixture.cursor)
        : journal.entries(sessionId, skip);
}

export function measureJournalLarge(fixture: JournalLargeFixture): JournalLargeTimings {
    const sessionIndex = fixture.workload.conversations - 1;
    const lastAttempt = fixture.workload.attempts - 1;
    const sessionId = fixture.sessions[sessionIndex]!;
    const segmentId = `segment-${sessionIndex}`;
    const entriesPerSession = fixture.workload.attempts * fixture.workload.entriesPerAttempt;
    const suffixStarted = performance.now();
    const suffix = entriesSuffix(
        fixture,
        sessionId,
        entriesPerSession - fixture.workload.entriesPerAttempt,
    );
    const entriesSuffixMs = performance.now() - suffixStarted;

    assert.equal(suffix.length, fixture.workload.entriesPerAttempt);
    assert.equal(suffix[0]?.entry.id, `entry-${sessionIndex}-${lastAttempt}-0`);
    assert.equal(suffix.at(-1)?.entry.id, `credit-${sessionIndex}-${lastAttempt}`);
    assert.ok(suffix.every((row) => row.operation === "prompt"));

    const segmentStarted = performance.now();
    const entries = fixture.journal.segmentEntries(segmentId);
    const segmentEntriesMs = performance.now() - segmentStarted;

    assert.equal(entries.length, entriesPerSession);
    assert.equal(entries[0]?.id, `entry-${sessionIndex}-0-0`);
    assert.equal(entries.at(-1)?.id, `credit-${sessionIndex}-${lastAttempt}`);

    const creditsStarted = performance.now();
    const credits = fixture.journal.credits(sessionId);
    const creditsMs = performance.now() - creditsStarted;

    assert.deepEqual(credits, [
        {
            segmentId,
            memberId: binding.memberId,
            credits: fixture.workload.attempts * 0.25,
            reported: fixture.workload.attempts,
            unknown: 0,
            unmeteredOperations: 0,
            partial: true,
        },
    ]);

    return { entriesSuffixMs, segmentEntriesMs, creditsMs };
}
