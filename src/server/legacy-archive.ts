/**
 * D9a startup quarantine for conversations that predate the native backend.
 *
 * This deliberately uses only Pi Durable's public Storage surface. It never asks a legacy task to run or abort: old
 * callbacks can submit work or spawn children. Terminal records, private preservation, state markers, and the user-visible
 * note are one storage commit for the complete root closure.
 */
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LiveDoc } from "@earendil-works/pi-durable";
import type {
    ConversationId,
    ConversationRecord,
    Cursor,
    DocumentAddress,
    DocumentId,
    EntryId,
    JsonObject,
    Storage,
    StorageWrite,
    SubmissionRecord,
    TaskRecord,
} from "@earendil-works/pi-durable";
import { encodeStorage, STORAGE_VALUE_BYTES } from "./storage-protocol.ts";
import {
    GoalDoc,
    LegacyLiveArchiveDoc,
    LegacyTaskArchiveDoc,
    PlanDoc,
    ScheduleDoc,
    SessionsDoc,
} from "./docs.ts";
import { ARCHIVE_COPY } from "./constants/copy.ts";
import { NOTE_ENTRY } from "./entry-format.ts";

const context = BACKGROUND_CONTEXT;
const PAGE_SIZE = 128;

type LegacyTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
type LegacySubmission = SubmissionRecord;
type ActiveTaskStatus = "pending" | "running" | "waiting" | "completing";

type SessionDocument = {
    items?: Record<string, { backend?: "rotom" }>;
};

function archiveDocument(task: LegacyTask, id: DocumentId): StorageWrite {
    return {
        type: "document.create",
        record: {
            id,
            kind: LegacyTaskArchiveDoc.definition.kind,
            scope: { kind: "task", taskId: task.id },
        },
        content: {
            kind: "base",
            version: LegacyTaskArchiveDoc.definition.version,
            value: { task: JSON.parse(JSON.stringify(task)) as JsonObject },
        },
    };
}

function abortedTask(task: LegacyTask): LegacyTask {
    const { memos: _memos, ...withoutMemos } = task;

    return {
        ...withoutMemos,
        abortRequested: true,
        state: {
            status: "terminal",
            outcome: { status: "aborted", reason: ARCHIVE_COPY.taskAbortReason },
        },
    };
}

function abortedSubmission(submission: LegacySubmission): LegacySubmission {
    return {
        ...submission,
        status: "unanswered",
        reason: ARCHIVE_COPY.taskAbortReason,
    } as LegacySubmission;
}

async function scanAll<T>(
    scan: (cursor: Cursor | undefined) => Promise<{ items: readonly T[]; next?: Cursor }>,
): Promise<T[]> {
    const result: T[] = [];
    let cursor: Cursor | undefined;

    do {
        const page = await scan(cursor);

        result.push(...page.items);
        cursor = page.next;
    } while (cursor !== undefined);

    return result;
}

function rootOf(
    id: ConversationId,
    conversations: ReadonlyMap<ConversationId, ConversationRecord>,
): ConversationId {
    let current = id;

    for (;;) {
        const owner = conversations.get(current)?.owner?.conversationId;

        if (owner === undefined) {
            return current;
        }

        current = owner;
    }
}

function documentAddress(kind: string, conversationId: ConversationId): DocumentAddress {
    return { kind, scope: { kind: "conversation", conversationId } };
}

async function changedConversationDocument(
    storage: Storage,
    conversationId: ConversationId,
    kind: string,
    change: (value: JsonObject) => boolean,
): Promise<StorageWrite | undefined> {
    const record = await storage.findDocument(
        documentAddress(kind, conversationId),
        "current",
        context,
    );

    if (record === undefined) {
        return undefined;
    }

    const stored = await storage.document(record.id, "current", context);

    if (stored === undefined) {
        return undefined;
    }

    const value = structuredClone(stored.value);

    if (!change(value)) {
        return undefined;
    }

    return {
        type: "document.change",
        id: record.id,
        content: { kind: "base", version: stored.version, value },
    };
}

