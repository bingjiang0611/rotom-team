// The archive boundary must reach the real client, not only the server-side room snapshot.
import {
    cleanUp,
    context,
    seedHistoricalSession,
    appendHistoricalTurn,
    until,
    owner,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ARCHIVE_COPY } from "../src/server/constants/copy.ts";
import { GoalDoc, PlanDoc, ScheduleDoc } from "../src/server/docs.ts";
import { withAppPage } from "./fixtures/app-browser.ts";

after(cleanUp);

for (const transport of ["stream", "poll"] as const) {
    test(`archive status reaches the composer and clears on native navigation (${transport})`, async () => {
        await withAppPage(async (evaluate, app) => {
            const nativeId = await evaluate("appCommitFixture.state().view.conversation.id");
            const historicalId = await seedHistoricalSession(app);
            const completedGoalId = await seedHistoricalSession(app);
            const archiveAt = Date.now();

            await app.harness.commit(async (tx) => {
                const plan = await tx.doc(PlanDoc, historicalId);

                plan.on = false;
                plan.archive = {
                    status: "aborted",
                    at: archiveAt,
                    reason: ARCHIVE_COPY.taskAbortReason,
                    text: "The unfinished plan was stopped.",
                };
                const goal = await tx.doc(GoalDoc, historicalId);

                goal.goal = {
                    command: "npm test -- archive",
                    by: "fixture",
                    max: 3,
                    tries: 1,
                    status: "working",
                    counted: [],
                    archive: {
                        status: "aborted",
                        at: archiveAt,
                        reason: ARCHIVE_COPY.taskAbortReason,
                        text: "The unfinished goal was stopped.",
                    },
                };
                const schedules = await tx.doc(ScheduleDoc, historicalId);

                schedules.items = {};
                const completed = await tx.doc(GoalDoc, completedGoalId);

                completed.goal = {
                    command: "npm run verify",
                    by: "fixture",
                    max: 3,
                    tries: 2,
                    status: "met",
                    counted: [],
                };
            }, context);

            await appendHistoricalTurn(
                app,
                historicalId,
                "Historical archive message",
                "Stored reply",
            );
            await evaluate(
                `import('/store.js').then(({ navigate }) => { navigate(${historicalId}); return true; })`,
            );
            await until(
                async () =>
                    await evaluate(
                        `appCommitFixture.state().view.conversation?.id === ${historicalId} && document.body.textContent.includes('Historical archive message')`,
                    ),
                "historical transcript loaded",
            );
            assert.equal(
                await evaluate("appCommitFixture.state().view.readOnly?.reason ?? null"),
                ARCHIVE_COPY.readOnly,
            );
            assert.equal(await evaluate("Boolean(document.querySelector('.plan-bar'))"), true);
            assert.equal(
                await evaluate(
                    "document.querySelector('.plan-bar')?.textContent.includes('unfinished plan')",
                ),
                true,
            );
            assert.equal(
                await evaluate("Boolean(document.querySelector('.plan-bar button'))"),
                false,
            );
            assert.equal(await evaluate("Boolean(document.querySelector('.goal-bar'))"), true);
            assert.equal(
                await evaluate(
                    "document.querySelector('.goal-bar')?.textContent.includes('npm test -- archive')",
                ),
                true,
            );
            assert.equal(
                await evaluate("Boolean(document.querySelector('.goal-bar button'))"),
                false,
            );
            await evaluate(
                "import('/store.js').then(({ openSheet }) => { openSheet({ type: 'schedules' }); return true; })",
            );
            await until(
                async () => await evaluate("Boolean(document.querySelector('.sheet'))"),
                "archive schedules sheet",
            );
            assert.equal(await evaluate("Boolean(document.querySelector('.sheet input'))"), false);
            assert.equal(
                await evaluate(
                    "document.querySelector('.sheet')?.textContent.includes('Nothing is scheduled.')",
                ),
                true,
            );
            await evaluate(
                `import('/store.js').then(({ navigate }) => { navigate(${completedGoalId}); return true; })`,
            );
            await until(
                async () =>
                    await evaluate(
                        `appCommitFixture.state().view.conversation?.id === ${completedGoalId}`,
                    ),
                "completed historical goal",
            );
            assert.equal(
                await evaluate(
                    "document.querySelector('.goal-bar')?.textContent.includes('npm run verify')",
                ),
                true,
            );
            assert.equal(
                await evaluate("Boolean(document.querySelector('.goal-bar button'))"),
                false,
            );
            await evaluate("appCommitFixture.flush().then(() => true)");
            assert.equal(
                await evaluate("Boolean(document.querySelector('.composer textarea'))"),
                false,
            );
            assert.equal(
                await evaluate(
                    `document.body.textContent.includes(${JSON.stringify(ARCHIVE_COPY.readOnly)})`,
                ),
                true,
            );
            await evaluate(
                `import('/store.js').then(({ navigate }) => { navigate(${nativeId}); return true; })`,
            );
            await until(
                async () =>
                    await evaluate(
                        `appCommitFixture.state().view.conversation?.id === ${nativeId} && Boolean(document.querySelector('.composer textarea'))`,
                    ),
                "native composer restored",
            );
            assert.equal(await evaluate("appCommitFixture.state().view.readOnly"), null);
            const guest = app.config.addUser("Archive budget reader", "guest").user;
            const summary = await app.spend.summary(owner(app));
            const nativeTitle = summary.sessions.find((session) => session.id === nativeId)!.title;
            const archiveTitles = new Set(
                summary.sessions
                    .filter((session) => session.readOnly)
                    .map((session) => session.title),
            );

            await evaluate(
                "import('/store.js').then(({ openSheet }) => { openSheet({ type: 'spend' }); return true; })",
            );
            await until(
                async () => await evaluate("document.querySelectorAll('.spend-row').length >= 5"),
                "spend rows loaded",
            );
            const rows = (await evaluate(
                "[...document.querySelectorAll('.spend-row')].map(row => ({ title: row.querySelector('.grow').textContent.trim(), editable: Boolean(row.querySelector('button')) }))",
            )) as { title: string; editable: boolean }[];
            const archivedRows = rows.filter((row) => archiveTitles.has(row.title));

            assert.equal(archivedRows.length, 2);
            assert.ok(
                archivedRows.every((row) => !row.editable),
                "archive limits are readable, not editable",
            );
            assert.equal(rows.find((row) => row.title === nativeTitle)?.editable, true);
            assert.equal(rows.find((row) => row.title === guest.name)?.editable, true);
        }, transport);
    });
}
