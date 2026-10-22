// What people wait for in this tab, timed from their action to the first paint that shows its result, for the server's
// daily performance journal (src/server/perf-journal.ts). A timing is a name from a closed set, a duration, and how
// the tab gets events: never text, ids, or paths. The server checks each against that set (`parseWebTimings`).
//
//   open.home / open.session  the page's navigation start to the session list, or the session, on screen
//   switch                    picking another session to its view on screen
//   send.echoed               sending to the optimistic message on screen (this tab, before server confirmation)
//   send.shown                the same send to the confirmed server entry on screen
//   send.answered             the same send to the server's submit answer (admission and recording)
//   send.arrived              the same send to the confirmed server entry in the tab's state (before paint)
//   reply.arrived             the same send to the first answer in the tab's state (before paint)
//   reply.first               the same send to the first of the answer on screen
//
// "On screen" is the first task after the next animation frame: the store renders in a microtask after it changes,
// and that frame paints the render. A hidden tab does not paint, so a wait it was hidden for is sent as unavailable.

const BATCH = 20;
const MAX_QUEUED = 100;
const FLUSH_MS = 30_000;
/** A wait this old is stale (its result never came, or came unrecognised); the server refuses longer ones too. */
const STALE_MS = 10 * 60_000;

/** Waits under way, by name: `{ at, hidden, conversationId, ... }`. Each name has at most one. */
const waits = new Map();
let queue = [];
let flushTimer = null;
let transport = "stream";

/** How this tab gets events now (`connect` in store.js); timings carry it, since polling delays what a tab sees. */
export function setTransport(value) {
    transport = value;
}

function begin(name, wait) {
    waits.set(name, { hidden: document.visibilityState !== "visible", ...wait });
}

/** The wait's result is in the store: it ends at the paint that shows it. */
function shown(name) {
    const wait = waits.get(name);

    if (wait === undefined || wait.painting) {
        return;
    }

    wait.painting = true;
    requestAnimationFrame(() =>
        setTimeout(() => {
            if (waits.get(name) !== wait) {
                return;
            }

            waits.delete(name);
            report(
                wait.hidden
                    ? { name, unavailable: "hidden" }
                    : { name, ms: Math.round((performance.now() - wait.at) * 10) / 10 },
            );
        }, 0),
    );
}

/** An arrival is a store observation, not a paint. No IDs or text are included. */
function arrived(name) {
    const wait = waits.get(name);

    if (wait === undefined) {
        return;
    }

    waits.delete(name);
    report({ name, ms: Math.round((performance.now() - wait.at) * 10) / 10 });
}

/** A rare connection transition, reported once without retries or content (never a network error string). */
export function reportTransport(transition, from, to) {
    fetch("/api/perf-transport", {
        method: "POST",
        keepalive: true,
        headers: { "X-Pocket": "1", "content-type": "application/json" },
        body: JSON.stringify({ transition, from, to }),
    }).catch(() => {});
}

function report(timing) {
    // Past the cap (the server unreachable for a long time) the newest are dropped: a journal gap, not a wrong number.
    if (queue.length >= MAX_QUEUED) {
        return;
    }

    queue.push({ ...timing, transport });

    if (queue.length >= BATCH) {
        flush();
    } else {
        flushTimer ??= setTimeout(flush, FLUSH_MS);
    }
}

/** Send what is queued. Lost reports are a gap in the journal, never retried or shown: timing must not get in the way. */
function flush() {
    clearTimeout(flushTimer);
    flushTimer = null;

    while (queue.length > 0) {
        fetch("/api/perf", {
            method: "POST",
            keepalive: true,
            headers: { "X-Pocket": "1", "content-type": "application/json" },
            body: JSON.stringify({ timings: queue.slice(0, BATCH) }),
        }).catch(() => {});
        queue = queue.slice(BATCH);
    }
}

document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
        for (const wait of waits.values()) {
            wait.hidden = true;
        }

        flush();
    }
});
addEventListener("pagehide", flush);

/** The page opened on `conversationId` (null: the session list). Navigation start is time zero. */
export function opened(conversationId) {
    begin(conversationId === null ? "open.home" : "open.session", { at: 0, conversationId });
}

