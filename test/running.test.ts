// Running now must not expose or resume unfinished legacy Durable work during archive startup.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { runningNow } from "../src/server/running.ts";
import {
    type App,
    cleanUp,
    openApp,
    owner,
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

test("running now does not report quarantined legacy tasks or schedules", async () => {
    const id = await seedHistoricalSession(app);

    assert.deepEqual(await runningNow(app, owner(app)), []);
    await assert.rejects(
        app.commands.schedule(id, owner(app), { when: "in 2h look again", zone: "UTC" }),
        /read-only archive/,
    );
    await assert.rejects(
        app.commands.updateSession(id, owner(app), { title: "must not mutate" }),
        /read-only archive/,
    );
    assert.equal(app.isBusy(id), false);
});
