// Scheduled messages: reading times as people write them, and durable tasks that send them later, across restarts.
import { context, seedHistoricalSession, openApp, owner, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { ScheduleDoc } from "../src/server/docs.ts";
import {
    describeMoment,
    describeRepeat,
    nextClockTime,
    parseWhen,
    zonedMoment,
} from "../src/server/when.ts";

const iso = (moment: number) => new Date(moment).toISOString();
/** Sunday, October 4, 2026, 10:00 in Chicago (15:00 UTC). */
const sunday = Date.UTC(2026, 9, 4, 15, 0);
const chicago = "America/Chicago";

test("times read the way people write them, in their time zone", () => {
    const when = (text: string) => {
        const parsed = parseWhen(text, sunday, chicago);

        return [
            iso(parsed.next),
            parsed.every === undefined ? "once" : describeRepeat(parsed.every),
            parsed.rest,
        ];
    };

    assert.deepEqual(when("in 30m check the build"), [
        "2026-10-04T15:30:00.000Z",
        "once",
        "check the build",
    ]);
    assert.deepEqual(when("in 1.5 hours x"), ["2026-10-04T16:30:00.000Z", "once", "x"]);
    assert.deepEqual(
        when("7:00 x"),
        ["2026-10-05T12:00:00.000Z", "once", "x"],
        "7:00 has passed today: tomorrow",
    );
    assert.deepEqual(when("7pm x"), ["2026-10-05T00:00:00.000Z", "once", "x"]);
    assert.deepEqual(when("Tomorrow 9am x"), ["2026-10-05T14:00:00.000Z", "once", "x"]);
    assert.deepEqual(when("fri 17:30 x"), ["2026-10-09T22:30:00.000Z", "once", "x"]);
    assert.deepEqual(when("every 2h x"), ["2026-10-04T17:00:00.000Z", "every 2 hours", "x"]);
    assert.deepEqual(when("every day 8:00 x"), [
        "2026-10-05T13:00:00.000Z",
        "every day at 08:00",
        "x",
    ]);
    assert.deepEqual(when("every weekday 8:00 x"), [
        "2026-10-05T13:00:00.000Z",
        "weekdays at 08:00",
        "x",
    ]);
    assert.deepEqual(when("every tues,thursday 9:00 x"), [
        "2026-10-06T14:00:00.000Z",
        "tue, thu at 09:00",
        "x",
    ]);
    assert.deepEqual(
        when("every weekend 10am x"),
        ["2026-10-10T15:00:00.000Z", "weekends at 10:00", "x"],
        "10:00 today is now, not after it",
    );

    for (const [text, problem] of [
        ["every 5m x", /at most every 10 minutes/],
        ["every 2 days 8:00 x", /not both/],
        ["every 2 days at 8:00 x", /not both/],
        ["today 9:00 x", /09:00 today has passed/],
        ["in 0.001h x", /Say when/],
        ["soon x", /Say when/],
        ["25:00 x", /Say when/],
        ["13pm x", /Say when/],
        ["every fun 9:00 x", /Say when/],
        ["in 400 days x", /a year ahead/],
    ] as const) {
        assert.throws(() => parseWhen(text, sunday, chicago), problem, text);
    }
});

test("clock times hold across daylight saving changes", () => {
    assert.equal(
        iso(zonedMoment(2026, 3, 8, 2, 30, chicago)),
        "2026-03-08T08:30:00.000Z",
        "skipped 2:30 becomes 3:30",
    );
    assert.equal(
        iso(zonedMoment(2026, 11, 1, 1, 30, chicago)),
        "2026-11-01T06:30:00.000Z",
        "a 1:30 that happens twice is the first",
    );
    assert.equal(iso(zonedMoment(2026, 10, 4, 8, 0, "Europe/Berlin")), "2026-10-04T06:00:00.000Z");
    // Every day at 8:00 in Chicago, from the Saturday before clocks go back.
    const saturday = nextClockTime(Date.UTC(2026, 9, 31, 12), "08:00", undefined, chicago);
    const sundayAfter = nextClockTime(saturday, "08:00", undefined, chicago);

    assert.deepEqual(
        [iso(saturday), iso(sundayAfter)],
        ["2026-10-31T13:00:00.000Z", "2026-11-01T14:00:00.000Z"],
    );
    assert.equal(describeMoment(Date.UTC(2026, 9, 5, 12), chicago, sunday), "Mon 07:00");
    assert.equal(describeMoment(Date.UTC(2026, 9, 20, 12), chicago, sunday), "Oct 20 07:00");
});

test("legacy schedules remain readable but cannot be created, listed, or cancelled", async () => {
    const app = await openApp(scriptedModel(), join(root, "schedule-archive"));

    try {
        const id = await seedHistoricalSession(app);

        await assert.rejects(
            app.commands.schedule(id, owner(app), { when: "in 15m", zone: "UTC" }),
            /read-only archive/,
        );
        await assert.rejects(
            app.commands.cancelSchedule(id, owner(app), "missing"),
            /read-only archive/,
        );
        const viewer = app.config.addUser("Schedule viewer", "viewer").user;

        await assert.rejects(
            app.commands.schedule(id, viewer, { when: "in 15m", zone: "UTC" }),
            /read-only archive/,
        );
        assert.equal((await app.harness.snapshot(ScheduleDoc, id, context))?.items, undefined);
    } finally {
        await app.close();
    }
});

test("a scheduled legacy message rejects mutation without claiming restart coverage", async () => {
    const app = await openApp(scriptedModel(), join(root, "schedule-restart"));

    try {
        const id = await seedHistoricalSession(app);

        await assert.rejects(
            app.commands.schedule(id, owner(app), { when: "in 10m", zone: "UTC" }),
            /read-only archive/,
        );
        assert.equal((await app.harness.snapshot(ScheduleDoc, id, context))?.items, undefined);
    } finally {
        await app.close();
    }
});

test("Pi cannot schedule, list, or cancel legacy messages through a tool", async () => {
    const app = await openApp(scriptedModel(), join(root, "schedule-tool"));

    try {
        const id = await seedHistoricalSession(app);

        await assert.rejects(
            app.commands.schedule(id, owner(app), { when: "in 10m", zone: "UTC" }),
            /read-only archive/,
        );
        await assert.rejects(
            app.commands.cancelSchedule(id, owner(app), "missing"),
            /read-only archive/,
        );
    } finally {
        await app.close();
    }
});

test("a legacy schedule cannot retain work ownership or cancellation state", async () => {
    const app = await openApp(scriptedModel(), join(root, "schedule-owner"));

    try {
        const id = await seedHistoricalSession(app);
        const guest = app.config.addUser("Schedule owner", "guest").user;

        await assert.rejects(
            app.commands.schedule(id, guest, { when: "in 10m", zone: "UTC" }),
            /read-only archive/,
        );
    } finally {
        await app.close();
    }
});

test("people cannot change legacy schedules when the session is archived", async () => {
    const app = await openApp(scriptedModel(), join(root, "schedule-permissions"));

    try {
        const id = await seedHistoricalSession(app);
        const viewer = app.config.addUser("Schedule viewer", "viewer").user;

        await assert.rejects(
            app.commands.cancelSchedule(id, viewer, "missing"),
            /read-only archive/,
        );
    } finally {
        await app.close();
    }
});
