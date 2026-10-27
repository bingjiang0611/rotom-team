// Exercise the production transport lifecycle with a deterministic clock and controlled network, not a second policy.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../web/store.js", import.meta.url), "utf8");
const transport = source.slice(
    source.indexOf("const TRANSPORT_KEY ="),
    source.indexOf("function handleAuth(data)"),
);
const HOUR = 60 * 60_000;

function harness(saved?: string) {
    let now = 10 * HOUR;
    let timerId = 0;
    let authReject: ((error: unknown) => void) | undefined;
    const timers = new Map<number, { at: number; fn: () => void }>();
    const listeners = new Map<string, Set<(event?: { type: string }) => void>>();
    const transitions: string[] = [];
    const storage = new Map(saved ? [["pocket.transport", saved]] : []);

    const add = (name: string, fn: (event?: { type: string }) => void) => {
        const set = listeners.get(name) ?? new Set();

        set.add(fn);
        listeners.set(name, set);
    };

    const remove = (name: string, fn: (event?: { type: string }) => void) =>
        listeners.get(name)?.delete(fn);
    const streams: Stream[] = [];
    const polls: {
        resolve: (response: any) => void;
        signal: AbortSignal;
        active: boolean;
        url: string;
    }[] = [];
    const posts: { route?: string; body?: unknown; reject: (error: unknown) => void }[] = [];
    const closedPolls: string[] = [];
    let activePolls = 0;
    let maxPolls = 0;
    let received = 0;

    class Stream {
        static CLOSED = 2;
        readyState = 0;
        onopen?: () => void;
        onerror?: () => void;
        events = new Map<string, (event: { data: string }) => void>();
        readonly url: string;
        constructor(url: string) {
            this.url = url;
            assert.equal(activePolls, 0, "poll aborted before stream probe");
            streams.push(this);
        }
        addEventListener(name: string, fn: (event: { data: string }) => void) {
            this.events.set(name, fn);
        }
        close() {
            this.readyState = 2;
        }
        emit(name: string, data: unknown = {}) {
            this.events.get(name)?.({ data: JSON.stringify(data) });
        }
    }

    const context = {
        source: null as any,
        syncingSessions: null,
        location: { hostname: "remote.test" },
        localStorage: {
            getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => storage.set(key, value),
            removeItem: (key: string) => storage.delete(key),
        },
        Date: { now: () => now },
        setTimeout: (fn: () => void, delay = 0) => {
            timers.set(++timerId, { at: now + delay, fn });

            return timerId;
        },
        clearTimeout: (id: number) => timers.delete(id),
        addEventListener: add,
        removeEventListener: remove,
        document: { hidden: false, addEventListener: add, removeEventListener: remove },
        navigator: { onLine: true },
        window: {},
        performance,
        EventSource: Stream,
        AbortController,
        TAB: "one",
        TRANSCRIPT_TAIL: 100,
        claimOf: () => null,
        setTransport() {},
        reportTransport: (transition: string, from: string, to: string) =>
            transitions.push(`${transition}:${from}->${to}`),
        handlers: {
            hello() {},
            sessions: () => received++,
            view(_data: any) {},
            missing(_data: any) {},
            models(_data: any) {},
        },
        loadView: async (): Promise<unknown> => null,
        savedView: (record: unknown) => record,
        accessOf: (me: unknown) => JSON.stringify(me),
        store: {
            state: {
                connection: "closed",
                conversationId: null as number | null,
                sessionListVersion: null,
                view: {} as any,
                me: "Alice",
            },
            set(change: object) {
                Object.assign(this.state, change);
            },
        },
        api: (route?: string, body?: unknown) =>
            new Promise((_, reject) => {
                posts.push({ route, body, reject });

                if (route === "me") {
                    authReject = reject;
                }
            }),
        fetch: (url: string, init: any) => {
            if (url.includes("close=1")) {
                closedPolls.push(url);

                return Promise.resolve({});
            }

            activePolls++;
            maxPolls = Math.max(maxPolls, activePolls);
            assert.equal(streams.filter((stream) => stream.readyState !== 2).length, 0);

            return new Promise((resolve, reject) => {
                const poll = { resolve, signal: init.signal, active: true, url };

                const finish = () => {
                    if (poll.active) {
                        activePolls--;
                        poll.active = false;
                    }
                };

                poll.resolve = (response) => {
                    finish();
                    resolve(response);
                };

                init.signal.addEventListener("abort", () => {
                    finish();
                    reject(new Error("aborted"));
                });
                polls.push(poll);
            });
        },
        connect: undefined as unknown as () => void,
    };

    const savedConnection = source.slice(
        source.indexOf("const SAVED_WAIT_MS ="),
        source.indexOf("export async function start()"),
    );

    runInNewContext(
        transport.replace("export function connect", "function connect") + savedConnection,
        context,
    );

    const flush = async () => {
        for (let i = 0; i < 8; i++) {
            await Promise.resolve();
        }
    };

    const tick = async (ms: number) => {
        const end = now + ms;

        while (true) {
            const next = [...timers]
                .filter(([, timer]) => timer.at <= end)
                .sort((a, b) => a[1].at - b[1].at)[0];

            if (!next) {
                break;
            }

            timers.delete(next[0]);
            now = next[1].at;
            next[1].fn();
            await flush();
        }

        now = end;
        await flush();
    };

    return {
        context,
        streams,
        polls,
        storage,
        tick,
        flush,
        event: (name: string) => {
            for (const fn of [...(listeners.get(name) ?? [])]) {
                fn({ type: name });
            }
        },
        authFail: () => authReject?.({ status: 401 }),
        maxPolls: () => maxPolls,
        received: () => received,
        transitions,
        posts,
        closedPolls,
        select: (id: number | null) =>
            runInNewContext(`store.state.conversationId = ${id}; connectSaved(${id});`, context),
    };
}

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
