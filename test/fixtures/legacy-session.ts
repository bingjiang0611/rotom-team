/**
 * Test-only old-format persistence seed. It writes real Durable records through public Storage APIs and task definitions
 * from the production implementation. The task kind/version contract was exported from baseline 7478123; this helper is
 * intentionally not used by normal application creation paths.
 */
import type { JsonValue } from "@earendil-works/chord";
import { LiveDoc } from "@earendil-works/pi-durable";
import type {
    ConversationId,
    DocumentCreate,
    DocumentId,
    EntryId,
    JsonObject,
    Storage,
    StorageWrite,
    SubmissionId,
    TaskId,
    TaskRecord,
} from "@earendil-works/pi-durable";
import { GoalDoc, PlanDoc, ScheduleDoc, SessionsDoc, SubagentsDoc } from "../../src/server/docs.ts";
import { NOTE_ENTRY } from "../../src/server/entry-format.ts";
import { ResendTask } from "../../src/server/resend.ts";
import { Schedules } from "../../src/server/schedules.ts";
import { Shell } from "../../src/server/shell.ts";
import type { PocketApp } from "../../src/server/app.ts";

export type LegacyFixture = {
    conversationId: ConversationId;
    childConversationId: ConversationId;
    taskId: TaskId<JsonValue>;
    childTaskId: TaskId<JsonValue>;
    submissionId: SubmissionId;
    placedSubmissionId: SubmissionId;
    childSubmissionId: SubmissionId;
};

type FixtureTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
type FixtureScope = { kind: "session" } | { kind: "conversation"; conversationId: ConversationId };
type ConversationDefinition =
    | {
          kind: string;
          version: number;
          history: "latest";
          fork: "current" | "initial";
      }
    | {
          kind: string;
          version: number;
          history: "rewindable";
          fork: "current" | "initial" | "asOf";
      };

function task(
    id: TaskId<JsonValue>,
    conversationId: ConversationId,
    definition: { name: string; version: number },
    input: JsonValue,
    checkpoint: JsonValue,
    options: { background: boolean; owner?: TaskId<JsonValue> },
): FixtureTask {
    return {
        id,
        conversationId,
        kind: definition.name,
        version: definition.version,
        input,
        ...(options.owner === undefined ? {} : { owner: options.owner }),
        background: options.background,
        abortRequested: false,
        state: { status: "running", checkpoint },
    };
}

async function doc(
    storage: Storage,
    definition: ConversationDefinition,
    scope: Extract<FixtureScope, { kind: "conversation" }>,
    value: JsonObject,
): Promise<StorageWrite> {
    const id = await storage.mintId<DocumentId>();
    const record: DocumentCreate =
        definition.history === "latest"
            ? { id, kind: definition.kind, scope, history: "latest", fork: definition.fork }
            : { id, kind: definition.kind, scope, history: "rewindable", fork: definition.fork };

    return {
        type: "document.create",
        record,
        content: { kind: "base", version: definition.version, value },
    };
}

