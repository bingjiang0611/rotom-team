// Archived plan records remain immutable and cannot dispatch work.
import {
    type App,
    cleanUp,
    context,
    seedHistoricalSession,
    openApp,
    owner,
    scriptedModel,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { PlanDoc, SubagentsDoc } from "../src/server/docs.ts";

let app: App;

before(async () => {
    app = await openApp(scriptedModel());
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("legacy plan mutation is rejected without dispatch or file changes", async () => {
    const id = await seedHistoricalSession(app);

    await assert.rejects(app.commands.setPlan(id, owner(app), true), /read-only archive/);
    await assert.rejects(app.commands.approvePlan(id, owner(app)), /read-only archive/);
    assert.equal((await app.harness.snapshot(PlanDoc, id, context))?.on, undefined);
    assert.equal(existsSync(join(work, "planned.txt")), false);
});

test("legacy subagent plan mutation is rejected without creating a child", async () => {
    const id = await seedHistoricalSession(app);

    await assert.rejects(app.commands.setPlan(id, owner(app), true), /read-only archive/);
    assert.deepEqual((await app.harness.snapshot(SubagentsDoc, id, context))?.agents, {});
});

test("legacy plan extension changes remain blocked in archive mode", async () => {
    const id = await seedHistoricalSession(app);

    await assert.rejects(
        app.setExtensionEnabled(owner(app), "plan.ts", false),
        /Agent Extensions only|read-only archive/,
    );
    assert.equal((await app.harness.snapshot(PlanDoc, id, context))?.on, undefined);
});
