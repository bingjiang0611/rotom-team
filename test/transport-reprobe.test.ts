// Exercise the production transport lifecycle with a deterministic clock and controlled network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { harness, HOUR } from "./fixtures/transport-harness.ts";

test("an incomplete stream falls back, actively reprobes in an hour, and returns to poll if still buffered", async () => {
    const h = harness();

    h.context.connect();
    h.streams[0]!.onopen?.();
    h.streams[0]!.emit("hello");
    await h.tick(6000);
    assert.equal(h.streams[0]!.readyState, 2);
    assert.equal(h.polls.length, 1);
    await h.tick(HOUR - 1);
    assert.equal(h.streams.length, 1);
    await h.tick(1);
    assert.equal(h.streams.length, 2, "reprobe without navigation");
    assert.equal(h.polls[0]!.signal.aborted, true);
    await h.tick(6000);
    assert.equal(h.streams[1]!.readyState, 2);
    assert.equal(h.polls.length, 2);
    assert.equal(h.maxPolls(), 1);
    assert.deepEqual(h.transitions, [
        "stream-initial-timeout:stream->poll",
        "poll-hourly-reprobe:poll->stream",
        "stream-initial-timeout:stream->poll",
    ]);
    h.context.source.close();
});

test("a complete probe stays on SSE; hidden and offline tabs defer an overdue probe", async () => {
    const h = harness("poll:" + 10 * HOUR);

    h.context.connect();
    await h.tick(0);
    h.context.document.hidden = true;
    await h.tick(HOUR);
    assert.equal(h.streams.length, 0);
    h.context.document.hidden = false;
    h.context.navigator.onLine = false;
    h.event("visibilitychange");
    assert.equal(h.streams.length, 0);
    h.context.navigator.onLine = true;
    h.event("online");
    assert.equal(h.streams.length, 1);
    h.streams[0]!.emit("sessions");
    await h.tick(6000 + HOUR);
    assert.equal(h.streams[0]!.readyState, 0);
    assert.equal(h.polls.length, 1);
    assert.equal(h.storage.has("pocket.transport"), false);
    assert.equal(h.received(), 1);
    assert.deepEqual(h.transitions, [
        "poll-reprobe-online:poll->stream",
        "stream-initial-complete:poll->stream",
    ]);
    h.context.source.close();
});

test("pagehide cancels a polling probe and stale authentication checks cannot sign out a new connection", async () => {
    const h = harness("poll:" + 10 * HOUR);

    h.context.connect();
    await h.tick(0);
    h.event("pagehide");
    await h.tick(2 * HOUR);
    assert.equal(h.streams.length, 0);
    assert.equal(h.polls[0]!.signal.aborted, true);
    h.context.connect();
    const old = h.streams[0]!;

    old.onerror?.();
    h.context.connect();
    h.authFail();
    await h.flush();
    assert.equal(h.context.store.state.me, "Alice");
    assert.notEqual(h.streams[1]!.readyState, 2);
    h.context.source.close();
});

test("a snapshot resync inside a poll batch stops all remaining events from the old connection", async () => {
    const h = harness("poll:" + 10 * HOUR);

    h.context.handlers.view = () => h.context.connect();
    h.context.connect();
    h.polls[0]!.resolve({
        ok: true,
        status: 200,
        json: async () => ({
            session: "old",
            events: [
                { seq: 1, event: "view", data: {} },
                { seq: 2, event: "sessions", data: {} },
            ],
        }),
    });
    await h.flush();
    assert.equal(h.polls.length, 2, "exactly one replacement connection");
    assert.equal(h.received(), 0, "no stale event dispatch after a patch rejection caused resync");
    assert.equal(h.maxPolls(), 1);
    h.context.source.close();
});

test("a stale poll 401 cannot clear the member after another connection takes ownership", async () => {
    const h = harness("poll:" + 10 * HOUR);

    h.context.connect();
    h.polls[0]!.resolve({ status: 401 });
    h.context.connect();
    await h.flush();
    assert.equal(h.context.store.state.me, "Alice");
    assert.equal(h.polls[1]!.signal.aborted, false);
    h.context.source.close();
});

const snapshot = (generation: number, id: number, marker: string) => ({
    generation,
    data: { conversation: { id }, marker },
});

