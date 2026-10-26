// Session catalogue pushes: versioned full snapshots, changed rows only, per-user visibility and a stream-local resync.
import {
    cleanUp,
    fakeTab,
    seedHistoricalSession,
    openApp,
    owner,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { SessionLists } from "../src/server/session-lists.ts";

type Row = Parameters<SessionLists["prepare"]>[0][number];
const WEB: string = "../web/session-list.js";
const { sessionSnapshot, sessionDelta } = await import(WEB);
const row = (id: number, updatedAt = id, title = `Session ${id}`): Row => ({
    id,
    title,
    cwd: "/fixture",
    createdAt: id,
    updatedAt,
    busy: false,
    waiting: false,
});

const deltaTab = (user: Parameters<typeof fakeTab>[1]) => {
    const tab = fakeTab(undefined, user);

    return { ...tab, client: { ...tab.client, sessionDeltas: true } };
};

/** Fake tabs record synchronously; wait for a scheduled catalogue flush or async permission refresh, bounded. */
async function until(check: () => boolean) {
    const end = Date.now() + 5000;

    while (!check()) {
        assert.ok(Date.now() < end, "session-list update arrived");
        await delay(10);
    }
}

test("session deltas send one full list, no unchanged push, and only the changed rows/removals", () => {
    const lists = new SessionLists();
    const tab = deltaTab({
        id: "fixture",
        name: "Fixture",
        role: "owner",
        tokenHash: "unused",
        createdAt: 0,
    });
    const first = [row(2), row(1)];

    lists.send(tab.client, lists.prepare(first));
    const full = tab.last("sessions")!;

    assert.deepEqual(full.items, first);
    assert.equal(full.version, `${tab.client.connection}:1`);
    lists.send(tab.client, lists.prepare(first));
    assert.equal(tab.events.length, 1, "an unchanged refresh sends nothing");

    const changed = [row(1, 3, "Renamed"), row(2)];

    lists.send(tab.client, lists.prepare(changed));
    const delta = tab.last("sessions-delta")!;

    assert.deepEqual(delta, {
        from: full.version,
        version: `${tab.client.connection}:2`,
        upsert: [changed[0]],
        removed: [],
    });
    const reconstructed = sessionDelta(first, full.version, delta);

    assert.deepEqual(reconstructed.sessions, changed);
    lists.send(tab.client, lists.prepare([]));
    const removed = tab.last("sessions-delta")!;

    assert.deepEqual(removed.upsert, []);
    assert.deepEqual(removed.removed, [1, 2]);
    assert.deepEqual(sessionDelta(changed, delta.version, removed).sessions, []);

    lists.send(tab.client, lists.prepare([row(3)]), true);
    const resync = tab.last("sessions")!;

    assert.equal(resync.version, `${tab.client.connection}:4`);
    assert.deepEqual(resync.items, [row(3)]);
    lists.send(tab.client, lists.prepare([row(3, 4)]));
    assert.equal(tab.last("sessions-delta")!.from, resync.version);
});

test("the browser rejects missing/foreign/duplicate versions and sorts ties like the server", () => {
    const snapshot = sessionSnapshot({ version: "connection:1", items: [row(3), row(1)] });
    const delta = {
        from: "connection:1",
        version: "connection:2",
        upsert: [row(2, 3)],
        removed: [],
    };
    const next = sessionDelta(snapshot.sessions, snapshot.sessionListVersion, delta);

    assert.deepEqual(
        next.sessions.map((item: Row) => item.id),
        [2, 3, 1],
    );
    assert.equal(sessionDelta(next.sessions, next.sessionListVersion, delta), null, "duplicate");
    assert.equal(sessionDelta([], null, delta), null, "no snapshot");
    assert.equal(sessionDelta([], "other-connection:1", delta), null, "another connection");
    assert.equal(
        sessionDelta(next.sessions, next.sessionListVersion, { ...delta, from: "connection:9" }),
        null,
        "missed a delta",
    );
    assert.deepEqual(
        sessionSnapshot([row(1)]),
        {
            sessions: [row(1)],
            sessionListVersion: null,
        },
        "legacy snapshots still work",
    );
});

test("oversized lists fall back to full snapshots without retaining unbounded baselines; legacy tabs stay legacy", () => {
    const lists = new SessionLists();
    const tab = deltaTab({
        id: "fixture",
        name: "Fixture",
        role: "owner",
        tokenHash: "unused",
        createdAt: 0,
    });
    const many = Array.from({ length: 2049 }, (_, index) => row(index));
    const huge = [row(1, 1, "x".repeat(2 * 1024 * 1024))];

    for (const items of [many, huge]) {
        const prepared = lists.prepare(items);

        assert.equal(prepared.encoded, undefined);
        lists.send(tab.client, prepared);
        lists.send(tab.client, prepared);
        assert.deepEqual(tab.last("sessions")!.items, items);
    }

    assert.ok(tab.events.every(({ event }) => event === "sessions"));
    const legacy = fakeTab(undefined, tab.client.user);

    lists.send(legacy.client, lists.prepare([row(1)]));
    lists.send(legacy.client, lists.prepare([row(1)]));
    assert.equal(legacy.events.length, 2);
    assert.deepEqual(legacy.last("sessions"), [row(1)]);
});

test("each tab has its own permitted rows and versions; resync cannot target another user; revocation resets the list", async () => {
    const app = await openApp(scriptedModel());

    try {
        const first = await seedHistoricalSession(app);
        const hidden = await seedHistoricalSession(app);
        const scoped = app.config.addUser("Scoped", "guest", [String(first)]).user;
        const all = app.config.addUser("All", "guest").user;
        const own = deltaTab(owner(app));
        const guest = deltaTab(scoped);
        const wide = deltaTab(all);

        await app.attach(own.client);
        await app.attach(guest.client);
        await app.attach(wide.client);
        assert.deepEqual(
            (guest.last("sessions")!.items as Row[]).map((item) => item.id),
            [first],
        );
        await delay(450); // Let attach's scheduled presence/catalogue refresh settle.
        guest.events.length = 0;
        own.events.length = 0;

        await assert.rejects(
            app.commands.updateSession(hidden, owner(app), { title: "Private rename" }),
            /read-only archive/,
        );
        assert.equal(own.last("sessions-delta"), undefined);
        assert.equal(
            guest.events.some((each) => each.event.startsWith("sessions")),
            false,
        );
        await assert.rejects(
            async () => await app.resyncSessionList(scoped, own.client.connection),
            { status: 404 },
        );
        await app.resyncSessionList(scoped, guest.client.connection);
        assert.deepEqual(
            (guest.last("sessions")!.items as Row[]).map((item) => item.id),
            [first],
        );

        // Restrict a previously wide-open tab. Its fresh snapshot must contain no hidden row, and no later delta leaks it.
        const previous = wide.last("sessions")!.version;

        app.setAccess(owner(app), all.id, { sessions: [String(first)] });
        await until(() => wide.last("sessions")!.version !== previous);
        assert.deepEqual(
            (wide.last("sessions")!.items as Row[]).map((item) => item.id),
            [first],
        );
        wide.events.length = 0;
        await assert.rejects(
            app.commands.updateSession(hidden, owner(app), { title: "Still private" }),
            /read-only archive/,
        );
        await delay(100);
        assert.equal(
            wide.events.some((each) => each.event.startsWith("sessions")),
            false,
        );
        app.detach(own.client);
        app.detach(guest.client);
        app.detach(wide.client);
        await assert.rejects(
            async () => await app.resyncSessionList(scoped, guest.client.connection),
            {
                status: 404,
            },
        );
    } finally {
        await app.close();
        cleanUp();
    }
});
