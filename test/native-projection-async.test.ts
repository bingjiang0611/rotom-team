import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { PocketApp } from "../src/server/app.ts";
import { viewProjectionChannel, type ViewProjectionSignal } from "../src/server/perf-channels.ts";
import { cleanUp, fakeTab, noInferenceModels, owner, root, work } from "./helpers.ts";

after(cleanUp);

async function fixture(t: TestContext, name: string) {
    const app = await PocketApp.open({
        dataDir: join(realpathSync(root), name),
        defaultCwd: realpathSync(work),
        supervised: false,
        kernel: true,
        browser: null,
        log: () => {},
        configureUserModels: noInferenceModels,
    });

    t.after(() => app.close());
    const { id } = await app.commands.createSession(owner(app), { backend: "rotom" });
    const room = await app.room(id);

    await room.pushAll();
    const user = app.config.addUser("Reader", "guest", [String(id)]).user;
    const tab = fakeTab(id, user);

    tab.client.subscriptionGeneration = 1;
    tab.client.sentEntries.add(777);
    tab.client.sentFields = new Map([["old", "kept"]]);
    room.clients.add(tab.client);

    return { app, id, room, user, tab };
}

for (const outcome of ["generation", "revoked", "detached", "failure", "close"] as const) {
    test(`native projection ${outcome} during an awaited read cannot publish stale data or mutate client caches`, async (t) => {
        const f = await fixture(t, `native-projection-${outcome}`);
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const original = f.app.kernel!.roomInfo.bind(f.app.kernel);
        let reads = 0;

        f.app.kernel!.roomInfo = async (id) => {
            const info = await original(id);
            const read = ++reads;

            if (read === 1) {
                entered.resolve();
                await release.promise;

                if (outcome === "failure") {
                    throw new Error("Delayed projection failed");
                }
            }

            return { ...info, goal: { read } };
        };

        const pending = f.room.push(f.tab.client, true)!;
        let closing: Promise<void> | undefined;

        try {
            await entered.promise;
            assert.deepEqual([...f.tab.client.sentEntries], [777]);
            assert.deepEqual([...f.tab.client.sentFields!], [["old", "kept"]]);
            assert.equal(f.tab.last("view"), undefined);

            if (outcome === "generation") {
                f.tab.client.subscriptionGeneration = 2;
                assert.equal(
                    f.room.push(f.tab.client, true),
                    pending,
                    "coalesced callers share one completion",
                );
            } else if (outcome === "revoked") {
                f.app.config.updateUser(f.user.id, { sessions: [] });
            } else if (outcome === "detached") {
                f.room.clients.delete(f.tab.client);
            } else if (outcome === "close") {
                closing = f.room.close();
            }
        } finally {
            release.resolve();
        }

        if (outcome === "failure") {
            await assert.rejects(pending, /Delayed projection failed/);
        } else {
            await pending;
        }

        await closing;

        if (outcome === "generation") {
            assert.equal(reads, 2);
            assert.equal(f.tab.events.filter(({ event }) => event === "view").length, 1);
            assert.deepEqual(f.tab.field("nativeGoal"), { read: 2 });
        } else {
            assert.equal(f.tab.last("view"), undefined);
            assert.deepEqual([...f.tab.client.sentEntries], [777]);
            assert.deepEqual([...f.tab.client.sentFields!], [["old", "kept"]]);
        }
    });
}

test("async native fanout shares public fields but reads each member's own safety state", async (t) => {
    const f = await fixture(t, "native-projection-fanout");
    let fields = 0;

    const listener = (value: unknown) => {
        fields += (value as ViewProjectionSignal).fieldStringifyCalls ?? 0;
    };

    viewProjectionChannel.subscribe(listener);
    t.after(() => viewProjectionChannel.unsubscribe(listener));
    await f.room.push(f.tab.client, true);
    const one = fields;
    const second = fakeTab(f.id, f.user);
    const third = fakeTab(f.id, owner(f.app));

    f.room.clients.add(second.client);
    f.room.clients.add(third.client);
    const roomInfo = f.app.kernel!.roomInfo.bind(f.app.kernel);
    const roomState = f.app.kernel!.roomState.bind(f.app.kernel);
    const members: string[] = [];
    let reads = 0;

    f.app.kernel!.roomInfo = async (id) => {
        reads++;

        return roomInfo(id);
    };

    f.app.kernel!.roomState = async (id, user) => {
        members.push(user.id);

        return roomState(id, user);
    };

    fields = 0;
    await f.room.pushAll();
    assert.ok(one > 0);
    assert.equal(fields, one);
    assert.equal(reads, 1);
    assert.deepEqual(members, [f.user.id, f.user.id, owner(f.app).id]);
    assert.ok(second.last("view"));
    assert.ok(third.last("view"));
});
