import assert from "node:assert/strict";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import "./helpers.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import { LiveDoc } from "@earendil-works/pi-durable";
import type {
    ConversationId,
    DocumentId,
    EntryId,
    Storage,
    SubmissionId,
    StorageWrite,
    TaskId,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { PocketApp } from "../src/server/app.ts";
import {
    GoalDoc,
    LegacyLiveArchiveDoc,
    LegacyTaskArchiveDoc,
    PlanDoc,
    ScheduleDoc,
} from "../src/server/docs.ts";
import { ARCHIVE_COPY } from "../src/server/constants/copy.ts";
import { ConfigStore } from "../src/server/config.ts";
import { quarantineLegacyTasks } from "../src/server/legacy-archive.ts";
import {
    pinnedLegacyEntries,
    pinnedLegacyExtensionChoices,
    pinnedLegacyExtensionSource,
    pinnedLegacyProducer,
    pinnedLegacySubmissions,
    pinnedLegacyTasks,
    seedPinnedLegacySession,
} from "./fixtures/legacy-baseline.ts";
import { scriptedModel } from "./helpers.ts";
import { seedLegacySession, type LegacyFixture } from "./fixtures/legacy-session.ts";

async function snapshotLegacyClosure(storage: Storage, fixture: LegacyFixture): Promise<string> {
    const conversations = [fixture.conversationId, fixture.childConversationId];
    const tasks = [];
    const submissions = [];

    for (const conversationId of conversations) {
        for (const status of ["pending", "running", "waiting", "completing", "terminal"] as const) {
            tasks.push(
                ...(
                    await storage.scanTasks(
                        { conversationId, status },
                        100,
                        undefined,
                        BACKGROUND_CONTEXT,
                    )
                ).items,
            );
        }

        for (const status of ["queued", "placed", "unanswered"] as const) {
            submissions.push(
                ...(
                    await storage.scanSubmissions(
                        { conversationId, status },
                        100,
                        undefined,
                        BACKGROUND_CONTEXT,
                    )
                ).items,
            );
        }
    }

    const entries = [];

    for (const conversationId of conversations) {
        entries.push(
            ...(await storage.scanEntries({ conversationId }, 100, undefined, BACKGROUND_CONTEXT))
                .items,
        );
    }

    const documents = [];

    for (const scope of conversations.map((conversationId) => ({
        kind: "conversation" as const,
        conversationId,
    }))) {
        for (const kind of [
            LiveDoc.definition.kind,
            LegacyLiveArchiveDoc.definition.kind,
            LegacyTaskArchiveDoc.definition.kind,
            PlanDoc.definition.kind,
            GoalDoc.definition.kind,
            ScheduleDoc.definition.kind,
        ]) {
            documents.push(
                ...(
                    await storage.scanDocuments(
                        { scope, at: "current", kind },
                        100,
                        undefined,
                        BACKGROUND_CONTEXT,
                    )
                ).items,
            );
        }
    }

    return JSON.stringify({ tasks, submissions, entries, documents });
}

test("archive quarantine walks a public-storage ownership chain deeper than 32 levels", async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "rotom-legacy-deep-")));
    const storage = await openNodeSqliteStorage(join(directory, "pocket.sqlite"));

    try {
        const depth = 40;
        const conversations: ConversationId[] = [];
        const tasks: TaskId<JsonValue>[] = [];
        const writes: StorageWrite[] = [];
        const sessionsId = await storage.mintId<DocumentId>();
        let parentConversation: ConversationId | undefined;
        let parentTask: TaskId<JsonValue> | undefined;

        for (let index = 0; index < depth; index++) {
            const conversationId = await storage.mintId<ConversationId>();
            const taskId = await storage.mintId<TaskId<JsonValue>>();

            conversations.push(conversationId);
            tasks.push(taskId);
            writes.push({
                type: "conversation",
                value: {
                    id: conversationId,
                    ...(parentConversation === undefined
                        ? {}
                        : { owner: { conversationId: parentConversation!, taskId: parentTask! } }),
                },
            });
            writes.push({
                type: "task",
                value: {
                    id: taskId,
                    conversationId,
                    kind: "deep-fixture",
                    version: 1,
                    input: { index },
                    background: true,
                    abortRequested: false,
                    ...(parentTask === undefined ? {} : { owner: parentTask }),
                    memos: { privateSnapshot: `snapshot-${index}` },
                    state: { status: "running", checkpoint: { phase: "fixture" } },
                },
            } as never);
            parentConversation = conversationId;
            parentTask = taskId;
        }

        const deepest = conversations.at(-1)!;
        const deepestTask = tasks.at(-1)!;
        const submissionId = await storage.mintId<SubmissionId>();
        const liveId = await storage.mintId<DocumentId>();
        const entryId = await storage.mintId<EntryId>();

        writes.push(
            {
                type: "submission",
                value: {
                    id: submissionId,
                    conversationId: deepest,
                    type: "input",
                    status: "queued",
                    requestId: "deep-fixture",
                },
            },
            {
                type: "document.create",
                record: {
                    id: liveId,
                    kind: LiveDoc.definition.kind,
                    scope: { kind: "conversation", conversationId: deepest },
                    history: "latest",
                    fork: "current",
                },
                content: {
                    kind: "base",
                    version: LiveDoc.definition.version,
                    value: {
                        run: { taskId: deepestTask, inputs: [] },
                        generation: { attempt: 1, message: { role: "assistant", content: [] } },
                    },
                },
            },
            {
                type: "entry",
                value: {
                    id: entryId,
                    conversationId: conversations[0]!,
                    kind: "pocket.note",
                    data: { text: "complete root note", name: "Pi" },
                },
            },
            {
                type: "document.create",
                record: {
                    id: sessionsId,
                    kind: "pocket.sessions",
                    scope: { kind: "session" },
                },
                content: {
                    kind: "base",
                    version: 1,
                    value: { items: { [String(conversations[0]!)]: { title: "Deep fixture" } } },
                },
            },
        );
        await storage.commit(writes, BACKGROUND_CONTEXT);
        await quarantineLegacyTasks(storage);

        for (const taskId of tasks) {
            assert.equal(
                (await storage.task(taskId, BACKGROUND_CONTEXT))?.state.status,
                "terminal",
            );
        }

        assert.equal(
            (await storage.submission(submissionId, BACKGROUND_CONTEXT))?.status,
            "unanswered",
        );
        const liveArchive = await storage.scanDocuments(
            {
                scope: { kind: "conversation", conversationId: deepest },
                at: "current",
                kind: LegacyLiveArchiveDoc.definition.kind,
            },
            10,
            undefined,
            BACKGROUND_CONTEXT,
        );

        assert.equal(liveArchive.items.length, 1);
        const archivedLive = await storage.document(
            liveArchive.items[0]!.id,
            "current",
            BACKGROUND_CONTEXT,
        );

        assert.match(JSON.stringify(archivedLive?.value), /snapshot|taskId/);
        const notesBefore = await storage.scanEntries(
            { conversationId: conversations[0]! },
            100,
            undefined,
            BACKGROUND_CONTEXT,
        );

        assert.equal(notesBefore.items.filter((entry) => entry.kind === "pocket.note").length, 2);
        await quarantineLegacyTasks(storage);
        const notesAfter = await storage.scanEntries(
            { conversationId: conversations[0]! },
            100,
            undefined,
            BACKGROUND_CONTEXT,
        );

        assert.equal(notesAfter.items.filter((entry) => entry.kind === "pocket.note").length, 2);
    } finally {
        await storage.close(BACKGROUND_CONTEXT);
        rmSync(directory, { recursive: true, force: true });
    }
});