test("SSE fences late A→B→A views, missing and future ACKs; global events still arrive", async () => {
    const h = harness();
    const seen: string[] = [];

    h.context.handlers.view = (data) => seen.push(data.marker);
    h.context.handlers.missing = () => seen.push("missing");
    h.context.handlers.models = () => seen.push("global");
    h.context.store.state.conversationId = 1;
    h.context.connect();
    const stream = h.streams[0]!;

    stream.emit("hello", { subscriptions: true, connection: "owned" });
    stream.emit("subscription", { generation: 1, conversationId: 1 });
    stream.emit("view", snapshot(1, 1, "initial"));
    h.select(2);
    await h.flush();
    h.select(1);
    await h.flush();
    stream.emit("models", []);
    stream.emit("subscription", { generation: 1, conversationId: 1 });
    stream.emit("view", snapshot(1, 1, "old A"));
    stream.emit("subscription", { generation: 99, conversationId: 1 });
    stream.emit("view", snapshot(3, 1, "before ACK"));
    stream.emit("subscription", { generation: 3, conversationId: 1 });
    stream.emit("view", snapshot(1, 1, "late A"));
    stream.emit("view", snapshot(3, 2, "wrong room"));
    stream.emit("view", snapshot(3, 1, "new A"));
    stream.emit("missing", { generation: 2, data: { conversationId: 2, message: "old denial" } });
    h.posts[0]!.reject(new Error("late superseded POST failure"));
    await h.flush();
    assert.deepEqual(seen, ["initial", "global", "new A"]);
    assert.deepEqual(
        h.posts.map((p) => JSON.parse(JSON.stringify(p.body))),
        [
            { connection: "owned", generation: 2, conversationId: 2, have: null },
            { connection: "owned", generation: 3, conversationId: 1, have: null },
        ],
    );
    assert.equal(h.streams.length, 1);
    h.select(null);
    stream.emit("subscription", { generation: 4, conversationId: null });
    await h.tick(6000);
    assert.equal(h.streams.length, 1, "home ACK completes without needing a view");
    h.context.source.close();
});

test("poll drops old generations but acknowledges their sequence; expired sessions reconnect to the current selection", async () => {
    const h = harness("poll:" + 10 * HOUR);
    const seen: string[] = [];
    const answer = (index: number, session: string, events: unknown[]) =>
        h.polls[index]!.resolve({
            ok: true,
            status: 200,
            json: async () => ({ session, events }),
        });

    h.context.handlers.view = (data) => seen.push(data.marker);
    h.context.store.state.conversationId = 1;
    h.context.connect();
    answer(0, "old", [
        { seq: 1, event: "hello", data: { subscriptions: true, connection: "owned" } },
        { seq: 2, event: "subscription", data: { generation: 1, conversationId: 1 } },
        { seq: 3, event: "view", data: snapshot(1, 1, "initial") },
    ]);
    await h.flush();
    h.select(2);
    await h.flush();
    h.select(1);
    await h.flush();
    answer(1, "old", [
        { seq: 4, event: "view", data: snapshot(1, 1, "late A") },
        { seq: 5, event: "subscription", data: { generation: 2, conversationId: 2 } },
        { seq: 6, event: "view", data: snapshot(2, 2, "old B") },
        { seq: 7, event: "subscription", data: { generation: 3, conversationId: 1 } },
        { seq: 8, event: "view", data: snapshot(3, 1, "new A") },
        { seq: 9, event: "view", data: snapshot(1, 1, "stale duplicate") },
    ]);
    await h.flush();
    assert.deepEqual(seen, ["initial", "new A"]);
    assert.ok(h.polls[2]!.url.endsWith("&session=old&ack=9"));
    h.select(2);
    await h.flush();
    answer(2, "expired-replacement", [
        { seq: 1, event: "hello", data: { subscriptions: true, connection: "obsolete" } },
        { seq: 2, event: "view", data: snapshot(1, 1, "expired URL") },
    ]);
    await h.flush();
    assert.deepEqual(seen, ["initial", "new A"]);
    assert.ok(h.polls[3]!.url.includes("&c=2"));
    assert.ok(!h.polls[3]!.url.includes("session="));
    assert.ok(h.closedPolls.some((url) => url.includes("session=expired-replacement&close=1")));
    assert.equal(h.maxPolls(), 1);
    assert.ok(
        h.posts.every((p) => p.route === "subscribe"),
        "no user send replay",
    );
    h.context.source.close();
});

