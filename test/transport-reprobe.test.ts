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
    const listeners = new Map<string, Set<() => void>>();
    const storage = new Map(saved ? [["pocket.transport", saved]] : []);

    const add = (name: string, fn: () => void) => {
        const set = listeners.get(name) ?? new Set();

        set.add(fn);
        listeners.set(name, set);
    };

    const remove = (name: string, fn: () => void) => listeners.get(name)?.delete(fn);
    const streams: Stream[] = [];
    const polls: { resolve: (response: any) => void; signal: AbortSignal; active: boolean }[] = [];
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
        emit(name: string) {
            this.events.get(name)?.({ data: "{}" });
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
        handlers: { hello() {}, sessions: () => received++, view() {}, missing() {} },
        store: {
            state: {
                connection: "closed",
                conversationId: null,
                sessionListVersion: null,
                me: "Alice",
            },
            set(change: object) {
                Object.assign(this.state, change);
            },
        },
        api: () => new Promise((_, reject) => (authReject = reject)),
        fetch: (url: string, init: any) => {
            if (url.includes("close=1")) {
                return Promise.resolve({});
            }

            activePolls++;
            maxPolls = Math.max(maxPolls, activePolls);
            assert.equal(streams.filter((stream) => stream.readyState !== 2).length, 0);

            return new Promise((resolve, reject) => {
                const poll = { resolve, signal: init.signal, active: true };

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

    runInNewContext(transport.replace("export function connect", "function connect"), context);

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
                fn();
            }
        },
        authFail: () => authReject?.({ status: 401 }),
        maxPolls: () => maxPolls,
        received: () => received,
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
