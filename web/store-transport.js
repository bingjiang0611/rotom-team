import {
    store,
    api,
    notify,
    sendUnknown,
    TAB,
    TRANSCRIPT_TAIL,
    emptyView,
    peopleFor,
    routeConversation,
    savedView,
} from "./store-state.js";
import { createEventHandlers } from "./store-events.js";
import { accessOf, loadView } from "./view-cache.js";
import { onRoute, pushRoute } from "./back.js";
import { openSheet, sheetChange } from "./store-views.js";

export let source;
const current = () => store.state.conversationId;

import { claimOf } from "./view-claim.js";
import { setTransport, switched, reportTransport } from "./perf.js";
import { applyView } from "./store-projection.js";

let syncingSessions = null;

function resyncSessions() {
    if (syncingSessions !== null) {
        return;
    }

    const connection = store.state.streamId;
    const stream = source;

    syncingSessions = connection;
    api("sessions/sync", { connection }).catch((error) => {
        if (source !== stream || syncingSessions !== connection) {
            return;
        }

        syncingSessions = null;

        if (error.status === 401) {
            source?.close();
            store.set({ me: null, sessionListVersion: null });
        } else {
            // The connection may have expired (polling) or changed (reconnect). A fresh stream starts with a full list.
            connect();
        }
    });
}

const handlers = createEventHandlers({
    resyncSessions,
    resetSessionSync: () => {
        syncingSessions = null;
    },
    isSyncing: () => syncingSessions !== null,
    handleAuth,
    navigate,
    applyView: (data) => applyView(data, resyncView),
});

const TRANSPORT_KEY = "pocket.transport";
const ROOM_EVENTS = new Set(["view", "missing", "chat", "notes", "browser", "presence", "changes"]);
let subscriptionGeneration = 0;
let subscriptionAck = null;
let subscriptionTimer;

/** An ACK orders the target's full snapshot before its deltas; old A→B→A events must not match by id alone. */
function receive(connection, name, data) {
    if (source !== connection) {
        return false;
    }

    if (name === "hello") {
        connection.subscriptionId = data.subscriptions === true ? data.connection : null;
    } else if (name === "subscription") {
        if (
            connection.subscriptionId &&
            data.generation === subscriptionGeneration &&
            data.conversationId === store.state.conversationId
        ) {
            subscriptionAck = data.generation;

            if (data.conversationId === null) {
                clearTimeout(subscriptionTimer);

                return true;
            }
        }

        return false;
    } else if (connection.subscriptionId && ROOM_EVENTS.has(name)) {
        if (
            data.generation !== subscriptionGeneration ||
            subscriptionAck !== subscriptionGeneration
        ) {
            return false;
        }

        data = data.data;
        const id = name === "view" ? data.conversation.id : data.conversationId;

        if (id !== store.state.conversationId) {
            return false;
        }

        if (name === "view" || name === "missing") {
            clearTimeout(subscriptionTimer);
        }
    }

    handlers[name]?.(data);

    return true;
}

function requestSubscription() {
    const connection = source;

    if (!connection?.subscriptionId) {
        connect();

        return;
    }

    const generation = subscriptionGeneration;
    const id = store.state.conversationId;

    clearTimeout(subscriptionTimer);
    // A lost POST/ACK does not prove failure. Recover only by replacing the read-only connection, never a user send.
    subscriptionTimer = setTimeout(() => {
        if (source === connection && subscriptionGeneration === generation) {
            connect();
        }
    }, 6000);
    api("subscribe", {
        connection: connection.subscriptionId,
        generation,
        conversationId: id,
        have: id === null ? null : claimOf(store.state.view, id),
    }).catch((error) => {
        if (source !== connection || subscriptionGeneration !== generation) {
            return;
        }

        clearTimeout(subscriptionTimer);

        if (error.status === 401) {
            connection.close();
            store.set({ me: null });
        } else {
            connect();
        }
    });
}