test("D9a quarantines real legacy records without running old callbacks", async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "rotom-legacy-archive-")));
    const storage = await openNodeSqliteStorage(join(directory, "pocket.sqlite"));

    try {
        const workspace = join(directory, "workspace");

        mkdirSync(workspace);
        const sentinel = join(workspace, "sentinel");
        const fixture = await seedLegacySession(storage, workspace, sentinel);

        await quarantineLegacyTasks(storage);

        const task = await storage.task(fixture.taskId, BACKGROUND_CONTEXT);
        const childTask = await storage.task(fixture.childTaskId, BACKGROUND_CONTEXT);
        const submission = await storage.submission(fixture.submissionId, BACKGROUND_CONTEXT);
        const placedSubmission = await storage.submission(
            fixture.placedSubmissionId,
            BACKGROUND_CONTEXT,
        );
        const childSubmission = await storage.submission(
            fixture.childSubmissionId,
            BACKGROUND_CONTEXT,
        );
        const entries = await storage.scanEntries(
            { conversationId: fixture.conversationId },
            100,
            undefined,
            BACKGROUND_CONTEXT,
        );
        const scheduleRecord = await storage.findDocument(
            {
                kind: ScheduleDoc.definition.kind,
                scope: { kind: "conversation", conversationId: fixture.conversationId },
            },
            "current",
            BACKGROUND_CONTEXT,
        );
        const schedule = await storage.document(scheduleRecord!.id, "current", BACKGROUND_CONTEXT);
        const childPlanRecord = await storage.findDocument(
            {
                kind: "pocket.plan",
                scope: { kind: "conversation", conversationId: fixture.childConversationId },
            },
            "current",
            BACKGROUND_CONTEXT,
        );
        const childPlan = await storage.document(
            childPlanRecord!.id,
            "current",
            BACKGROUND_CONTEXT,
        );
        const goalRecord = await storage.findDocument(
            {
                kind: GoalDoc.definition.kind,
                scope: { kind: "conversation", conversationId: fixture.childConversationId },
            },
            "current",
            BACKGROUND_CONTEXT,
        );
        const goal = await storage.document(goalRecord!.id, "current", BACKGROUND_CONTEXT);
        const completedGoalRecord = await storage.findDocument(
            {
                kind: GoalDoc.definition.kind,
                scope: { kind: "conversation", conversationId: fixture.conversationId },
            },
            "current",
            BACKGROUND_CONTEXT,
        );
        const completedGoal = await storage.document(
            completedGoalRecord!.id,
            "current",
            BACKGROUND_CONTEXT,
        );

        const liveArchives = await storage.scanDocuments(
            {
                scope: { kind: "conversation", conversationId: fixture.conversationId },
                at: "current",
                kind: LegacyLiveArchiveDoc.definition.kind,
            },
            10,
            undefined,
            BACKGROUND_CONTEXT,
        );

        assert.equal(liveArchives.items.length, 1);
        const liveArchive = await storage.document(
            liveArchives.items[0]!.id,
            "current",
            BACKGROUND_CONTEXT,
        );

        assert.match(JSON.stringify(liveArchive?.value), /partial assistant draft/);
        assert.match(JSON.stringify(liveArchive?.value), /partial tool output/);

        const archives = await storage.scanDocuments(
            {
                scope: { kind: "task", taskId: fixture.taskId },
                at: "current",
                kind: LegacyTaskArchiveDoc.definition.kind,
            },
            10,
            undefined,
            BACKGROUND_CONTEXT,
        );

        assert.equal(archives.items.length, 1);
        assert.equal(existsSync(sentinel), false);
        assert.equal(existsSync(`${sentinel}.child`), false);
        const notes = await storage.scanEntries(
            { conversationId: fixture.conversationId },
            100,
            undefined,
            BACKGROUND_CONTEXT,
        );

        assert.equal(
            notes.items.some((entry) => JSON.stringify(entry).includes("partial")),
            false,
        );
        assert.equal(task?.state.status, "terminal");
        assert.equal(task?.state.outcome.status, "aborted");
        assert.equal(childTask?.state.status, "terminal");
        assert.equal(childTask?.state.outcome.status, "aborted");
        assert.equal(submission?.status, "unanswered");
        assert.equal(placedSubmission?.status, "unanswered");
        assert.equal(childSubmission?.status, "unanswered");
        assert.ok(
            entries.items.some(
                (entry) =>
                    entry.kind === "pocket.note" &&
                    (entry.data as { text?: string; archive?: boolean } | undefined)?.archive ===
                        true &&
                    (entry.data as { text?: string } | undefined)?.text?.includes(
                        "read-only archive",
                    ),
            ),
        );
        assert.equal((childPlan?.value.archive as { status?: string })?.status, "aborted");
        assert.equal(childPlan?.value.on as boolean, false);
        assert.equal(
            (schedule?.value.items as Record<string, { archive?: { status: string } }>)?.[
                "fixture-schedule"
            ]?.archive?.status,
            "aborted",
        );
        assert.equal(
            (goal?.value.goal as { archive?: { status: string } })?.archive?.status,
            "aborted",
        );
        assert.equal((completedGoal?.value.goal as { status: string }).status, "met");
        assert.equal((completedGoal?.value.goal as { archive?: unknown }).archive, undefined);

        const noteCount = entries.items.filter((entry) => entry.kind === "pocket.note").length;

        await quarantineLegacyTasks(storage);
        const after = await storage.scanEntries(
            { conversationId: fixture.conversationId },
            100,
            undefined,
            BACKGROUND_CONTEXT,
        );

        assert.equal(after.items.filter((entry) => entry.kind === "pocket.note").length, noteCount);

        const liveRecord = await storage.findDocument(
            {
                kind: LiveDoc.definition.kind,
                scope: { kind: "conversation", conversationId: fixture.conversationId },
            },
            "current",
            BACKGROUND_CONTEXT,
        );

        assert.ok(liveRecord);
        await storage.commit(
            [
                {
                    type: "document.change",
                    id: liveRecord.id,
                    content: {
                        kind: "base",
                        version: LiveDoc.definition.version,
                        value: {
                            run: { taskId: fixture.taskId, inputs: [] },
                            generation: {
                                attempt: 2,
                                message: {
                                    role: "assistant",
                                    content: [{ type: "text", text: "rolled back draft" }],
                                },
                            },
                        },
                    },
                },
            ],
            BACKGROUND_CONTEXT,
        );
        await quarantineLegacyTasks(storage);
        const reapplied = await storage.scanDocuments(
            {
                scope: { kind: "conversation", conversationId: fixture.conversationId },
                at: "current",
                kind: LegacyLiveArchiveDoc.definition.kind,
            },
            10,
            undefined,
            BACKGROUND_CONTEXT,
        );

        assert.equal(reapplied.items.length, 2);
        assert.equal(new Set(reapplied.items.map((item) => item.key)).size, 2);
    } finally {
        await storage.close(BACKGROUND_CONTEXT);
        rmSync(directory, { recursive: true, force: true });
    }
});

