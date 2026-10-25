import { snapshot, since, nativeTimingSnapshot, nativeTimingSince } from "./perf/counters.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
    roomPartChannel,
    scopedParseObject,
    storageWorkerChannel,
    type RoomPartSignal,
} from "../src/server/perf-channels.ts";

test("async room counters attribute only their own work across overlapping waits", async () => {
    const db = new DatabaseSync(":memory:");
    const a = Promise.withResolvers<void>();
    const b = Promise.withResolvers<void>();
    const row = () => db.prepare("SELECT 1").get();
    const start = snapshot();
    const project = (part: RoomPartSignal["part"], wait: Promise<void>) =>
        roomPartChannel.runStores({ part }, async () => {
            row();
            await wait;
            row();
            JSON.parse('{"scoped":true}');
            roomPartChannel.publish({ part, ms: 1 });
        });

    try {
        const first = project("kernel", a.promise);

        row();
        const second = project("live", b.promise);

        b.resolve();
        await second;
        row();
        a.resolve();
        await first;
        const work = since(start);

        assert.equal(work["sql.statements"], 6);
        assert.equal(work["view.kernel.sql.statements"], 2);
        assert.equal(work["view.live.sql.statements"], 2);
        assert.equal(work["view.kernel.sql.rows"], 2);
        assert.equal(work["view.live.sql.rows"], 2);
        assert.equal(work["view.kernel.json.parse.calls"], 1);
        assert.equal(work["view.live.json.parse.calls"], 1);
        assert.equal(work["view.kernel.project.calls"], 1);
        assert.equal(work["view.live.project.calls"], 1);
    } finally {
        a.resolve();
        b.resolve();
        db.close();
    }
});

test("splitting the thinking snapshot preserves parse attribution and total work", () => {
    const text = '{"scoped":true}';
    const journal = scopedParseObject("journal", {
        thinkingLevel: () => JSON.parse(text),
        thinkingSnapshot: () => JSON.parse(text),
    });
    const start = snapshot();

    journal.thinkingLevel();
    journal.thinkingSnapshot();
    const work = since(start);

    assert.equal(work["json.parse.calls"], 2);
    assert.equal(work["json.parse.chars"], 2 * text.length);
    assert.equal(work["json.parse.journalThinking.calls"], 2);
    assert.equal(work["json.parse.journalThinking.chars"], 2 * text.length);
    assert.equal(work["json.parse.journal.calls"] ?? 0, 0);
});

test("worker work is counted once with its original room attribution", () => {
    const before = snapshot();
    const timingBefore = nativeTimingSnapshot();

    roomPartChannel.runStores({ part: "kernel" }, () =>
        storageWorkerChannel.publish({
            counters: {
                "sql.statements": 2,
                "view.kernel.sql.statements": 2,
                "view.kernel.sql.heads": 1,
            },
            timings: { v8SerializeMs: 2 },
            workerMs: 3,
            replyBytes: 128,
            requestBytes: 64,
            encodeMs: 1,
            queueMs: 2,
            roundTripMs: 5,
        }),
    );
    const work = since(before);

    assert.equal(work["sql.statements"], 2);
    assert.equal(work["view.kernel.sql.statements"], 2);
    assert.equal(work["view.kernel.sql.heads"], 1);
    assert.equal(work["storage.worker.replyBytes"], 128);
    assert.equal(
        work["storage.worker.queueMs"],
        undefined,
        "time is not a deterministic work counter",
    );
    assert.equal(nativeTimingSince(timingBefore).storageQueueMs, 2);
    assert.equal(nativeTimingSince(timingBefore).storageWorkerV8SerializeMs, 2);
});

test("the same counter driver still measures older synchronous room spans", () => {
    const db = new DatabaseSync(":memory:");
    const start = snapshot();

    try {
        roomPartChannel.publish({ part: "kernel" });
        db.prepare("SELECT 1").get();
        JSON.parse('{"scoped":true}');
        roomPartChannel.publish({ part: "kernel", ms: 1 });
        db.prepare("SELECT 2").get();
        const work = since(start);

        assert.equal(work["sql.statements"], 2);
        assert.equal(work["view.kernel.sql.statements"], 1);
        assert.equal(work["view.kernel.json.parse.calls"], 1);
        assert.equal(work["view.kernel.project.calls"], 1);
    } finally {
        db.close();
    }
});
