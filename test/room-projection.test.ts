import {
    appendHistoricalTurn,
    cleanUp,
    context,
    fakeTab,
    seedHistoricalSession,
    openApp,
    owner,
    recordCost,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ConversationId, EntryRecord } from "@earendil-works/pi-durable";
import { ARCHIVE_COPY } from "../src/server/constants/copy.ts";
import { viewProjectionChannel, type ViewProjectionSignal } from "../src/server/perf-channels.ts";
import { projectEntry } from "../src/server/projection.ts";
import type { Client, Room } from "../src/server/room.ts";
import { AuthorsDoc } from "../src/server/docs.ts";

after(cleanUp);

/** Count only this synchronous projection, not background timers or another room's work. */
async function measuredPush(
    room: Room,
    client: Client,
    full: boolean,
): Promise<{ entryVisits: number; clientEntryScans: number; statsEntryScans: number }> {
    const measured = { entryVisits: 0, clientEntryScans: 0, statsEntryScans: 0 };

    const listener = (message: unknown) => {
        const signal = message as ViewProjectionSignal;

        measured.entryVisits += signal.entryVisits ?? 0;
        measured.clientEntryScans += signal.clientEntryScans ?? 0;
        measured.statsEntryScans += signal.statsEntryScans ?? 0;
    };

    viewProjectionChannel.subscribe(listener);

    try {
        await room.push(client, full);

        return measured;
    } finally {
        viewProjectionChannel.unsubscribe(listener);
    }
}

const push = async (room: Room, client: Client, full: boolean) =>
    (await measuredPush(room, client, full)).entryVisits;

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

async function appendAnswer(
    app: Awaited<ReturnType<typeof openApp>>,
    id: ConversationId,
    text: string,
    usage: { input: number; output: number; cacheRead: number; cacheWrite: number },
): Promise<EntryRecord> {
    return app.harness.commit(
        (tx) =>
            tx.appendEntry(id, {
                kind: "pi.assistant",
                model: [
                    {
                        role: "assistant",
                        api: "faux",
                        provider: "faux",
                        model: "faux-1",
                        content: [{ type: "text", text }],
                        usage: {
                            ...usage,
                            totalTokens:
                                usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
                            cost: {
                                input: 0,
                                output: 0,
                                cacheRead: 0,
                                cacheWrite: 0,
                                total: 0,
                            },
                        },
                        stopReason: "stop",
                        timestamp: 1,
                    },
                ],
            }),
        context,
    );
}

test("room fields serialize once per fanout while each tab keeps independent deltas", async () => {
    const app = await openApp(scriptedModel(), join(root, "fields-fanout"));

    try {
        const id = await seedHistoricalSession(app);
        const record = await append(app, id, "fields");
        const room = await app.room(id);
        const first = fakeTab(id, owner(app));
        const second = fakeTab(id, owner(app));
        let calls = 0;

        const listener = (message: unknown) => {
            calls += (message as ViewProjectionSignal).fieldStringifyCalls ?? 0;
        };

        viewProjectionChannel.subscribe(listener);

        try {
            await room.push(first.client, true);
            assert.deepEqual(first.last("view")!.readOnly, { reason: ARCHIVE_COPY.readOnly });
            const single = calls;

            assert.ok(single > 0);
            room.clients.add(first.client);
            room.clients.add(second.client);
            calls = 0;
            await room.pushAll();
            assert.equal(calls, single, "two tabs cost one field serialization set");
            assert.ok(
                !("authors" in first.last("view")!),
                "unchanged tab receives no repeated field",
            );
            assert.ok("authors" in second.last("view")!, "new tab still receives all fields");
            await app.harness.commit(async (tx) => {
                (await tx.doc(AuthorsDoc, id)).entries[String(record.id)] = owner(app).id;
            }, context);
            calls = 0;
            await room.pushAll(first.client);
            assert.equal(calls, single, "full and incremental clients share one fresh projection");
            assert.deepEqual(first.last("view")!.authors, second.last("view")!.authors);
            assert.equal(
                (first.last("view")!.authors as Record<string, string>)[String(record.id)],
                owner(app).id,
            );
        } finally {
            viewProjectionChannel.unsubscribe(listener);
        }
    } finally {
        await app.close();
    }
});