test("pinned 7478123 records reopen as an archive without replaying old work", async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "rotom-pinned-legacy-")));
    const path = join(directory, "pocket.sqlite");
    const workspace = join(directory, "workspace");
    const extensionDirectory = join(directory, "extensions");
    const extensionPath = join(extensionDirectory, "fixture-wait.ts");
    const storage = await openNodeSqliteStorage(path);

    mkdirSync(workspace);
    await seedPinnedLegacySession(storage, workspace);
    await storage.close(BACKGROUND_CONTEXT);
    mkdirSync(extensionDirectory);
    writeFileSync(extensionPath, pinnedLegacyExtensionSource);

    const config = new ConfigStore(directory);

    for (const file of pinnedLegacyExtensionChoices.enabledExtensions) {
        config.setExtensionEnabled(file, true);
    }

    for (const file of pinnedLegacyExtensionChoices.disabledExtensions) {
        config.setExtensionEnabled(file, false);
    }

    assert.equal(pinnedLegacyProducer.revision, "7478123983cd9d9a2ff25782f87523043bdfe181");
    let app = await PocketApp.open({
        dataDir: directory,
        defaultCwd: workspace,
        supervised: false,
        kernel: false,
        log: () => {},
        configureModels: (models) => models.registerNativeProvider(scriptedModel().provider),
    });

    try {
        const owner = app.config.users.find((user) => user.role === "owner")!;

        assert.equal(app.loader, undefined);
        assert.deepEqual(
            app.config.enabledExtensions,
            pinnedLegacyExtensionChoices.enabledExtensions,
        );
        assert.deepEqual(
            app.config.disabledExtensions,
            pinnedLegacyExtensionChoices.disabledExtensions,
        );
        assert.equal(readFileSync(extensionPath, "utf8"), pinnedLegacyExtensionSource);

        for (const id of [3, 31] as const) {
            assert.equal(app.isBusy(id as never), false);
            const room = await app.room(id as never);

            app.releaseRoom(room);
            const conversation = await app.harness.conversation(id as never, BACKGROUND_CONTEXT);
            const entries = await conversation!.entries({}, 100, undefined, BACKGROUND_CONTEXT);

            assert.equal(
                pinnedLegacyEntries
                    .filter((entry) => entry.conversationId === id)
                    .every((entry) => entries.items.some((candidate) => candidate.id === entry.id)),
                true,
            );
            assert.equal(entries.items.filter((entry) => entry.kind === "pocket.note").length, 1);
            assert.equal(
                entries.items.some((entry) => JSON.stringify(entry).includes("synthetic partial")),
                false,
            );
            const exported = await app.transcripts.exportMarkdown(id as never, owner);

            assert.match(exported.markdown, /saved historical question|STREAM-FIXTURE/);
        }

        for (const task of pinnedLegacyTasks) {
            const current = await app.harness.getTask(task.id, BACKGROUND_CONTEXT);

            if (task.state.status === "terminal") {
                assert.equal(current?.state.status, "terminal");
                assert.equal(current?.state.outcome.status, "completed");
            } else {
                assert.equal(current?.state.status, "terminal");
                assert.equal(current?.state.outcome.status, "aborted");
            }
        }

        assert.equal(
            pinnedLegacySubmissions.filter(
                (submission) => submission.status === "queued" || submission.status === "placed",
            ).length,
            3,
        );

        await app.close();
        app = await PocketApp.open({
            dataDir: directory,
            defaultCwd: workspace,
            supervised: false,
            kernel: false,
            log: () => {},
            configureModels: (models) => models.registerNativeProvider(scriptedModel().provider),
        });
        const reopened = await app.harness.conversation(3 as never, BACKGROUND_CONTEXT);
        const reopenedEntries = await reopened!.entries({}, 100, undefined, BACKGROUND_CONTEXT);

        assert.equal(
            reopenedEntries.items.filter((entry) => entry.kind === "pocket.note").length,
            1,
        );
    } finally {
        await app.close();
        const reopenedStorage = await openNodeSqliteStorage(path);

        try {
            const archives = await reopenedStorage.scanDocuments(
                {
                    scope: { kind: "conversation", conversationId: 31 as never },
                    at: "current",
                    kind: LegacyLiveArchiveDoc.definition.kind,
                },
                10,
                undefined,
                BACKGROUND_CONTEXT,
            );

            assert.equal(archives.items.length, 1);

            for (const task of pinnedLegacyTasks) {
                const taskArchives = await reopenedStorage.scanDocuments(
                    {
                        scope: { kind: "task", taskId: task.id },
                        at: "current",
                        kind: LegacyTaskArchiveDoc.definition.kind,
                    },
                    10,
                    undefined,
                    BACKGROUND_CONTEXT,
                );

                assert.equal(taskArchives.items.length, task.state.status === "terminal" ? 0 : 1);
            }

            for (const submission of pinnedLegacySubmissions) {
                if (submission.status === "queued" || submission.status === "placed") {
                    assert.equal(
                        (await reopenedStorage.submission(submission.id, BACKGROUND_CONTEXT))
                            ?.status,
                        "unanswered",
                    );
                }
            }

            const liveArchive = await reopenedStorage.document(
                archives.items[0]!.id,
                "current",
                BACKGROUND_CONTEXT,
            );

            assert.match(JSON.stringify(liveArchive?.value), /synthetic partial response/);
            const toolArchives = await reopenedStorage.scanDocuments(
                {
                    scope: { kind: "conversation", conversationId: 3 as never },
                    at: "current",
                    kind: LegacyLiveArchiveDoc.definition.kind,
                },
                10,
                undefined,
                BACKGROUND_CONTEXT,
            );
            const toolArchive = await reopenedStorage.document(
                toolArchives.items[0]!.id,
                "current",
                BACKGROUND_CONTEXT,
            );

            assert.match(JSON.stringify(toolArchive?.value), /synthetic unfinished tool output/);
        } finally {
            await reopenedStorage.close(BACKGROUND_CONTEXT);
            rmSync(directory, { recursive: true, force: true });
        }
    }
});

