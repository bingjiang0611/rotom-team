// Exercise the production transport lifecycle with a deterministic clock and controlled network, not a second policy.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../../web/store-transport.js", import.meta.url), "utf8");
const transport =
    source.slice(
        source.indexOf("const TRANSPORT_KEY ="),
        source.indexOf("export function navigate("),
    ) +
    source.slice(
        source.indexOf("/** How long opening a session"),
        source.indexOf("function handleAuth(data)"),
    );

export const HOUR = 60 * 60_000;

export function harness(saved?: string) {
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

    runInNewContext(
        transport
            .replace("export function connect()", "function connect()")
            .replace("export function connectSaved", "function connectSaved"),
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
