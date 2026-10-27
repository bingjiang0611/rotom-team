import { onRoute, pushRoute } from "./back.js";
import { sessionDelta, sessionSnapshot } from "./session-list.js";
import {
    observe,
    opened,
    reportTransport,
    sendAnswered,
    sending,
    sendFailed,
    setTransport,
    switched,
} from "./perf.js";
import { writtenFiles } from "./calls.js";
import { claimOf, keptEntries } from "./view-claim.js";
import {
    accessOf,
    clearViews,
    dropView,
    keepViews,
    loadView,
    readView,
    saveView,
} from "./view-cache.js";

export function uid() {
    if (typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }

    const bytes = crypto.getRandomValues(new Uint8Array(16));

    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** How many transcript rows a session shows when opened; "Show earlier messages" adds this many more. */
export const TRANSCRIPT_ROWS = 60;
/**
 * The newest entries a session's view sends when it opens; the tab reads older ones a page at a time as the reader
 * scrolls up to them (`loadEarlier`), and in full where a feature needs every entry (`loadAllEntries`).
 */
export const TRANSCRIPT_TAIL = 240;

const TAB_KEY = "pocket.tab";

export const TAB = sessionStorage.getItem(TAB_KEY) ?? uid();

sessionStorage.setItem(TAB_KEY, TAB);

export const emptyView = () => ({
    conversation: null,
    entries: new Map(),
    order: [],
    live: { busy: false },
    inbox: [],
    agent: null,
    stats: { cost: 0 },
    clients: 0,
    viewers: [],
    approvals: [],
    artifacts: [],
    subagents: [],
    authors: {},
    reactions: {},
    pins: [],
    turns: { on: false, asks: [] },
    decisions: {},
    readOnly: null,
    plan: { on: false },
    schedules: [],
    goal: null,
    nativeGoal: null,
    branch: null,
    /** A rotom session's segment, payer, and pending receipt; null for a Durable session. */
    kernel: null,
    /** The transcript is this browser's saved copy, not yet confirmed by the server (`view-cache.js`). */
    checking: false,
    /** The server run (its start time) whose projection made these entries, for the next connection's claim. */
    build: null,
});

/** A saved copy as a view to show while the server confirms it: transcript only, nothing to act on. */
export function savedView(record) {
    return {
        ...emptyView(),
        conversation: record.conversation,
        order: record.order,
        entries: new Map(record.entries.map((entry) => [entry.id, entry])),
        authors: record.authors,
        checking: true,
        build: record.build,
    };
}

export const store = {
    state: {
        me: undefined, // undefined: unknown, null: signed out
        users: [],
        models: [],
        guard: null,
        server: null,
        sessions: [],
        /** False until the server's first session list arrives: an empty list until then means "not here yet". */
        sessionsLoaded: false,
        sessionListVersion: null,
        /** Sessions on their way into the archive (true) or out of it (false), by id, until the list catches up (`sessions.js`). */
        moving: {},
        conversationId: routeConversation(),
        view: emptyView(),
        ...peopleFor(routeConversation()),
        history: null,
        /** The id of the oldest transcript entry shown, or null for the newest `TRANSCRIPT_ROWS` rows. */
        transcriptFrom: null,
        missing: null,
        connection: "connecting",
        notices: [],
        sheet: null,
        drawer: false,
        auth: null,
        /** A transcript message the next chat message discusses: `{ entryId, text }`. */
        chatQuote: null,
        /** Text to put into the message box to Pi: `{ text, n }`, picked up by the composer. */
        composerInsert: null,
        /** Pi's prompt templates for a conversation's folder: `{ conversationId, at, list }`. */
        templates: null,
        /** Counts the lists of files for @ mentions that arrived; the lists themselves are kept in `files.js`. */
        filesLoaded: 0,
        /** `!` commands this tab started that have no entry yet: `{ taskId, command, conversationId, at }`. */
        pendingShells: [],
        /** Messages this tab is sending, shown until their entries come (`sendsInFlight`). */
        pendingSends: [],
        /** The session's browser page as the server last told: address, title, loading, size (`browser.js`). */
        browser: null,
        /** The Browser panel shows; kept per tab, so the reload after a live edit keeps it. */
        browserOpen: sessionStorage.getItem("pocket.browser") === "1",
        /** The Files tile shows (`files-panel.js`); kept per tab, like the browser's. */
        filesOpen: sessionStorage.getItem("pocket.files") === "1",
        /** The Files tile's tab: `files` or `changes`. */
        filesTab: sessionStorage.getItem("pocket.filesTab") === "changes" ? "changes" : "files",
        /** The last file asked to open in the Files tile: `{ path, line, n }`, `n` telling requests apart. */
        filesTarget: null,
        /** When someone last asked for the Files tile, and for which tab: `{ tab, at }`. */
        filesAsk: null,
        /** The People panel shows beside the conversation on wide screens; kept per tab, like the browser's. */
        peopleOpen: sessionStorage.getItem("pocket.people") === "1",
        /** The last request to show the People panel: which tab and chat message, and a count that tells requests apart. */
        peopleAsk: { tab: null, highlight: null, n: 0 },
    },
    listeners: new Set(),
    set(patch) {
        this.state = {
            ...this.state,
            ...(typeof patch === "function" ? patch(this.state) : patch),
        };

        for (const listener of this.listeners) {
            listener(this.state);
        }
    },
    subscribe(listener) {
        this.listeners.add(listener);

        return () => this.listeners.delete(listener);
    },
};

const REPEATED_VIEW_FIELDS = new Set([
    "conversation",
    "inbox",
    "agent",
    "stats",
    "clients",
    "viewers",
    "approvals",
    "kernel",
]);

function sameViewJson(before, after) {
    if (before === after) {
        return true;
    }

    if (
        before === null ||
        after === null ||
        typeof before !== "object" ||
        typeof after !== "object" ||
        Array.isArray(before) !== Array.isArray(after)
    ) {
        return false;
    }

    const keys = Object.keys(after);
    const previousKeys = Object.keys(before);

    // Native statuses/widgets render in Object.entries order, so equal values alone are not enough.
    return (
        keys.length === previousKeys.length &&
        keys.every(
            (key, index) => key === previousKeys[index] && sameViewJson(before[key], after[key]),
        )
    );
}

/** Only Transcript reads generation/tools/compactions. Busy and every non-live change still need the root. */
export function liveOnlyChange(before, after) {
    if (before.view.live === after.view.live || before.view.live?.busy !== after.view.live?.busy) {
        return false;
    }

    if (
        Object.keys(before).length !== Object.keys(after).length ||
        Object.keys(after).some(
            (key) => !Object.hasOwn(before, key) || (key !== "view" && before[key] !== after[key]),
        )
    ) {
        return false;
    }

    const left = before.view;
    const right = after.view;

    if (Object.keys(left).length !== Object.keys(right).length) {
        return false;
    }

    for (const key of Object.keys(right)) {
        if (!Object.hasOwn(left, key)) {
            return false;
        }

        if (key === "live" || key === "liveVersion" || left[key] === right[key]) {
            continue;
        }

        if (!REPEATED_VIEW_FIELDS.has(key) || !sameViewJson(left[key], right[key])) {
            return false;
        }
    }

    return true;
}

// Content-free timings of what people wait for here, for the server's performance journal (perf.js).
store.subscribe(observe);

/** Past this a message still without its entry is no longer shown as on its way, but as of unknown outcome. */
const SEND_SHOWN_MS = 2 * 60_000;

/** The most messages kept here: older ones are dropped first. Only lost sends stay long. */
export const SENDS_KEPT = 20;

/** Entries that arrived for a message this tab already showed: they take its place without sliding in again. */
export const echoedEntries = new Set();

// A run that started and ended without the message's entry: what became of the message is not known here.
store.subscribe((state) => {
    if (state.view.live?.busy) {
        for (const send of state.pendingSends) {
            if (send.conversationId === state.view.conversation?.id) {
                send.ran = true;
            }
        }
    }
});

/** A message is no longer shown: refused by the server, or put away by its sender. */
export function dropSend(key) {
    store.set((state) => ({
        pendingSends: state.pendingSends.filter((send) => send.key !== key),
    }));
}

export function lostSend(key) {
    store.set((state) => ({
        pendingSends: state.pendingSends.map((send) =>
            send.key === key ? { ...send, unknown: true } : send,
        ),
    }));
}

/**
 * Whether the tab cannot tell if a message it showed went: the answer to its send was lost or unknown, its run
 * ended without it, or it waited too long. Such a message stays, marked, until its entry comes after all (then it
 * went) or its sender puts it away. It is never taken as sent, and never sent again by itself.
 */
export function sendUnknown(send, view) {
    return (
        send.unknown === true ||
        Date.now() - send.at >= SEND_SHOWN_MS ||
        (send.ran === true && !view.live?.busy)
    );
}

/**
 * The native messages this tab sent to the open session that the view does not show yet, oldest first, including
 * those of unknown outcome. Only the server's user entry with the same browser request id and member replaces one, so
 * equal text from someone else, or another send by this person, never does.
 */
export function sendsInFlight(state) {
    const { view, me } = state;
    const sends = state.pendingSends.filter(
        (send) => send.conversationId === view.conversation?.id,
    );

    if (sends.length === 0) {
        return sends;
    }

    return sends.filter((send) => {
        // Where the view started over (another branch, a reset), the whole of it is looked through.
        const from = send.after === null ? 0 : view.order.indexOf(send.after) + 1;

        for (let index = from; index < view.order.length; index++) {
            const id = view.order[index];
            const entry = view.entries.get(id);

            if (
                entry?.kind === "user" &&
                entry.requestId === send.key &&
                view.authors?.[id] === me?.id
            ) {
                echoedEntries.add(id);

                return false;
            }
        }

        return true;
    });
}

// ─── Saved copies of recent sessions (view-cache.js) ───────────────────────────────

/** A view is saved this long after its transcript last changed, when the tab is idle. */
const SAVE_AFTER_MS = 1000;
let savedOrder = null;
let saveTimer = null;
/** Who signed in and what they may see, as last known: undefined unknown, null signed out. */
let savedAccess;
let saving = true;

if (window.__rotomPerf && typeof indexedDB !== "undefined") {
    window.__rotomPerf.viewCache = true;
}

function saveSoon() {
    const { view, me } = store.state;

    if (!saving || !me || !view.conversation || view.checking || view.build === null) {
        return;
    }

    saveView(view, me).then((saved) => {
        const perf = window.__rotomPerf;

        if (saved && perf) {
            perf.viewCacheSaves = (perf.viewCacheSaves ?? 0) + 1;
        }
    });
}

store.subscribe((state) => {
    const access = state.me ? accessOf(state.me) : state.me;

    // Signed out, or someone else, or other access: no copy outlives it.
    if (access !== savedAccess) {
        if (state.me === null || typeof savedAccess === "string") {
            clearViews();
        }

        savedAccess = access;
    }

    const view = state.view;

    if (!state.me || !view.conversation || view.checking || view.order === savedOrder) {
        return;
    }

    savedOrder = view.order;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(
        () => (window.requestIdleCallback ?? ((run) => run()))(saveSoon),
        SAVE_AFTER_MS,
    );
});

/** Signing out: stop saving and remove every saved copy, before the sign-in cookie goes. */
export function forgetSavedViews() {
    saving = false;
    clearTimeout(saveTimer);

    return clearViews();
}

opened(store.state.conversationId);

export function routeConversation() {
    const match = /^\/s\/(\d+)/.exec(location.pathname);

    return match ? Number(match[1]) : null;
}

// ─── People: presence, typing, and the side chat ───────────────────────────────────

// A function declaration, not a const: the store's initial state calls it before this line runs.
function readKey(id) {
    return `pocket.chatRead.${id}`;
}

/** Fresh people state for a conversation: no one known yet, and how far this browser has read its chat. */
export function peopleFor(id) {
    return {
        chat: [],
        presence: [],
        notes: null,
        chatQuote: null,
        chatRead: id === null ? 0 : chatReadOf(id),
    };
}

/** How far this browser has read a conversation's chat: the time of the newest message seen. */
function chatReadOf(id) {
    return Number(localStorage.getItem(readKey(id)) ?? 0);
}

/** Someone else chatted in a session after this browser last read its chat. */
export function sessionUnread(session, state = store.state) {
    const read = session.id === state.conversationId ? state.chatRead : chatReadOf(session.id);

    return session.chatAt !== undefined && session.chatBy !== state.me?.id && session.chatAt > read;
}

/** A finished round awaiting this member's view, never another member's shared read state. */
export function sessionFinishedUnread(session) {
    return session.finishedUnread === true && !session.busy;
}

/** Server features the web app may use. `collab` 2 adds roles, take turns, reactions, pins, notes, mentions, push. */
export const collab = () => (store.state.server?.collab ?? 0) >= 2;
/** Viewers read and chat; they never steer Pi. */
export const canSteer = () => store.state.me?.role !== "viewer";
/** People invited to one session cannot start sessions or invite others. */
export const scoped = () => Array.isArray(store.state.me?.sessions);

/** Everything in the chat counts as read: called while the chat is open. */
export function markChatRead() {
    const { chat, chatRead, conversationId } = store.state;
    const last = chat.at(-1)?.at ?? 0;

    if (last <= chatRead || conversationId === null) {
        return;
    }

    localStorage.setItem(readKey(conversationId), String(last));
    store.set({ chatRead: last });
}

let typingSent = { where: null, at: 0, conversationId: null };

/** Tell others this person is typing ("chat" or "pi") or stopped (null). Renewed at most every few seconds. */
export function typing(where) {
    const id = store.state.conversationId;

    if (!store.state.server?.chat || id === null) {
        return;
    }

    const now = Date.now();
    const same = typingSent.conversationId === id && typingSent.where === where;

    if (same && (where === null || now - typingSent.at < 3000)) {
        return;
    }

    typingSent = { where, at: now, conversationId: id };
    api(`c/${id}/typing`, { where }).catch(() => {});
}

export class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

export async function api(path, body, options = {}) {
    const init = {
        method: body === undefined && !options.method ? "GET" : (options.method ?? "POST"),
        headers: { "X-Pocket": "1" },
    };

    if (body !== undefined) {
        if (body instanceof Blob) {
            init.body = body;
            init.headers["content-type"] = body.type || "application/octet-stream";
        } else {
            init.body = JSON.stringify(body);
            init.headers["content-type"] = "application/json";
        }
    }

    const response = await fetch(`/api/${path}`, init);
    const text = await response.text();
    let data;

    try {
        data = text ? JSON.parse(text) : {};
    } catch {
        data = { error: text };
    }

    if (!response.ok) {
        throw new ApiError(response.status, data.error ?? `HTTP ${response.status}`);
    }

    return data;
}

let nextNotice = 1;

/** Show a short notice. With `action`, tapping it runs the action as well as dismissing it. */
export function notify(level, message, action) {
    const id = nextNotice++;

    store.set((state) => ({
        notices: [...state.notices, { id, level, message, action }].slice(-4),
    }));
    setTimeout(() => dismiss(id), level === "error" ? 9000 : 4500);
}

export function dismiss(id) {
    store.set((state) => ({ notices: state.notices.filter((notice) => notice.id !== id) }));
}

/** Run an action and show its error, if any, as a notice. */
export async function attempt(action) {
    try {
        return await action();
    } catch (error) {
        notify("error", error.message ?? String(error));

        return undefined;
    }
}