test("archive mode keeps read handles and rejects legacy execution before side effects", async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "rotom-legacy-app-")));
    const storage = await openNodeSqliteStorage(join(directory, "pocket.sqlite"));

    const workspace = join(directory, "workspace");

    mkdirSync(workspace);
    const fixture = await seedLegacySession(storage, workspace);

    await storage.close(BACKGROUND_CONTEXT);

    const app = await PocketApp.open({
        dataDir: directory,
        defaultCwd: workspace,
        supervised: false,
        kernel: false,
        log: () => {},
    });

    try {
        const id = [...(await app.sessions())][0]!.id as never;
        const owner = app.config.users.find((user) => user.role === "owner")!;

        assert.equal(app.loader, undefined);
        assert.equal(app.isBusy(fixture.conversationId), false);
        assert.equal(app.isBusy(fixture.childConversationId), false);
        assert.ok(await app.conversation(id));
        const room = await app.room(id);

        assert.equal(room.plan.on, false);
        app.releaseRoom(room);
        const exported = await app.transcripts.exportMarkdown(id, owner);

        assert.match(exported.markdown, /historical message/);
        await assert.rejects(
            app.commands.submit(id, owner, { text: "must not execute", requestId: "archive-test" }),
            (error: unknown) => error instanceof Error && error.message === ARCHIVE_COPY.readOnly,
        );
        await assert.rejects(
            app.commands.createSession(owner, {}),
            (error: unknown) => error instanceof Error && error.message === ARCHIVE_COPY.readOnly,
        );
    } finally {
        await app.close();
        rmSync(directory, { recursive: true, force: true });
    }
});

