import {
    cleanUp,
    context,
    fakeTab,
    newSession,
    openApp,
    owner,
    recordCost,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ConversationId, EntryRecord } from "@earendil-works/pi-durable";
import { viewProjectionChannel, type ViewProjectionSignal } from "../src/server/perf-channels.ts";
import { projectEntry } from "../src/server/projection.ts";
import type { Client, Room } from "../src/server/room.ts";

after(cleanUp);

/** Count only this synchronous projection, not background timers or another room's work. */
function push(room: Room, client: Client, full: boolean): number {
    let visits = 0;

    const listener = (message: unknown) => {
        visits += (message as ViewProjectionSignal).entryVisits;
    };

    viewProjectionChannel.subscribe(listener);

    try {
        room.push(client, full);

        return visits;
    } finally {
        viewProjectionChannel.unsubscribe(listener);
    }
}

const visible = (room: Room) => room.value!.entries.flatMap((entry) => projectEntry(entry) ?? []);

async function append(
    app: Awaited<ReturnType<typeof openApp>>,
    id: ConversationId,
    text: string,
): Promise<EntryRecord> {
    return app.harness.commit(
        (tx) =>
            tx.appendEntry(id, {
                kind: "pi.user",
                model: [{ role: "user", content: text, timestamp: 1 }],
            }),
        context,
    );
}

test("room entry sequence is shared across tabs but invalidates on append and head reset", async () => {
    const app = await openApp(scriptedModel(), join(root, "sequence"));

    try {
        const id = await newSession(app);

        await append(app, id, "first");
        await app.harness.commit((tx) => tx.appendEntry(id, { kind: "pi.system" }), context);
        await append(app, id, "second");
        const room = await app.room(id);
        const first = fakeTab(id, owner(app));
        const second = fakeTab(id, owner(app));
        const source = room.value!.entries;
        const expected = visible(room);

        assert.equal(push(room, first.client, true), source.length);
        assert.deepEqual(first.last("view")!.entries, expected);
        assert.deepEqual(
            first.last("view")!.order,
            expected.map((entry) => entry.id),
        );
        assert.equal(push(room, second.client, true), 0, "another tab reuses the sequence");
        assert.deepEqual(second.last("view")!.entries, expected, "tabs have independent sent sets");
        assert.equal(push(room, first.client, false), 0, "unchanged history is not traversed");
        assert.deepEqual(first.last("view")!.entries, []);
        assert.ok(!("order" in first.last("view")!));
        assert.equal(push(room, first.client, true), 0, "full resend does not invalidate the room");
        assert.deepEqual(first.last("view")!.entries, expected);

        await recordCost(app, id, 3);
        await until(() => room.value!.docs["pi.usage"] !== undefined, "usage doc publication");
        assert.equal(
            room.value!.entries,
            source,
            "Durable keeps entry identity for doc-only commits",
        );
        assert.equal(push(room, first.client, false), 0);
        assert.equal((first.last("view")!.stats as { cost: number }).cost, 3);

        const added = await append(app, id, "third");

        await until(
            () => room.value!.entries.some((entry) => entry.id === added.id),
            "append view",
        );
        assert.notEqual(room.value!.entries, source);
        assert.equal(push(room, first.client, false), room.value!.entries.length);
        assert.deepEqual(first.last("view")!.entries, [projectEntry(added)]);
        assert.deepEqual(
            first.last("view")!.order,
            visible(room).map((entry) => entry.id),
        );
        assert.equal(push(room, second.client, false), 0);
        assert.deepEqual(second.last("view")!.entries, [projectEntry(added)]);

        const head = await app.harness.commit(
            (tx) => tx.appendEntry(id, { kind: "pi.system", head: "self" }),
            context,
        );

        await until(() => room.value!.entries[0]?.id === head.id, "head reset");
        assert.equal(push(room, first.client, false), 1);
        assert.deepEqual(
            first.last("view")!.order,
            [],
            "reset drops old entries from active order",
        );
        assert.deepEqual(first.last("view")!.entries, []);
        assert.equal(push(room, second.client, false), 0);
        assert.deepEqual(second.last("view")!.order, []);
        const afterHead = await append(app, id, "after head");

        await until(() => room.value!.entries.at(-1)?.id === afterHead.id, "post-reset append");
        assert.equal(push(room, first.client, false), 2);
        assert.deepEqual(first.last("view")!.order, [Number(afterHead.id)]);
        assert.deepEqual(first.last("view")!.entries, [projectEntry(afterHead)]);
        assert.equal(push(room, second.client, true), 0);
        assert.deepEqual(second.last("view")!.entries, visible(room));
    } finally {
        await app.close();
    }
});

test("room sequence does not cross a fork or survive restart", async () => {
    const data = join(root, "sequence-restart");
    const model = scriptedModel();
    let app = await openApp(model, data);

    try {
        const id = await newSession(app);

        await say(app, id, "shared prefix");
        const room = await app.room(id);
        const forkAt = room.value!.entries.findLast((entry) => entry.kind === "pi.assistant")!;

        await append(app, id, "parent only");
        await until(
            () =>
                visible(room).some(
                    (entry) => entry.kind === "user" && entry.text === "parent only",
                ),
            "parent append",
        );
        const parentTab = fakeTab(id, owner(app));

        push(room, parentTab.client, true);
        const fork = await app.commands.fork(id, owner(app), { entryId: Number(forkAt.id) });
        const forkRoom = await app.room(fork.id);
        const forkTab = fakeTab(fork.id, owner(app));

        assert.equal(push(forkRoom, forkTab.client, true), forkRoom.value!.entries.length);
        assert.deepEqual(forkTab.last("view")!.entries, visible(forkRoom));
        assert.ok(!JSON.stringify(forkTab.last("view")!.entries).includes("parent only"));
        await app.close();
        app = await openApp(model, data);
        const reopened = await app.room(id);

        assert.equal(push(reopened, parentTab.client, true), reopened.value!.entries.length);
        assert.deepEqual(parentTab.last("view")!.entries, visible(reopened));
        assert.equal(push(reopened, parentTab.client, false), 0);
        assert.deepEqual(parentTab.last("view")!.entries, []);
    } finally {
        await app.close();
    }
});