const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(location.hostname);
/** After an event stream stalls, poll for an hour, then actively try the stream again while visible and online. */
const POLL_FOR_MS = 60 * 60_000;

const pollHere = () => {
    const saved = localStorage.getItem(TRANSPORT_KEY) ?? "";

    // Saved before the choice had a time: a choice made now.
    if (saved === "poll") {
        localStorage.setItem(TRANSPORT_KEY, `poll:${Date.now()}`);
    }

    const [mode, at] = (localStorage.getItem(TRANSPORT_KEY) ?? "").split(":");

    return mode === "poll" && Date.now() - Number(at) < POLL_FOR_MS;
};

/** Event stream reconnects in a row that the browser gave up on, for the pause before the next one. */
let streamRetries = 0;

const connected = () => store.state.connection !== "open" && store.set({ connection: "open" });

/** The next connection claims nothing: the last claim's run turned out incomplete. */
let unclaimed = false;
/** Counts connects, so a saved copy read for an older one does not connect again. */
let connects = 0;

export function navigate(conversationId, { replace = false, sheet = null } = {}) {
    const path = conversationId === null ? "/" : `/s/${conversationId}`;

    if (location.pathname !== path || store.state.conversationId !== conversationId) {
        pushRoute(path, { replace });
    }

    if (store.state.conversationId === conversationId && source) {
        if (sheet) {
            openSheet(sheet);
        }

        return;
    }

    switched(conversationId);
    store.set((state) => ({
        conversationId,
        view: emptyView(),
        ...peopleFor(conversationId),
        browser: null,
        history: null,
        transcriptFrom: null,
        missing: null,
        drawer: false,
        ...sheetChange(sheet, state),
    }));
    connectSaved(conversationId);
}

// Back or forward to another route. Back that only closes a layer (a sheet, a panel) is back.js's.
onRoute(() => {
    const id = routeConversation();

    if (id !== store.state.conversationId) {
        switched(id);
        store.set({
            conversationId: id,
            view: emptyView(),
            ...peopleFor(id),
            browser: null,
            history: null,
            transcriptFrom: null,
            missing: null,
            sheet: null,
            drawer: false,
        });
        connectSaved(id);
    }
});

/** How long opening a session waits for its saved copy before connecting without it. */
const SAVED_WAIT_MS = 150;

/**
 * Show session `id`'s saved copy, if this browser has one for this person, then connect claiming it. `reading` is a
 * read of it already under way.
 */
export function connectSaved(id, reading) {
    const me = store.state.me;
    const ticket = ++connects;

    // Fence old events immediately, including during the asynchronous saved-copy read.
    subscriptionGeneration++;
    subscriptionAck = null;
    clearTimeout(subscriptionTimer);

    if (!source?.subscriptionId) {
        source?.close();
        source = null;
    }

    if (id === null || !me) {
        requestSubscription();

        return;
    }

    const access = accessOf(me);

    Promise.race([
        loadView(id, me, reading).catch(() => null),
        new Promise((resolve) => setTimeout(() => resolve(null), SAVED_WAIT_MS)),
    ]).then((record) => {
        if (ticket !== connects) {
            return;
        }

        if (!store.state.me) {
            return;
        }

        if (
            record &&
            accessOf(store.state.me) === access &&
            store.state.conversationId === id &&
            !store.state.view.conversation
        ) {
            store.set({ view: savedView(record) });
        }

        requestSubscription();
    });
}

function resyncView() {
    unclaimed = true;
    connect();
}