for (const [kernel, storageWorker] of [
    [true, false],
    [true, true],
] as const) {
    test(`native-kernel archive startup remains read-only (worker=${storageWorker})`, async () => {
        const directory = realpathSync(mkdtempSync(join(tmpdir(), "rotom-legacy-kernel-")));
        const storage = await openNodeSqliteStorage(join(directory, "pocket.sqlite"));
        const workspace = join(directory, "workspace");
        const sentinel = join(workspace, "sentinel");

        mkdirSync(workspace);
        await seedLegacySession(storage, workspace, sentinel);
        await storage.close(BACKGROUND_CONTEXT);

        const app = await PocketApp.open({
            dataDir: directory,
            defaultCwd: workspace,
            supervised: false,
            kernel,
            storageWorker,
            log: () => {},
        });

        try {
            const id = [...(await app.sessions())][0]!.id as never;
            const owner = app.config.users.find((user) => user.role === "owner")!;

            assert.equal(app.loader, undefined);
            assert.ok(await app.conversation(id));
            assert.equal(existsSync(sentinel), false);
            await assert.rejects(
                app.commands.submit(id, owner, {
                    text: "must not execute",
                    requestId: "kernel-archive",
                }),
                (error: unknown) =>
                    error instanceof Error && error.message === ARCHIVE_COPY.readOnly,
            );
        } finally {
            await app.close();
            rmSync(directory, { recursive: true, force: true });
        }
    });
}