/** Seed an old Durable session with visible history and unfinished execution state. */
export async function seedLegacySession(
    storage: Storage,
    cwd: string,
    sentinelPath = `${cwd}/legacy-dispatch-sentinel`,
): Promise<LegacyFixture> {
    const conversationId = await storage.mintId<ConversationId>();
    const childConversationId = await storage.mintId<ConversationId>();
    const entryId = await storage.mintId<EntryId>();
    const taskId = await storage.mintId<TaskId<JsonValue>>();
    const shellTaskId = await storage.mintId<TaskId<JsonValue>>();
    const childTaskId = await storage.mintId<TaskId<JsonValue>>();
    const submissionId = await storage.mintId<SubmissionId>();
    const placedSubmissionId = await storage.mintId<SubmissionId>();
    const childSubmissionId = await storage.mintId<SubmissionId>();
    const scheduleTaskId = await storage.mintId<TaskId<JsonValue>>();
    const sessionsId = await storage.mintId<DocumentId>();
    const shell = new Shell({} as PocketApp).task;
    const schedules = new Schedules({} as PocketApp).task;
    const writes: StorageWrite[] = [
        { type: "conversation", value: { id: conversationId } },
        {
            type: "conversation",
            value: {
                id: childConversationId,
                owner: { conversationId, taskId },
            },
        },
        {
            type: "entry",
            value: {
                id: entryId,
                conversationId,
                kind: "pi.user",
                model: [{ role: "user", content: "historical message", timestamp: Date.now() }],
            },
        },
        {
            type: "task",
            value: task(
                taskId,
                conversationId,
                ResendTask.definition,
                {
                    text: "historical resend",
                    by: "fixture",
                },
                { phase: "send" },
                { background: true },
            ),
        },
        {
            type: "task",
            value: task(
                shellTaskId,
                conversationId,
                shell.definition,
                {
                    command: `touch ${JSON.stringify(sentinelPath)}`,
                    by: "fixture",
                    name: "Fixture",
                    context: false,
                },
                { phase: "run" },
                { background: true },
            ),
        },
        {
            type: "task",
            value: {
                ...task(
                    scheduleTaskId,
                    conversationId,
                    schedules.definition,
                    { scheduleId: "fixture-schedule" },
                    { phase: "wait" },
                    { background: true },
                ),
                state: { status: "pending", checkpoint: { phase: "wait" } },
            },
        },
        {
            type: "task",
            value: task(
                childTaskId,
                childConversationId,
                shell.definition,
                {
                    command: `touch ${JSON.stringify(`${sentinelPath}.child`)}`,
                    by: "fixture",
                    name: "Fixture",
                    context: false,
                },
                { phase: "run" },
                { background: true, owner: taskId },
            ),
        },
        {
            type: "submission",
            value: {
                id: submissionId,
                conversationId,
                type: "input",
                status: "queued",
                requestId: "fixture-old-input",
            },
        },
        {
            type: "submission",
            value: {
                id: placedSubmissionId,
                conversationId,
                type: "input",
                status: "placed",
                entry: entryId,
                requestId: "fixture-old-placed-input",
            },
        },
        {
            type: "submission",
            value: {
                id: childSubmissionId,
                conversationId: childConversationId,
                type: "input",
                status: "queued",
                requestId: "fixture-child-input",
            },
        },
        {
            type: "document.create",
            record: {
                id: sessionsId,
                kind: SessionsDoc.definition.kind,
                scope: { kind: "session" },
            },
            content: {
                kind: "base",
                version: SessionsDoc.definition.version,
                value: {
                    items: {
                        [String(conversationId)]: {
                            cwd,
                            createdAt: Date.now(),
                            updatedAt: Date.now(),
                            title: "Historical fixture",
                        },
                    },
                },
            },
        },
        await doc(
            storage,
            ScheduleDoc.definition,
            { kind: "conversation", conversationId },
            {
                items: {
                    "fixture-schedule": {
                        id: "fixture-schedule",
                        text: "old scheduled input",
                        content: "old scheduled input",
                        next: Date.now() + 60_000,
                        zone: "UTC",
                        createdAt: Date.now(),
                        runs: 0,
                        taskId: scheduleTaskId,
                    },
                },
            },
        ),
        await doc(
            storage,
            GoalDoc.definition,
            { kind: "conversation", conversationId },
            {
                goal: {
                    command: "true",
                    by: "fixture",
                    max: 3,
                    tries: 1,
                    status: "met",
                    counted: [],
                },
            },
        ),
        await doc(
            storage,
            GoalDoc.definition,
            { kind: "conversation", conversationId: childConversationId },
            {
                goal: {
                    command: "false",
                    by: "fixture",
                    max: 3,
                    tries: 1,
                    status: "working",
                    counted: [],
                },
            },
        ),
        await doc(
            storage,
            PlanDoc.definition,
            { kind: "conversation", conversationId },
            { on: true, by: "fixture", at: Date.now() },
        ),
        await doc(
            storage,
            PlanDoc.definition,
            { kind: "conversation", conversationId: childConversationId },
            { on: true, by: "fixture", at: Date.now() },
        ),
        await doc(
            storage,
            SubagentsDoc.definition,
            { kind: "conversation", conversationId },
            {
                agents: {
                    helper: { conversationId: childConversationId, reported: [] },
                },
                reporters: {},
            },
        ),
        await doc(
            storage,
            LiveDoc.definition,
            { kind: "conversation", conversationId },
            {
                run: { taskId, inputs: [submissionId] },
                generation: {
                    attempt: 1,
                    message: {
                        role: "assistant",
                        content: [{ type: "text", text: "partial assistant draft" }],
                    },
                },
                tools: [
                    {
                        callId: "fixture-call",
                        name: "shell",
                        status: "running",
                        output: "partial tool output",
                    },
                ],
            },
        ),
        await doc(
            storage,
            LiveDoc.definition,
            { kind: "conversation", conversationId: childConversationId },
            {
                run: { taskId: childTaskId, inputs: [childSubmissionId] },
                generation: {
                    attempt: 1,
                    message: {
                        role: "assistant",
                        content: [{ type: "text", text: "partial child draft" }],
                    },
                },
            },
        ),
    ];

    writes.push({
        type: "entry",
        value: {
            id: await storage.mintId<EntryId>(),
            conversationId,
            kind: NOTE_ENTRY,
            data: { text: "historical note", name: "Fixture" },
        },
    });
    await storage.commit(
        writes,
        (await import("@earendil-works/chord/context")).BACKGROUND_CONTEXT,
    );

    return {
        conversationId,
        childConversationId,
        taskId,
        childTaskId,
        submissionId,
        placedSubmissionId,
        childSubmissionId,
    };
}