test("room entry sequence is shared across tabs but invalidates on append and head reset", async () => {
    const app = await openApp(scriptedModel(), join(root, "sequence"));

    try {
        const id = await seedHistoricalSession(app);

        await append(app, id, "first");
        await app.harness.commit((tx) => tx.appendEntry(id, { kind: "pi.system" }), context);
        await append(app, id, "second");
        const room = await app.room(id);
        const first = fakeTab(id, owner(app));
        const second = fakeTab(id, owner(app));
        const source = room.value!.entries;
        const expected = visible(room);

        const firstFull = await measuredPush(room, first.client, true);

        assert.equal(firstFull.entryVisits, source.length);
        assert.equal(firstFull.clientEntryScans, expected.length);
        assert.deepEqual(first.last("view")!.entries, expected);
        assert.deepEqual(
            first.last("view")!.order,
            expected.map((entry) => entry.id),
        );
        const secondFull = await measuredPush(room, second.client, true);

        assert.equal(secondFull.entryVisits, 0, "another tab reuses the sequence");
        assert.equal(secondFull.clientEntryScans, expected.length, "a full tab sends every entry");
        assert.deepEqual(second.last("view")!.entries, expected, "tabs have independent sent sets");
        const unchanged = await measuredPush(room, first.client, false);

        assert.equal(unchanged.entryVisits, 0, "unchanged history is not traversed");
        assert.equal(unchanged.clientEntryScans, 0, "unchanged clients do not scan the cache");
        assert.deepEqual(first.last("view")!.entries, []);
        assert.ok(!("order" in first.last("view")!));
        const resent = await measuredPush(room, first.client, true);

        assert.equal(resent.entryVisits, 0, "full resend does not invalidate the room");
        assert.equal(resent.clientEntryScans, expected.length);
        assert.deepEqual(first.last("view")!.entries, expected);

        await recordCost(app, id, 3);
        await until(() => room.value!.docs["pi.usage"] !== undefined, "usage doc publication");
        assert.equal(
            room.value!.entries,
            source,
            "Durable keeps entry identity for doc-only commits",
        );
        assert.equal(await push(room, first.client, false), 0);
        assert.equal((first.last("view")!.stats as { cost: number }).cost, 3);

        const added = await append(app, id, "third");

        await until(
            () => room.value!.entries.some((entry) => entry.id === added.id),
            "append view",
        );
        assert.notEqual(room.value!.entries, source);
        const appended = await measuredPush(room, first.client, false);

        assert.equal(appended.entryVisits, room.value!.entries.length);
        assert.equal(appended.clientEntryScans, 1, "append scans only the visible tail");
        assert.deepEqual(first.last("view")!.entries, [projectEntry(added)]);
        assert.deepEqual(
            first.last("view")!.order,
            visible(room).map((entry) => entry.id),
        );
        const secondAppend = await measuredPush(room, second.client, false);

        assert.equal(secondAppend.entryVisits, 0);
        assert.equal(secondAppend.clientEntryScans, 1);
        assert.deepEqual(second.last("view")!.entries, [projectEntry(added)]);

        const head = await app.harness.commit(
            (tx) =>
                tx.appendEntry(id, {
                    kind: "pi.user",
                    head: "self",
                    model: [{ role: "user", content: "reset", timestamp: 1 }],
                }),
            context,
        );

        await until(() => room.value!.entries[0]?.id === head.id, "head reset");
        const reset = await measuredPush(room, first.client, false);

        assert.equal(reset.entryVisits, 1);
        assert.equal(reset.clientEntryScans, 1, "reset falls back to the active sequence");
        assert.deepEqual(
            first.last("view")!.order,
            [Number(head.id)],
            "reset drops old entries from active order",
        );
        assert.deepEqual(first.last("view")!.entries, [projectEntry(head)]);
        const secondReset = await measuredPush(room, second.client, false);

        assert.equal(secondReset.entryVisits, 0);
        assert.equal(secondReset.clientEntryScans, 1);
        assert.deepEqual(second.last("view")!.order, [Number(head.id)]);
        const afterHead = await append(app, id, "after head");

        await until(() => room.value!.entries.at(-1)?.id === afterHead.id, "post-reset append");
        const afterReset = await measuredPush(room, first.client, false);

        assert.equal(afterReset.entryVisits, 2);
        assert.equal(afterReset.clientEntryScans, 1);
        assert.deepEqual(first.last("view")!.order, [Number(head.id), Number(afterHead.id)]);
        assert.deepEqual(first.last("view")!.entries, [projectEntry(afterHead)]);
        assert.equal(await push(room, second.client, true), 0);
        assert.deepEqual(second.last("view")!.entries, visible(room));
    } finally {
        await app.close();
    }
});