test("app startup closes direct Storage after quarantine failure", async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "rotom-legacy-startup-failure-")));
    const path = join(directory, "pocket.sqlite");
    const storage = await openNodeSqliteStorage(path);
    const workspace = join(directory, "workspace");

    mkdirSync(workspace);
    await seedLegacySession(storage, workspace);
    await storage.close(BACKGROUND_CONTEXT);

    const prototype = Object.getPrototypeOf(storage) as {
        commit: Storage["commit"];
    };
    const originalCommit = prototype.commit;

    prototype.commit = async (...args: Parameters<Storage["commit"]>) => {
        prototype.commit = originalCommit;
        void args;

        throw new Error("injected startup archive commit failure");
    };

    try {
        await assert.rejects(
            PocketApp.open({
                dataDir: directory,
                defaultCwd: workspace,
                supervised: false,
                kernel: false,
                log: () => {},
            }),
            /injected startup archive commit failure/,
        );
    } finally {
        prototype.commit = originalCommit;
    }

    const app = await PocketApp.open({
        dataDir: directory,
        defaultCwd: workspace,
        supervised: false,
        kernel: false,
        log: () => {},
    });

    try {
        const id = [...(await app.sessions())][0]!.id as never;

        assert.equal(app.isBusy(id), false);
    } finally {
        await app.close();
        rmSync(directory, { recursive: true, force: true });
    }
});