/** Someone picked another session. Waiting for it replaces any open or send under way. */
export function switched(conversationId) {
    waits.clear();

    if (conversationId !== null) {
        begin("switch", { at: performance.now(), conversationId });
    }
}

/** A message is going to an idle session; `view` is what the tab shows now. Returns the send, for `sendFailed`. */
export function sending(view, { echoed = false } = {}) {
    const wait = {
        at: performance.now(),
        conversationId: view.conversation.id,
        known: new Set(view.order),
        inbox: (view.inbox ?? []).length,
    };

    waits.delete("send.echoed");

    // Only a tab-local optimistic row has an echo; other backends show the confirmed entry only.
    if (echoed) {
        begin("send.echoed", { ...wait });
    }

    begin("send.shown", { ...wait });
    begin("send.answered", { ...wait });
    begin("send.arrived", { ...wait });
    begin("reply.arrived", { ...wait, busy: false });
    begin("reply.first", { ...wait, busy: false });

    return wait.at;
}

/** The submit request answered successfully. It is not proof that its entry was mirrored or shown. */
export function sendAnswered(at) {
    if (waits.get("send.answered")?.at === at) {
        arrived("send.answered");
    }
}

/** The send that started at `at` was refused: nothing it waited for will come. A newer send keeps its waits. */
export function sendFailed(at) {
    for (const name of [
        "send.echoed",
        "send.shown",
        "send.answered",
        "send.arrived",
        "reply.arrived",
        "reply.first",
    ]) {
        if (waits.get(name)?.at === at) {
            waits.delete(name);
        }
    }
}

/** The kinds of the entries shown since `known`. New entries are at the end of the order. */
function newKinds(view, known) {
    const kinds = new Set();

    for (let index = view.order.length - 1; index >= 0; index--) {
        const id = view.order[index];

        if (known.has(id)) {
            break;
        }

        kinds.add(view.entries.get(id)?.kind);
    }

    return kinds;
}

/** Called on every store change: end the waits whose result the state now holds. */
export function observe(state) {
    if (waits.size === 0) {
        return;
    }

    const view = state.view;
    const now = performance.now();

    for (const [name, wait] of waits) {
        if (now - wait.at > STALE_MS) {
            waits.delete(name);
        }
    }

    for (const name of ["open.session", "switch"]) {
        const wait = waits.get(name);

        if (wait === undefined) {
            continue;
        }

        if (state.missing || state.conversationId !== wait.conversationId) {
            waits.delete(name);
        } else if (view.conversation?.id === wait.conversationId && !view.checking) {
            // A saved copy shown while the server confirms it does not end the wait: the confirmed view does.
            shown(name);
        }
    }

    if (waits.has("open.home")) {
        if (state.conversationId !== null) {
            waits.delete("open.home");
        } else if (state.sessionsLoaded) {
            shown("open.home");
        }
    }

    const send =
        waits.get("send.echoed") ??
        waits.get("send.shown") ??
        waits.get("send.answered") ??
        waits.get("send.arrived") ??
        waits.get("reply.arrived") ??
        waits.get("reply.first");

    if (send === undefined) {
        return;
    }

    if (view.conversation?.id !== send.conversationId) {
        sendFailed(send.at);

        return;
    }

    const kinds = newKinds(view, send.known);

    if (state.pendingSends?.some((each) => each.conversationId === send.conversationId)) {
        shown("send.echoed");
    }

    if (kinds.has("user") || (view.inbox ?? []).length > send.inbox) {
        arrived("send.arrived");
        shown("send.shown");
    }

    const hasReply = kinds.has("assistant") || view.live?.generation?.message?.blocks?.length > 0;

    if (hasReply) {
        arrived("reply.arrived");
        shown("reply.first");
    }

    for (const name of ["reply.arrived", "reply.first"]) {
        const reply = waits.get(name);

        if (reply === undefined || hasReply) {
            continue;
        }

        if (reply.busy && !view.live?.busy) {
            // The run ended without an answer to show (an error, a stop): no reply to time.
            waits.delete(name);
        } else {
            reply.busy ||= Boolean(view.live?.busy);
        }
    }
}