test("client cursors skip hidden appends and rescan safely after missed sequence revisions", async () => {
    const app = await openApp(scriptedModel(), join(root, "client-cursors"));

    try {
        const id = await seedHistoricalSession(app);

        await append(app, id, "prefix");
        const room = await app.room(id);
        const first = fakeTab(id, owner(app));
        const behind = fakeTab(id, owner(app));

        await measuredPush(room, first.client, true);
        await measuredPush(room, behind.client, true);
        const hidden = await app.harness.commit(
            (tx) => tx.appendEntry(id, { kind: "pi.system" }),
            context,
        );

        await until(() => room.value!.entries.at(-1)?.id === hidden.id, "hidden append");
        assert.equal((await measuredPush(room, first.client, false)).clientEntryScans, 0);
        assert.deepEqual(first.last("view")!.entries, []);
        assert.ok(!("order" in first.last("view")!));
        const added = await append(app, id, "visible tail");

        await until(() => room.value!.entries.at(-1)?.id === added.id, "visible append");
        assert.equal((await measuredPush(room, first.client, false)).clientEntryScans, 1);
        assert.deepEqual(first.last("view")!.entries, [projectEntry(added)]);
        assert.equal(
            (await measuredPush(room, behind.client, false)).clientEntryScans,
            visible(room).length,
            "a lagging tab falls back to sent-ID filtering over the active sequence",
        );
        assert.deepEqual(behind.last("view")!.entries, [projectEntry(added)]);
        const beforeReset = await append(app, id, "before suffix reset");

        await until(() => room.value!.entries.at(-1)?.id === beforeReset.id, "suffix entry");
        await measuredPush(room, first.client, false);
        const marker = await app.harness.commit(
            (tx) => tx.appendEntry(id, { kind: "pi.system", head: added.id }),
            context,
        );

        await until(() => room.value!.entries[0]?.id === marker.id, "suffix head reset");
        assert.equal(
            (await measuredPush(room, first.client, false)).clientEntryScans,
            visible(room).length,
        );
        assert.deepEqual(first.last("view")!.entries, [], "retained suffix is not retransmitted");
        assert.deepEqual(first.last("view")!.order, [Number(added.id), Number(beforeReset.id)]);
        assert.equal(
            (await measuredPush(room, behind.client, false)).clientEntryScans,
            visible(room).length,
        );
        assert.deepEqual(behind.last("view")!.entries, [projectEntry(beforeReset)]);
        assert.deepEqual(behind.last("view")!.order, [Number(added.id), Number(beforeReset.id)]);
    } finally {
        await app.close();
    }
});

test("room stats are shared across tabs and invalidate on usage, append and head reset", async () => {
    const app = await openApp(scriptedModel(), join(root, "stats"));

    try {
        const id = await seedHistoricalSession(app);

        await append(app, id, "first");
        const room = await app.room(id);
        const first = fakeTab(id, owner(app));
        const second = fakeTab(id, owner(app));

        assert.equal(
            (await measuredPush(room, first.client, true)).statsEntryScans,
            room.value!.entries.length,
        );
        assert.equal(
            (await measuredPush(room, second.client, true)).statsEntryScans,
            0,
            "another tab reuses stats",
        );
        const usage = room.value!.docs["pi.usage"];

        await recordCost(app, id, 3);
        await until(() => room.value!.docs["pi.usage"] !== usage, "usage revision");
        assert.equal(
            (await measuredPush(room, first.client, false)).statsEntryScans,
            room.value!.entries.length,
        );
        assert.equal((first.last("view")!.stats as { cost: number }).cost, 3);
        assert.equal((await measuredPush(room, second.client, false)).statsEntryScans, 0);
        assert.equal((second.last("view")!.stats as { cost: number }).cost, 3);
        const answer = await appendAnswer(app, id, "answer", {
            input: 10,
            output: 4,
            cacheRead: 6,
            cacheWrite: 2,
        });

        await until(() => room.value!.entries.at(-1)?.id === answer.id, "answer append");
        assert.equal((await measuredPush(room, first.client, false)).statsEntryScans, 1);
        assert.deepEqual(first.last("view")!.stats, {
            cost: 3,
            contextTokens: 22,
        });
        assert.equal((await measuredPush(room, first.client, true)).statsEntryScans, 0);
        const head = await app.harness.commit(
            (tx) => tx.appendEntry(id, { kind: "pi.system", head: "self" }),
            context,
        );

        await until(() => room.value!.entries[0]?.id === head.id, "stats head reset");
        assert.equal((await measuredPush(room, first.client, false)).statsEntryScans, 1);
        assert.deepEqual(first.last("view")!.stats, { cost: 3 });
        assert.equal((await measuredPush(room, second.client, true)).statsEntryScans, 0);
    } finally {
        await app.close();
    }
});

test("room sequence survives archive restart and legacy fork mutation is rejected", async () => {
    const data = join(root, "sequence-restart");
    const model = scriptedModel();
    let app = await openApp(model, data);

    try {
        const id = await seedHistoricalSession(app);

        await appendHistoricalTurn(app, id, "shared prefix", "historical answer");
        const room = await app.room(id);
        const parentTab = fakeTab(id, owner(app));

        assert.equal(await push(room, parentTab.client, true), room.value!.entries.length);
        const before = room.value!.entries.length;

        await assert.rejects(
            app.commands.fork(id, owner(app), { entryId: Number(room.value!.entries.at(-1)!.id) }),
            /read-only archive/,
        );
        await app.close();
        app = await openApp(model, data);
        const reopened = await app.room(id);

        assert.equal(reopened.value!.entries.length, before);
        assert.equal(await push(reopened, parentTab.client, false), reopened.value!.entries.length);
    } finally {
        await app.close();
    }
});