test("unknown subscription result or missing ACK recovers read-only, never retries the POST", async () => {
    for (const failure of ["lost response", "lost ACK"]) {
        const h = harness();

        h.context.connect();
        h.streams[0]!.emit("hello", { subscriptions: true, connection: "owned" });
        h.streams[0]!.emit("sessions");
        h.select(2);
        await h.flush();

        if (failure === "lost response") {
            h.posts[0]!.reject(new Error("network outcome unknown"));
            await h.flush();
        } else {
            await h.tick(6000);
        }

        assert.equal(h.streams.length, 2, failure);
        assert.equal(h.posts.length, 1, "subscription POST is not replayed");
        assert.ok(h.streams[1]!.url.includes("&c=2"));
        h.context.source.close();
    }
});

test("SSE failure retries the latest route even with a stalled auth probe; a current 401 cancels it", async () => {
    for (const unauthorised of [false, true]) {
        const h = harness();

        h.context.connect();
        h.streams[0]!.emit("hello", { subscriptions: true, connection: "owned" });
        h.streams[0]!.emit("sessions");
        h.select(2);
        await h.flush();
        h.streams[0]!.onerror?.();

        if (unauthorised) {
            h.authFail();
            await h.flush();
        }

        await h.tick(6000);
        assert.equal(h.streams.length, unauthorised ? 1 : 2);

        if (!unauthorised) {
            assert.ok(h.streams[1]!.url.includes("&c=2"));
        }

        assert.equal(h.posts.filter((p) => p.route === "subscribe").length, 1);
        h.context.source.close();
    }
});

test("a poll 401 cancels the pending subscription deadline instead of reconnecting after sign-out", async () => {
    const h = harness("poll:" + 10 * HOUR);

    h.context.connect();
    h.polls[0]!.resolve({
        ok: true,
        status: 200,
        json: async () => ({
            session: "owned",
            events: [
                { seq: 1, event: "hello", data: { subscriptions: true, connection: "owned" } },
            ],
        }),
    });
    await h.flush();
    h.select(2);
    await h.flush();
    h.polls[1]!.resolve({ status: 401 });
    await h.flush();
    await h.tick(6000);
    assert.equal(h.context.store.state.me, null);
    assert.equal(h.polls.length, 2);
    assert.equal(h.posts.length, 1);
    h.context.source.close();
});

test("new UI falls back to reconnecting when the server does not negotiate subscriptions", async () => {
    const h = harness();

    h.context.connect();
    h.streams[0]!.emit("hello", { connection: "old-server" });
    h.select(2);
    await h.flush();
    assert.equal(h.streams.length, 2);
    assert.equal(h.streams[0]!.readyState, 2);
    assert.equal(h.posts.length, 0);
    h.context.source.close();
});

test("switching home before the initial view arrives settles the stream, not a false poll fallback", async () => {
    const h = harness();

    h.context.store.state.conversationId = 1;
    h.context.connect();
    h.streams[0]!.emit("hello", { subscriptions: true, connection: "owned" });
    h.select(null);
    h.streams[0]!.emit("subscription", { generation: 2, conversationId: null });
    await h.tick(6000);
    assert.equal(h.streams.length, 1);
    assert.equal(h.polls.length, 0);
    assert.equal(h.storage.has("pocket.transport"), false);
    h.context.source.close();
});

test("a saved-copy read cannot paint after the member access key changes", async () => {
    for (const revoked of [false, true]) {
        const h = harness();
        let resolve!: (value: unknown) => void;

        h.context.loadView = () =>
            new Promise((done) => {
                resolve = done;
            });
        h.context.connect();
        h.streams[0]!.emit("hello", { subscriptions: true, connection: "owned" });
        h.select(2);

        if (revoked) {
            h.context.store.state.me = "access changed";
        }

        resolve({ conversation: { id: 2 }, checking: true });
        await h.flush();
        assert.equal(h.context.store.state.view.conversation?.id, revoked ? undefined : 2);
        assert.equal(h.posts.length, 1, "current access is still checked by the server");
        h.context.source.close();
    }
});