export function connect() {
    connects++;
    subscriptionGeneration++;
    subscriptionAck = null;
    clearTimeout(subscriptionTimer);
    source?.close();
    syncingSessions = null;
    store.set({ connection: "connecting", sessionListVersion: null });
    const id = store.state.conversationId;
    const claim = id === null || unclaimed ? null : claimOf(store.state.view, id);

    unclaimed = false;
    const query = `tab=${encodeURIComponent(TAB)}&sessions=delta&live=delta&subscriptions=1&generation=${subscriptionGeneration}&tail=${TRANSCRIPT_TAIL}${
        id === null ? "" : `&c=${id}`
    }${claim === null ? "" : `&have=${encodeURIComponent(claim)}`}`;

    const polling = pollHere() && !local;

    setTransport(polling ? "poll" : "stream");
    source = polling ? pollEvents(query) : streamEvents(query);
}

// A page kept for Back and Forward stays alive, frozen, and so would its stream: each holds one of the few connections a
// browser makes to a server, and after a handful nothing else loads. It closes on leaving and reconnects on return.
addEventListener("pagehide", () => {
    source?.close();
    source = null;
});
addEventListener("pageshow", (event) => {
    if (event.persisted) {
        connect();
    }
});

/** Server-sent events: one long response the server writes to as things change. */
function streamEvents(query) {
    const events = new EventSource(`/api/events?${query}`);
    /** The first batch arrived whole: the session's view, or the session list when no session is open. */
    let settled = false;
    let retry;
    const settles = query.includes("&c=") ? ["view", "missing"] : ["sessions"];
    const reprobing = (localStorage.getItem(TRANSPORT_KEY) ?? "").startsWith("poll");
    const connection = {
        close() {
            if (source === connection) {
                clearTimeout(subscriptionTimer);
            }

            clearTimeout(fallback);
            clearTimeout(retry);
            connection.subscriptionId = null;
            events.close();
        },
    };
    // Some tunnels hold the stream back. A Cloudflare quick tunnel passes it on in 64 KiB blocks and keeps the rest, so
    // a long session's first view can stop partway after its small first events got through. The stream counts as
    // working only once that first batch is whole; otherwise poll instead, and remember that for this address.
    const fallback = local
        ? undefined
        : setTimeout(() => {
              if (settled || source !== connection) {
                  return;
              }

              localStorage.setItem(TRANSPORT_KEY, `poll:${Date.now()}`);
              reportTransport("stream-initial-timeout", "stream", "poll");
              connect();
          }, 6000);

    for (const name of [...Object.keys(handlers), "subscription"]) {
        events.addEventListener(name, (event) => {
            if (source !== connection) {
                return;
            }

            const perf = window.__rotomPerf;
            const started = perf ? performance.now() : 0;
            const data = JSON.parse(event.data);

            if (perf) {
                perf.eventParseCalls++;
                perf.eventParseChars += event.data.length;
                perf.eventParseMs += performance.now() - started;
            }

            if (
                receive(connection, name, data) &&
                source === connection &&
                !settled &&
                (settles.includes(name) ||
                    (name === "subscription" && data.conversationId === null))
            ) {
                settled = true;
                clearTimeout(fallback);
                localStorage.removeItem(TRANSPORT_KEY);

                if (reprobing && !local) {
                    reportTransport("stream-initial-complete", "poll", "stream");
                }
            }
        });
    }

    events.onopen = () => {
        if (source !== connection) {
            return;
        }

        streamRetries = 0;
        connected();
    };

    events.onerror = () => {
        if (source !== connection) {
            return;
        }

        // The URL names the initial selection. Do not let EventSource reopen that obsolete selection by itself.
        connection.close();
        store.set({ connection: "closed" });

        // Do not wait for a possibly stalled auth probe to reconnect. A current 401 cancels the retry.
        streamRetries++;
        retry = setTimeout(
            () => source === connection && connect(),
            Math.min(10_000, 1000 * streamRetries),
        );
        api("me").catch((error) => {
            if (error.status === 401 && source === connection) {
                connection.close();
                store.set({ me: null });
            }
        });
    };

    return connection;
}