async function archiveLiveDocument(
    storage: Storage,
    conversationId: ConversationId,
    archiveKey: string,
): Promise<StorageWrite[]> {
    const record = await storage.findDocument(
        documentAddress(LiveDoc.definition.kind, conversationId),
        "current",
        context,
    );

    if (record === undefined) {
        return [];
    }

    const stored = await storage.document(record.id, "current", context);

    if (stored === undefined) {
        return [];
    }

    const archivedLive = structuredClone(stored.value);
    const live = structuredClone(archivedLive);
    const keys = ["run", "generation", "tools", "compactions"];

    if (keys.every((key) => live[key] === undefined)) {
        return [];
    }

    const archiveId = await storage.mintId<DocumentId>();
    const writes: StorageWrite[] = [
        {
            type: "document.create",
            record: {
                id: archiveId,
                kind: LegacyLiveArchiveDoc.definition.kind,
                key: archiveKey,
                scope: { kind: "conversation", conversationId },
                history: "latest",
                fork: "initial",
            },
            content: {
                kind: "base",
                version: LegacyLiveArchiveDoc.definition.version,
                value: { live: archivedLive },
            },
        },
    ];

    for (const key of keys) {
        delete live[key];
    }

    writes.push({
        type: "document.change",
        id: record.id,
        content: { kind: "base", version: stored.version, value: live },
    });

    return writes;
}

async function legacyRoots(storage: Storage): Promise<Set<ConversationId>> {
    const sessionsRecord = await storage.findDocument(
        { kind: SessionsDoc.definition.kind, scope: { kind: "session" } },
        "current",
        context,
    );

    if (sessionsRecord === undefined) {
        return new Set();
    }

    const sessions = await storage.document(sessionsRecord.id, "current", context);
    const items = (sessions?.value as SessionDocument | undefined)?.items;
    const roots = new Set<ConversationId>();

    for (const [id, meta] of Object.entries(items ?? {})) {
        if (meta?.backend === undefined) {
            roots.add(Number(id) as ConversationId);
        }
    }

    return roots;
}