test("archive commit success followed by lost acknowledgement is idempotent on retry", async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "rotom-legacy-lost-ack-")));
    const path = join(directory, "pocket.sqlite");
    const storage = await openNodeSqliteStorage(path);
    const workspace = join(directory, "workspace");

    mkdirSync(workspace);
    const sentinel = join(workspace, "sentinel");
    const fixture = await seedLegacySession(storage, workspace, sentinel);
    let threw = false;
    const lostAck = new Proxy(storage, {
        get(target, property, receiver) {
            if (property === "commit") {
                return async (...args: Parameters<Storage["commit"]>) => {
                    if (!threw) {
                        threw = true;
                        await target.commit(...args);

                        throw new Error("injected lost archive acknowledgement");
                    }

                    return target.commit(...args);
                };
            }

            const value = Reflect.get(target, property, receiver);

            return typeof value === "function" ? value.bind(target) : value;
        },
    }) as unknown as Storage;

    try {
        await assert.rejects(
            quarantineLegacyTasks(lostAck),
            /injected lost archive acknowledgement/,
        );
        await storage.close(BACKGROUND_CONTEXT);
        const reopened = await openNodeSqliteStorage(path);

        try {
            const firstNotes = await reopened.scanEntries(
                { conversationId: fixture.conversationId },
                100,
                undefined,
                BACKGROUND_CONTEXT,
            );
            const firstArchives = await reopened.scanDocuments(
                {
                    scope: { kind: "task", taskId: fixture.taskId },
                    at: "current",
                    kind: LegacyTaskArchiveDoc.definition.kind,
                },
                100,
                undefined,
                BACKGROUND_CONTEXT,
            );
            const firstLiveArchives = await reopened.scanDocuments(
                {
                    scope: { kind: "conversation", conversationId: fixture.conversationId },
                    at: "current",
                    kind: LegacyLiveArchiveDoc.definition.kind,
                },
                100,
                undefined,
                BACKGROUND_CONTEXT,
            );

            await quarantineLegacyTasks(reopened);
            const secondNotes = await reopened.scanEntries(
                { conversationId: fixture.conversationId },
                100,
                undefined,
                BACKGROUND_CONTEXT,
            );
            const secondArchives = await reopened.scanDocuments(
                {
                    scope: { kind: "task", taskId: fixture.taskId },
                    at: "current",
                    kind: LegacyTaskArchiveDoc.definition.kind,
                },
                100,
                undefined,
                BACKGROUND_CONTEXT,
            );
            const secondLiveArchives = await reopened.scanDocuments(
                {
                    scope: { kind: "conversation", conversationId: fixture.conversationId },
                    at: "current",
                    kind: LegacyLiveArchiveDoc.definition.kind,
                },
                100,
                undefined,
                BACKGROUND_CONTEXT,
            );

            assert.equal(secondNotes.items.length, firstNotes.items.length);
            assert.equal(secondArchives.items.length, firstArchives.items.length);
            assert.equal(secondLiveArchives.items.length, firstLiveArchives.items.length);
            assert.equal(existsSync(sentinel), false);
            assert.equal(
                (await reopened.task(fixture.taskId, BACKGROUND_CONTEXT))?.state.status,
                "terminal",
            );
            assert.equal(
                (await reopened.submission(fixture.submissionId, BACKGROUND_CONTEXT))?.status,
                "unanswered",
            );
        } finally {
            await reopened.close(BACKGROUND_CONTEXT);
        }
    } finally {
        if (threw) {
            // The first commit was durable; the reopened handle above owns the retry.
        }

        await storage.close(BACKGROUND_CONTEXT).catch(() => {});
        rmSync(directory, { recursive: true, force: true });
    }
});

test("archive commit failure leaves the root closure untouched for retry", async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "rotom-legacy-retry-")));
    const path = join(directory, "pocket.sqlite");
    const storage = await openNodeSqliteStorage(path);
    const workspace = join(directory, "workspace");

    mkdirSync(workspace);
    const fixture = await seedLegacySession(storage, workspace);
    const before = await snapshotLegacyClosure(storage, fixture);
    const failing = new Proxy(storage, {
        get(target, property, receiver) {
            if (property === "commit") {
                return async () => {
                    throw new Error("injected archive commit failure");
                };
            }

            const value = Reflect.get(target, property, receiver);

            return typeof value === "function" ? value.bind(target) : value;
        },
    }) as unknown as Storage;

    await assert.rejects(quarantineLegacyTasks(failing), /injected archive commit failure/);
    assert.equal(await snapshotLegacyClosure(storage, fixture), before);
    await storage.close(BACKGROUND_CONTEXT);

    const reopened = await openNodeSqliteStorage(path);

    try {
        assert.equal(await snapshotLegacyClosure(reopened, fixture), before);
        await quarantineLegacyTasks(reopened);
        assert.equal(
            (await reopened.task(fixture.taskId, BACKGROUND_CONTEXT))?.state.status,
            "terminal",
        );
    } finally {
        await reopened.close(BACKGROUND_CONTEXT);
        rmSync(directory, { recursive: true, force: true });
    }
});