/** Long polling: each request waits for events and returns them; the next one acknowledges what arrived. */
function pollEvents(query) {
    let session = null;
    let ack = 0;
    let stopped = false;
    let request = null;
    let probeTimer;

    const probe = (event) => {
        clearTimeout(probeTimer);

        if (stopped || source !== connection || local) {
            return;
        }

        const at = Number((localStorage.getItem(TRANSPORT_KEY) ?? "").split(":")[1]);
        const left = at + POLL_FOR_MS - Date.now();

        if (left > 0) {
            probeTimer = setTimeout(probe, left);
        } else if (!document.hidden && navigator.onLine !== false) {
            // Close the poll first; its acknowledgement and any interrupted read are replaced by a full snapshot.
            reportTransport(
                event?.type === "visibilitychange"
                    ? "poll-reprobe-visible"
                    : event?.type === "online"
                      ? "poll-reprobe-online"
                      : "poll-hourly-reprobe",
                "poll",
                "stream",
            );
            connect();
        }
    };

    const connection = {
        close() {
            if (source === connection) {
                clearTimeout(subscriptionTimer);
            }

            stopped = true;
            connection.subscriptionId = null;
            clearTimeout(probeTimer);
            document.removeEventListener("visibilitychange", probe);
            removeEventListener("online", probe);
            request?.abort();

            if (session) {
                fetch(`/api/poll?session=${session}&close=1`, { keepalive: true }).catch(() => {});
            }
        },
    };

    document.addEventListener("visibilitychange", probe);
    addEventListener("online", probe);
    // Defer until `source` owns this connection. No simultaneous stream probe or second polling loop.
    probeTimer = setTimeout(probe, 0);

    (async () => {
        let failures = 0;

        while (!stopped) {
            request = new AbortController();

            try {
                const response = await fetch(
                    `/api/poll?${query}${session ? `&session=${session}&ack=${ack}` : ""}`,
                    { signal: request.signal, cache: "no-store" },
                );

                if (response.status === 401) {
                    if (stopped || source !== connection) {
                        return;
                    }

                    connection.close();
                    store.set({ me: null });

                    return;
                }

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }

                const data = await response.json();

                if (stopped || source !== connection) {
                    return;
                }

                if (session !== null && data.session !== session) {
                    // Expiry/restart used the old URL. Discard that batch, close its new poller, and select afresh.
                    session = data.session;
                    connect();

                    return;
                }

                if (data.session !== session) {
                    session = data.session;
                    ack = 0;
                }

                failures = 0;
                connected();

                for (const item of data.events) {
                    if (stopped || source !== connection) {
                        return;
                    }

                    if (item.seq <= ack) {
                        continue;
                    }

                    ack = item.seq;
                    receive(connection, item.event, item.data);
                }
            } catch {
                if (stopped) {
                    return;
                }

                failures++;

                if (store.state.connection === "open") {
                    store.set({ connection: "closed" });
                }

                await new Promise((resolve) =>
                    setTimeout(resolve, Math.min(10_000, 1000 * failures)),
                );
            }
        }
    })();

    return connection;
}

function handleAuth(data) {
    store.set((state) => {
        if (state.dismissedAuthFlowId === data.flowId) {
            return {};
        }

        const flow =
            state.auth?.flowId === data.flowId
                ? state.auth
                : {
                      flowId: data.flowId,
                      providerId: data.providerId,
                      events: [],
                      prompt: null,
                      done: null,
                  };

        if (data.step === "prompt") {
            return { auth: { ...flow, prompt: { id: data.promptId, ...data.prompt } } };
        }

        if (data.step === "prompt-closed") {
            return { auth: flow.prompt?.id === data.promptId ? { ...flow, prompt: null } : flow };
        }

        if (data.step === "event") {
            return { auth: { ...flow, events: [...flow.events, data.event] } };
        }

        if (data.step === "done") {
            if (data.ok) {
                notify("info", `Signed in to ${data.providerId}.`);
            }

            return {
                auth: data.ok ? null : { ...flow, prompt: null, done: data },
            };
        }

        return {};
    });
}