/** Abort all unfinished legacy work before Harness can start its scheduler. */
export async function quarantineLegacyTasks(
    storage: Storage,
    log: (line: string) => void = () => {},
): Promise<void> {
    const roots = await legacyRoots(storage);

    // Avoid scanning the task catalog entirely for a native-only database.
    if (roots.size === 0) {
        return;
    }

    const conversations = new Map<ConversationId, ConversationRecord>();
    const conversationRows = await scanAll((cursor) =>
        storage.scanConversations({}, PAGE_SIZE, cursor, context),
    );

    for (const conversation of conversationRows) {
        conversations.set(conversation.id, conversation);
    }

    const members = new Map<ConversationId, ConversationId[]>();

    for (const conversation of conversationRows) {
        const root = rootOf(conversation.id, conversations);

        if (!roots.has(root)) {
            continue;
        }

        const list = members.get(root) ?? [];

        list.push(conversation.id);
        members.set(root, list);
    }

    for (const [root, ids] of members) {
        const tasks: LegacyTask[] = [];
        const submissions: LegacySubmission[] = [];

        for (const conversationId of ids) {
            for (const status of [
                "pending",
                "running",
                "waiting",
                "completing",
            ] as ActiveTaskStatus[]) {
                tasks.push(
                    ...(await scanAll((cursor) =>
                        storage.scanTasks({ conversationId, status }, PAGE_SIZE, cursor, context),
                    )),
                );
            }

            for (const status of ["queued", "placed"] as const) {
                submissions.push(
                    ...(await scanAll((cursor) =>
                        storage.scanSubmissions(
                            { conversationId, status },
                            PAGE_SIZE,
                            cursor,
                            context,
                        ),
                    )),
                );
            }
        }

        const entryId = await storage.mintId<EntryId>();
        const documentWrites: StorageWrite[] = [];

        for (const conversationId of ids) {
            documentWrites.push(
                ...(await archiveLiveDocument(storage, conversationId, String(entryId))),
            );

            const schedule = await changedConversationDocument(
                storage,
                conversationId,
                ScheduleDoc.definition.kind,
                (value) => {
                    const items = value.items as
                        Record<string, Record<string, unknown>> | undefined;

                    if (items === undefined) {
                        return false;
                    }

                    let changed = false;

                    for (const item of Object.values(items)) {
                        if (
                            (item.archive as { status?: string } | undefined)?.status === "aborted"
                        ) {
                            continue;
                        }

                        item.archive = {
                            status: "aborted",
                            at: Date.now(),
                            reason: ARCHIVE_COPY.taskAbortReason,
                            text: ARCHIVE_COPY.scheduleAborted,
                        };
                        changed = true;
                    }

                    return changed;
                },
            );
            const goal = await changedConversationDocument(
                storage,
                conversationId,
                GoalDoc.definition.kind,
                (value) => {
                    const goal = value.goal as Record<string, unknown> | undefined;

                    if (
                        goal === undefined ||
                        goal.status !== "working" ||
                        (goal.archive as { status?: string } | undefined)?.status === "aborted"
                    ) {
                        return false;
                    }

                    goal.archive = {
                        status: "aborted",
                        at: Date.now(),
                        reason: ARCHIVE_COPY.taskAbortReason,
                        text: ARCHIVE_COPY.goalAborted,
                    };

                    return true;
                },
            );
            const plan = await changedConversationDocument(
                storage,
                conversationId,
                PlanDoc.definition.kind,
                (value) => {
                    if (
                        value.on !== true ||
                        (value.archive as { status?: string } | undefined)?.status === "aborted"
                    ) {
                        return false;
                    }

                    value.on = false;
                    value.archive = {
                        status: "aborted",
                        at: Date.now(),
                        reason: ARCHIVE_COPY.taskAbortReason,
                        text: ARCHIVE_COPY.planAborted,
                    };

                    return true;
                },
            );

            if (schedule) {
                documentWrites.push(schedule);
            }

            if (goal) {
                documentWrites.push(goal);
            }

            if (plan) {
                documentWrites.push(plan);
            }
        }

        if (tasks.length === 0 && submissions.length === 0 && documentWrites.length === 0) {
            continue;
        }

        const writes: StorageWrite[] = [];

        for (const task of tasks) {
            writes.push(archiveDocument(task, await storage.mintId<DocumentId>()));
            writes.push({ type: "task", value: abortedTask(task) });
        }

        for (const submission of submissions) {
            writes.push({ type: "submission", value: abortedSubmission(submission) });
        }

        const text =
            tasks.length + submissions.length === 0
                ? ARCHIVE_COPY.stateAborted
                : ARCHIVE_COPY.tasksAborted(tasks.length + submissions.length);

        writes.push({
            type: "entry",
            value: {
                id: entryId,
                conversationId: root,
                kind: NOTE_ENTRY,
                data: { text, name: ARCHIVE_COPY.archiveNoteName, archive: true },
                model: [
                    {
                        role: "user",
                        content: [{ type: "text", text: `[note] ${text}` }],
                        timestamp: Date.now(),
                    },
                ],
            },
        });
        writes.push(...documentWrites);

        // The storage worker rejects larger values at 256 MiB. Check before the first write so a large root closure
        // fails closed rather than leaving a partially quarantined task graph.
        if (encodeStorage(writes).byteLength > STORAGE_VALUE_BYTES) {
            throw new Error("Legacy archive closure exceeds the 256 MiB storage operation limit");
        }

        await storage.commit(writes, context);
        log(
            `Legacy session ${String(root)} was moved to read-only archive (${tasks.length + submissions.length} pending records).`,
        );
    }
}
