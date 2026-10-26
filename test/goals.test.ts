// Legacy goal execution is disabled by the D9a archive boundary; history and goal reads remain available.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { GoalDoc } from "../src/server/docs.ts";
import {
    type App,
    cleanUp,
    context,
    openApp,
    owner,
    root,
    scriptedModel,
    seedHistoricalSession,
} from "./helpers.ts";

let app: App;

before(async () => {
    app = await openApp(scriptedModel());
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("legacy goal mutation is rejected without running a check", async () => {
    const cwd = join(root, "goal-archive");

    mkdirSync(cwd, { recursive: true });
    const id = await seedHistoricalSession(app, cwd);

    await assert.rejects(
        app.commands.setGoal(id, owner(app), "touch should-not-run"),
        /read-only archive/,
    );
    assert.equal(await app.harness.snapshot(GoalDoc, id, context), undefined);
});

test("legacy goal documents remain readable and completed state is not rewritten", async () => {
    const id = await seedHistoricalSession(app);

    await app.harness.commit(async (tx) => {
        const goal = await tx.doc(GoalDoc, id);

        goal.goal = {
            command: "true",
            by: owner(app).id,
            max: 1,
            tries: 1,
            status: "met",
            counted: [],
        };
    }, BACKGROUND_CONTEXT);

    await app.close();
    app = await openApp(scriptedModel());
    assert.equal((await app.harness.snapshot(GoalDoc, id, context))?.goal?.status, "met");
    await assert.rejects(app.commands.clearGoal(id, owner(app)), /read-only archive/);
});
