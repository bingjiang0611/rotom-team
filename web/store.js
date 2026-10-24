// App state, the server connection, and API calls. Components read `store.state` and re-render on `store.subscribe`.
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

/** A random id. crypto.randomUUID only exists on https and localhost pages; plain-http network addresses lack it. */
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

const TAB = sessionStorage.getItem(TAB_KEY) ?? uid();

sessionStorage.setItem(TAB_KEY, TAB);

const emptyView = () => ({
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
function savedView(record) {
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

// room.ts sends these JSON fields afresh even on token-only updates. Other view fields retain references in
// applyView; in particular, entries is a Map and must never be compared as a JSON object.
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

// ─── Messages on their way (sendsInFlight) ───────────────────────────────

/** Past this a message still without its entry is no longer shown as on its way, but as of unknown outcome. */
const SEND_SHOWN_MS = 2 * 60_000;

/** The most messages kept here: older ones are dropped first. Only lost sends stay long. */
const SENDS_KEPT = 20;

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

function lostSend(key) {
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

function routeConversation() {
    const match = /^\/s\/(\d+)/.exec(location.pathname);

    return match ? Number(match[1]) : null;
}

// ─── People: presence, typing, and the side chat ───────────────────────────────────

const CHAT_LIMIT = 500;

// A function declaration, not a const: the store's initial state calls it before this line runs.
function readKey(id) {
    return `pocket.chatRead.${id}`;
}

/** Fresh people state for a conversation: no one known yet, and how far this browser has read its chat. */
function peopleFor(id) {
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

function applyChat(data) {
    const state = store.state;

    if (data.conversationId !== state.conversationId) {
        return;
    }

    const known = new Set(data.full ? [] : state.chat.map((message) => message.id));
    const added = data.messages.filter((message) => !known.has(message.id));

    store.set({ chat: (data.full ? data.messages : [...state.chat, ...added]).slice(-CHAT_LIMIT) });

    // The People panel stays open for long: on its Pinned or Notes tab, new messages still count and show a notice.
    if (state.sheet?.type === "chat" || chatLogs > 0) {
        markChatRead();

        return;
    }

    // A full list comes on connect: only live messages from others pop up.
    const fresh = data.full
        ? []
        : added.filter((message) => message.userId !== state.me?.id && message.kind !== "event");

    if (fresh.length === 0) {
        return;
    }

    const open = () => openSheet({ type: "chat" });

    if (fresh.length > 1) {
        return notify("info", `${fresh.length} new chat messages`, open);
    }

    const [message] = fresh;
    const name = state.users.find((user) => user.id === message.userId)?.name ?? message.name;
    const text = message.text.replace(/\s+/g, " ");
    const mentioned = message.mentions?.includes(state.me?.id);

    notify(
        "info",
        `${name}${mentioned ? " mentioned you" : ""}: ${text.length > 120 ? `${text.slice(0, 119)}…` : text}`,
        open,
    );
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

class ApiError extends Error {
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

let source;

const markingFinished = new Set();

/** Mark only the current visible member's loaded result. A newer finish keeps its own unread marker. */
function markOpenFinished() {
    const state = store.state;
    const id = state.conversationId;
    const session = state.sessions.find((each) => each.id === id);

    if (
        id === null ||
        document.visibilityState !== "visible" ||
        state.view.conversation?.id !== id ||
        state.view.live?.busy ||
        state.view.conversation.finishedAt !== session?.finishedAt ||
        !sessionFinishedUnread(session ?? {}) ||
        markingFinished.has(`${id}:${session.finishedAt}`)
    ) {
        return;
    }

    const key = `${id}:${session.finishedAt}`;

    markingFinished.add(key);
    actions
        .markRunSeen(id, session.finishedAt)
        .catch(() => {})
        .finally(() => markingFinished.delete(key));
}

function applyView(data) {
    const perf = window.__rotomPerf;
    const started = perf ? performance.now() : 0;
    const becameReady =
        store.state.view.kernel?.initializing === true && data.kernel?.initializing === false;

    if (data.livePatch) {
        const before = store.state.view;
        const blocks = data.live?.generation?.message?.blocks;
        const append = data.livePatch.append;
        const valid =
            !data.full &&
            before.conversation?.id === data.conversation.id &&
            before.liveVersion === data.livePatch.base &&
            data.liveVersion === data.livePatch.base + 1 &&
            Array.isArray(blocks) &&
            Array.isArray(append) &&
            append.every(({ index, at }) => {
                const old = before.live?.generation?.message?.blocks[index];
                const next = blocks[index];

                return (
                    (next?.type === "text" || next?.type === "thinking") &&
                    old?.type === next.type &&
                    old.text.length === at
                );
            });

        if (!valid) {
            // A lost baseline must not produce truncated or concatenated text. Get a fresh full snapshot, read only.
            unclaimed = true;
            connect();

            return;
        }

        const joined = [...blocks];

        for (const { index } of append) {
            joined[index] = {
                ...blocks[index],
                text: before.live.generation.message.blocks[index].text + blocks[index].text,
            };
        }

        data = {
            ...data,
            live: {
                ...data.live,
                generation: { ...data.live.generation, message: { blocks: joined } },
            },
        };
    }

    let baseEntryCopies = 0;
    let deltaEntries = 0;
    let pruneChecks = 0;
    let orderIds = 0;

    store.set((state) => {
        const sameConversation = state.view.conversation?.id === data.conversation.id;
        // A full view that keeps a run the tab claimed starts from that run of what the tab held, and nothing else.
        const base =
            data.full && data.kept && sameConversation
                ? {
                      ...emptyView(),
                      entries: keptEntries(state.view.entries, data.order, data.kept),
                  }
                : data.full || !sameConversation
                  ? emptyView()
                  : state.view;
        // Live/status-only updates do not change transcript entries. Keep their immutable Map instead of copying it.
        const changesEntries = data.entries.length > 0 || data.order !== undefined;
        const entries = changesEntries ? new Map(base.entries) : base.entries;

        baseEntryCopies = changesEntries ? base.entries.size : 0;
        deltaEntries = data.entries.length;

        for (const entry of data.entries) {
            entries.set(entry.id, entry);
        }

        const order = data.order ?? base.order;

        if (data.order) {
            const keep = new Set(data.order);

            orderIds = data.order.length;

            for (const id of entries.keys()) {
                pruneChecks++;

                if (!keep.has(id)) {
                    entries.delete(id);
                }
            }
        }

        return {
            ...(state.view.kernel?.segmentId !== data.kernel?.segmentId
                ? { templates: null }
                : state.templates &&
                    (state.templates.revision ?? null) !== (data.kernel?.commandsRevision ?? null)
                  ? {
                        templates: {
                            ...state.templates,
                            at: 0,
                            freshness: "configuration-changed",
                        },
                    }
                  : {}),
            view: {
                ...base,
                conversation: data.conversation,
                entries,
                order,
                live: data.live,
                liveVersion: data.liveVersion,
                inbox: data.inbox,
                agent: data.agent,
                stats: data.stats,
                clients: data.clients,
                viewers: data.viewers,
                approvals: data.approvals,
                // The server sends these again only when they change: a missing one keeps its last value.
                artifacts: data.artifacts ?? base.artifacts,
                subagents: data.subagents ?? base.subagents,
                authors: data.authors ?? base.authors,
                reactions: data.reactions ?? base.reactions,
                pins: data.pins ?? base.pins,
                turns: data.turns ?? base.turns,
                decisions: data.decisions ?? base.decisions,
                plan: data.plan ?? base.plan,
                schedules: data.schedules ?? base.schedules,
                // No goal is null, which the server sends too: only a missing field keeps the last value.
                goal: data.goal === undefined ? base.goal : data.goal,
                nativeGoal: data.nativeGoal === undefined ? base.nativeGoal : data.nativeGoal,
                // What the folder has checked out: `{ branch }` or `{ detached }`, and null outside a repository.
                branch: data.branch === undefined ? base.branch : data.branch,
                kernel: data.kernel ?? null,
                checking: false,
                build: data.full ? (state.server?.startedAt ?? null) : base.build,
            },
            missing: null,
        };
    });

    // The server keeps what the claim named; should the tab not hold all of it after all, connect again for everything.
    // Entries before `start` were not sent: the tab reads them when it needs them.
    if (
        data.full &&
        data.kept &&
        store.state.view.order
            .slice(data.start ?? 0)
            .some((id) => !store.state.view.entries.has(id))
    ) {
        unclaimed = true;
        connect();
    }

    if (perf) {
        perf.viewApplyCalls++;
        perf.viewApplyMs += performance.now() - started;
        perf.viewBaseEntryCopies += baseEntryCopies;
        perf.viewDeltaEntries += deltaEntries;
        perf.viewPruneChecks += pruneChecks;
        perf.viewOrderIds += orderIds;
    }

    markOpenFinished();

    if (data.full || becameReady) {
        warmSession();
    }
}

/** The `moving` marks that a session list has not caught up with yet: it still shows those sessions where they were. */
export function stillMoving(moving, sessions) {
    const next = { ...moving };

    for (const session of sessions) {
        if (next[session.id] === Boolean(session.archived)) {
            delete next[session.id];
        }
    }

    return next;
}

/** What the server sends, by event name. Both transports deliver the same events. */
/** A full-list request on the current stream is pending; deltas are ignored until its snapshot arrives. */
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

const handlers = {
    hello: (data) =>
        store.set({
            me: data.user,
            users: data.users,
            models: data.models,
            guard: data.guard,
            server: data.server,
            // This connection's id, which peek lists name (`peeks.js`). `GET /api/me` answers without one.
            ...(data.connection === undefined ? {} : { streamId: data.connection }),
        }),
    sessions: (data) => {
        const snapshot = sessionSnapshot(data);

        syncingSessions = null;
        keepViews(new Set(snapshot.sessions.map((session) => session.id)));
        store.set((state) => ({
            ...snapshot,
            sessionsLoaded: true,
            moving: stillMoving(state.moving, snapshot.sessions),
        }));
        markOpenFinished();
    },
    "sessions-delta": (data) => {
        if (syncingSessions !== null) {
            return;
        }

        const state = store.state;
        const patch = sessionDelta(state.sessions, state.sessionListVersion, data);

        if (patch === null) {
            resyncSessions();

            return;
        }

        store.set({ ...patch, moving: stillMoving(state.moving, patch.sessions) });
    },
    models: (models) => store.set({ models }),
    view: applyView,
    chat: applyChat,
    presence: (data) =>
        data.conversationId === store.state.conversationId && store.set({ presence: data.people }),
    notes: (data) =>
        data.conversationId === store.state.conversationId &&
        store.set({ notes: { text: data.text, rev: data.rev, by: data.by, at: data.at } }),
    browser: (data) =>
        data.conversationId === store.state.conversationId && store.set({ browser: data }),
    // Whether the server watches this session's repository, and a count of the times something there may have moved
    // (`diff.js` reads Changes again on each): each change, and each reconnect, which may have missed some.
    changes: (data) =>
        data.conversationId === store.state.conversationId &&
        store.set((state) => {
            const known = state.changesSignal?.conversationId === data.conversationId;
            const moves = known ? state.changesSignal.moves + 1 : 0;

            return {
                changesSignal: {
                    conversationId: data.conversationId,
                    watching: data.watching,
                    moves,
                },
            };
        }),
    // Another session as its peek tile shows it (`peeks.js`): kept after it scrolls away, as the tile's last look.
    peek: (data) =>
        store.set((state) => ({ peeks: { ...state.peeks, [data.conversationId]: data } })),
    users: (users) => store.set({ users }),
    missing: (data) => {
        const id = store.state.conversationId;

        if (id !== null) {
            dropView(id);
        }

        store.set((state) => ({
            missing: data.message,
            ...(state.view.checking ? { view: emptyView() } : {}),
        }));
    },
    // A notice may link to a conversation, such as a mention elsewhere: tapping it goes there.
    notice: (data) =>
        notify(
            data.level,
            data.message,
            data.link
                ? () =>
                      navigate(data.link.conversationId, {
                          sheet: data.link.sheet ? { type: data.link.sheet } : null,
                      })
                : undefined,
        ),
    auth: (data) => handleAuth(data),
    closing: () => store.set({ connection: "closed" }),
    reload: () => {
        // A web file changed on the server. Message drafts live in localStorage and survive the reload; an unsaved notes
        // draft, attachments not yet sent, and an open provider sign-in do not.
        setTimeout(() => location.reload(), 150);
    },
};

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
function connectSaved(id, reading) {
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

export async function start() {
    const id = store.state.conversationId;
    // Read the saved copy while asking who this is; it shows only once the answer says it is theirs.
    const reading = id === null ? undefined : readView(id);

    try {
        const hello = await api("me");

        store.set({
            me: hello.user,
            users: hello.users,
            models: hello.models,
            guard: hello.guard,
            server: hello.server,
        });
        connectSaved(id, reading);
    } catch (error) {
        store.set({ me: error.status === 401 ? null : undefined });

        if (error.status !== 401) {
            notify("error", `Server unreachable: ${error.message}`);
            setTimeout(start, 3000);
        }
    }
}

// ─── Commands ───────────────────────────────────────────────────────────

const current = () => store.state.conversationId;

export const actions = {
    /** `inlineFiles`: the files the message mentions with @ go along with it. */
    submit: (text, attachments, mode, inlineFiles = false, wait) => {
        const view = store.state.view;
        // Only a message to an idle session is timed: a queued one waits for the run, and a command has no reply.
        const idle = view.conversation && !view.live?.busy && !text.trimStart().startsWith("/");
        // Native entries carry the browser request id; other backends keep their confirmed-only display.
        const optimistic = idle && view.kernel && text.trim() !== "";
        const timed = idle ? sending(view, { echoed: optimistic }) : undefined;
        const requestId = uid();
        const request = api(`c/${current()}/submit`, {
            text,
            attachments,
            mode,
            requestId,
            ...(inlineFiles ? { inlineFiles } : {}),
            // Ordinary rotom prompts answer once intent is recorded; native commands wait for handler rejection.
            ...(store.state.view.kernel ? { wait: wait ?? false } : {}),
        });

        if (timed !== undefined) {
            request.then(
                (result) => {
                    if (result?.status === "rejected") {
                        sendFailed(timed);
                    } else if (!["unknown", "interrupted"].includes(result?.status)) {
                        sendAnswered(timed);
                    }
                },
                () => sendFailed(timed),
            );
        }

        // The message shows at once, marked as going, until its entry takes its place. A send the server refused
        // goes away; one whose answer was lost or unknown stays, marked as such (`sendUnknown`).
        if (optimistic) {
            store.set((state) => ({
                pendingSends: [
                    ...state.pendingSends,
                    {
                        key: requestId,
                        conversationId: view.conversation.id,
                        text: text.trim(),
                        at: Date.now(),
                        after: view.order.at(-1) ?? null,
                        ran: false,
                        unknown: false,
                    },
                ].slice(-SENDS_KEPT),
            }));

            const lost = () => {
                lostSend(requestId);
                notify(
                    "warning",
                    "Not known whether your message was sent. It shows as sent if it arrives; check before sending it again.",
                );
            };

            request.then(
                (result) => {
                    if (result?.status === "rejected") {
                        dropSend(requestId);
                    } else if (["unknown", "interrupted"].includes(result?.status)) {
                        lost();
                    }
                },
                // A refusal has an answer below 500; no answer, or a server failure, may have come after it went.
                (error) =>
                    error instanceof ApiError && error.status < 500 ? dropSend(requestId) : lost(),
            );
        }

        return request;
    },
    nativeSettings: (patch) => api(`c/${current()}/native-settings`, patch),
    /** A rotom session operation on the head this browser last saw. A lost answer is never resent. */
    kernel: (operation, extra = {}) =>
        api(`c/${current()}/${operation}`, {
            requestId: uid(),
            ...(operation === "compact"
                ? {}
                : { expectedHead: store.state.view.kernel?.segmentId }),
            ...extra,
        }),
    /** Run a command in the session's folder (`!`); `context: false` keeps it from Pi (`!!`). */
    shell: (command, context, requestId = uid()) =>
        api(`c/${current()}/shell`, { command, context, requestId }),
    stopShell: (taskId) => api(`c/${current()}/shell/${taskId}/stop`, {}),
    /** A file or folder for the viewer. */
    view: (path) => api(`c/${current()}/view?path=${encodeURIComponent(path)}`),
    fileLocations: (path) => api(`c/${current()}/file-locations?path=${encodeURIComponent(path)}`),
    /** What changed in the session's folder: git's uncommitted changes, and Pi's edits. */
    changes: (id = current()) => api(`c/${id}/changes`),
    branches: () => api(`c/${current()}/branches`),
    switchBranch: (target) => api(`c/${current()}/branch`, target),
    /** Undo the uncommitted changes to one file. */
    revert: (path) => api(`c/${current()}/changes/revert`, { path }),
    abort: () => api(`c/${current()}/abort`, {}),
    chat: (text, quote) =>
        api(`c/${current()}/chat`, {
            text,
            requestId: uid(),
            ...(quote ? { quote: { entryId: quote.entryId } } : {}),
        }),
    react: (entryId, emoji) => api(`c/${current()}/react`, { entryId, emoji }),
    pin: (target) => api(`c/${current()}/pin`, target),
    saveNotes: (text, rev) => api(`c/${current()}/notes`, { text, rev }),
    turns: (action, to) => api(`c/${current()}/turns`, { action, ...(to ? { to } : {}) }),
    setAccess: (userId, patch) => api(`users/${encodeURIComponent(userId)}`, patch),
    withdraw: (submissionId) => api(`c/${current()}/withdraw`, { submissionId }),
    configure: (change) => api(`c/${current()}/configure`, change),
    compact: (instructions) =>
        api(`c/${current()}/compact`, {
            instructions,
            ...(store.state.view.kernel ? { requestId: uid() } : {}),
        }),
    reset: (note) => api(`c/${current()}/reset`, { note }),
    setInstructions: (text) => api(`c/${current()}/instructions`, { text }),
    /** A new session with this one's history through `entryId`. */
    fork: (entryId, { worktree = false } = {}) =>
        api(`c/${current()}/fork`, { entryId, ...(worktree ? { worktree } : {}) }),
    /** Send a message to Pi again in a fork that ends just before it: `{ text }` edits it, `{ model }` picks another model. */
    resend: (entryId, change = {}) => api(`c/${current()}/resend`, { entryId, ...change }),
    setPlan: (on) => api(`c/${current()}/plan`, { on }),
    approvePlan: () => api(`c/${current()}/plan`, { approve: true }),
    prompts: () => api(`c/${current()}/prompts`),
    discoverCommands: () => api(`c/${current()}/prompts`, { requestId: uid() }),
    /** `when` says when, then what Pi gets: `in 2h check the deploy`. Clock times are this device's. */
    schedule: (when) =>
        api(`c/${current()}/schedules`, {
            when,
            zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
    cancelSchedule: (id) => api(`c/${current()}/schedules/${encodeURIComponent(id)}/cancel`, {}),
    setGoal: (command) => api(`c/${current()}/goal`, { command }),
    removeWorktree: (force) => api(`c/${current()}/worktree`, { remove: true, force }),
    clearGoal: () => api(`c/${current()}/goal`, { clear: true }),
    approve: (id, allow) => api(`approvals/${encodeURIComponent(id)}`, { allow }),
    /** `worktree`: the session works in a git worktree of its own, made from the folder. */
    // With rotom enabled on this server, every new session runs on it: one engine, one transcript.
    createSession: (
        cwd,
        { worktree = false, backend = store.state.server?.kernel ? "rotom" : "durable" } = {},
    ) =>
        api("sessions", {
            cwd,
            ...(worktree ? { worktree } : {}),
            ...(backend === "rotom" ? { backend } : {}),
        }),
    updateSession: (id, patch) => api(`sessions/${id}`, patch),
    upload: (file, id = current()) =>
        api(`c/${id}/upload?name=${encodeURIComponent(file.name)}`, file),
    markRunSeen: (id, finishedAt) =>
        api(`c/${id}/seen`, { finishedAt }).then(() => {
            store.set((state) => ({
                sessions: state.sessions.map((session) =>
                    session.id === id && session.finishedAt <= finishedAt
                        ? { ...session, finishedUnread: false }
                        : session,
                ),
            }));
        }),
    fullEntry: (entryId) => api(`c/${current()}/entry/${entryId}`),
    history: (before) => api(`c/${current()}/history?before=${before}`),
};

/**
 * Where the entries this tab holds without a gap begin in `view`'s order: 0 when it holds every entry. Those before
 * it, the view did not send (`TRANSCRIPT_TAIL`).
 */
export function heldFrom(view) {
    for (let index = view.order.length - 1; index >= 0; index--) {
        if (!view.entries.has(view.order[index])) {
            return index + 1;
        }
    }

    return 0;
}

/** The earlier page on its way, per conversation: a second ask waits for it. */
const earlierPages = new Map();

/**
 * Read the page of entries just before those this tab holds without a gap, into the view. Resolves to how many it
 * added: 0 when the tab holds every entry already, or the server's order moved on (a view on its way says how).
 */
export function loadEarlier() {
    const { view } = store.state;
    const id = view.conversation?.id;
    const at = heldFrom(view);

    if (id === undefined || at === 0) {
        return Promise.resolve(0);
    }

    const key = `${id}:${view.order[at]}`;
    let pending = earlierPages.get(key);

    if (pending === undefined) {
        pending = api(`c/${id}/entries?before=${view.order[at]}`)
            .then(({ entries: page }) => {
                let added = 0;

                store.set((state) => {
                    if (state.view.conversation?.id !== id) {
                        return {};
                    }

                    const known = new Set(state.view.order);
                    const entries = new Map(state.view.entries);

                    for (const entry of page) {
                        if (known.has(entry.id) && !entries.has(entry.id)) {
                            entries.set(entry.id, entry);
                            added++;
                        }
                    }

                    return added === 0 ? {} : { view: { ...state.view, entries } };
                });

                return added;
            })
            .finally(() => earlierPages.delete(key));
        earlierPages.set(key, pending);
    }

    return pending;
}

/**
 * Read every entry of the view this tab lacks, for what needs the whole history (find, written files). Stops when a
 * page adds nothing, and after `pages` pages.
 */
export async function loadAllEntries(pages = 100) {
    for (let page = 0; page < pages && heldFrom(store.state.view) > 0; page++) {
        if ((await loadEarlier()) === 0) {
            return;
        }
    }
}

/**
 * The badge of a session's outputs: artifacts and written files, and `+` while earlier entries are not read yet, so
 * there may be more.
 */
export function outputsBadge(view) {
    const count =
        view.artifacts.length +
        writtenFiles(view.order.map((id) => view.entries.get(id)).filter(Boolean)).length;

    return { count, label: `${count}${heldFrom(view) > 0 ? "+" : ""}` };
}

/** When this tab last asked to warm each session, so focusing the message box again soon asks nothing. */
const warmedAt = new Map();
/** Less than the server keeps an unused warm process (`WARM_UNUSED_MS`), so a process that retired is asked again. */
const WARM_AGAIN_MS = 4 * 60_000;

/**
 * Ask the server to start this session's native process on confirmed open, visibility return or composer focus:
 * only where the session runs on their own account and is idle. The server checks everything again and
 * may refuse; nothing here waits for it or shows it.
 */
export function warmSession() {
    const { view } = store.state;
    const id = view.conversation?.id;

    if (
        id === undefined ||
        id !== store.state.conversationId ||
        document.hidden ||
        view.checking ||
        !view.kernel?.yours ||
        view.kernel.initializing ||
        view.live?.busy ||
        !canSteer() ||
        Date.now() - (warmedAt.get(id) ?? -Infinity) < WARM_AGAIN_MS
    ) {
        return;
    }

    warmedAt.set(id, Date.now());
    api(`c/${id}/warm`, {})
        .then((result) => {
            // A transient refusal (for example another session still warming) must not suppress composer focus.
            if (!result.warmed) {
                warmedAt.delete(id);
            }
        })
        .catch(() => warmedAt.delete(id));
}

/** Entries that show as transcript rows. Tool results show inside their call's card instead. */
export const isRow = (entry) =>
    ["user", "assistant", "compaction", "reset", "shell", "note"].includes(entry.kind);

/**
 * Show the transcript from this entry down when it is above the rows shown now, as for a jump to a pinned or quoted
 * message. Compares places in the transcript, not ids: after a compaction, the summary comes first with the newest id.
 */
export function revealEntry(entryId) {
    const { view, transcriptFrom } = store.state;

    if (transcriptFrom === null) {
        return;
    }

    const ids = view.order.filter((id) => {
        const entry = view.entries.get(id);

        return entry !== undefined && isRow(entry);
    });
    const at = ids.indexOf(entryId);
    const from = ids.indexOf(transcriptFrom);

    if (at !== -1 && (from === -1 || at < from)) {
        store.set({ transcriptFrom: entryId });
    }
}

// ─── The People panel ──────────────────────────────────────────────────────────────

const PEOPLE_KEY = "pocket.people";
/** Wide enough for the session list, the conversation, and a panel beside it: where the Browser panel docks too. */
const PEOPLE_DOCK = matchMedia("(min-width: 1100px)");

/**
 * Panels (People, Browser, Files) dock beside the conversation now; narrower, the Browser panel and the Files tile cover
 * the screen, and back closes them. A change re-renders (below).
 */
export const panelsBeside = () => PEOPLE_DOCK.matches;

/** The People panel shows beside the conversation now. */
export function peopleDocked(state = store.state) {
    return (
        state.peopleOpen &&
        PEOPLE_DOCK.matches &&
        Boolean(state.server?.chat) &&
        state.conversationId !== null &&
        !state.missing
    );
}

/**
 * What showing a sheet changes. On wide screens the chat docks beside the conversation instead, as the People panel, and
 * takes the Browser panel's place: both beside the conversation leave it too narrow.
 */
function sheetChange(sheet, state) {
    if (sheet?.type !== "chat" || !PEOPLE_DOCK.matches) {
        return { sheet };
    }

    sessionStorage.setItem(PEOPLE_KEY, "1");
    sessionStorage.removeItem("pocket.browser");
    sessionStorage.removeItem("pocket.files");

    return {
        sheet: null,
        peopleOpen: true,
        browserOpen: false,
        filesOpen: false,
        peopleAsk: {
            tab: sheet.tab ?? null,
            highlight: sheet.highlight ?? null,
            n: state.peopleAsk.n + 1,
        },
    };
}

/**
 * The Files tile shows now: asked for, in a conversation, for someone who can steer, and not in the Browser panel's
 * place (one panel at a time). `App` draws it by this, and `openFile` opens files in it by this.
 */
export function filesShown(state = store.state) {
    // `browserAvailable()` (browser.js), which imports this module.
    const browsing =
        state.browserOpen && state.server?.extensions?.includes("pocket-browser") === true;

    return (
        state.filesOpen &&
        state.conversationId !== null &&
        !state.missing &&
        state.me?.role !== "viewer" &&
        !browsing
    );
}

/** Hide the People panel. Showing it is `openSheet({ type: "chat" })`, which docks it on wide screens. */
export function closePeople() {
    sessionStorage.removeItem(PEOPLE_KEY);

    // Its active border goes to the conversation, not nowhere.
    if (document.documentElement.dataset.focus === "people") {
        document.documentElement.dataset.focus = "pane";
    }

    store.set({ peopleOpen: false });
}

let chatLogs = 0;

/** A chat log is on screen, as the People sheet's or panel's Chat tab: call when it shows, and what it returns when it goes. */
export function chatLogShown() {
    chatLogs++;

    return () => {
        chatLogs--;
    };
}

// A window widened with the chat open as a sheet docks it. One narrowed hides the panel until it is wide again.
PEOPLE_DOCK.addEventListener("change", () => {
    const { sheet } = store.state;

    if (PEOPLE_DOCK.matches && sheet?.type === "chat") {
        openSheet(sheet);
    } else {
        store.set({});
    }
});

export function openSheet(sheet) {
    store.set((state) => ({ ...sheetChange(sheet, state), drawer: false }));
}

/**
 * Put text into the message box to Pi (after what is there: on a new paragraph, or with `inline`, after a space), and
 * files to attach, and close any sheet so it shows.
 */
export function insertIntoComposer(text, files = [], { inline = false, replace = false } = {}) {
    store.set((state) => ({
        sheet: null,
        composerInsert: { text, files, inline, replace, n: (state.composerInsert?.n ?? 0) + 1 },
    }));
}

/** Open the chat to discuss a transcript message: the next chat message quotes it. */
export function discuss(entryId, text) {
    store.set((state) => ({
        chatQuote: { entryId, text },
        ...sheetChange({ type: "chat" }, state),
        drawer: false,
    }));
}

// Tell the server when this tab is hidden or shown: others see "away", and push notifications only reach hidden tabs.
let lastVisible = null;

function reportVisibility() {
    const visible = document.visibilityState === "visible";

    if (visible === lastVisible || !collab()) {
        return;
    }

    lastVisible = visible;
    api("visibility", { tab: TAB, visible }).catch(() => {});
}

document.addEventListener("visibilitychange", () => {
    reportVisibility();
    markOpenFinished();
    warmSession();
});
store.subscribe((state) => {
    // Report again after each (re)connect: the server starts every new connection as visible.
    if (state.connection !== "open") {
        lastVisible = null;
    } else if (lastVisible === null && document.visibilityState !== "visible") {
        reportVisibility();
    }
});

export function closeSheet() {
    store.set({ sheet: null });
}

// Per-conversation composer drafts survive reloads, including the automatic ones after a live edit.
export const drafts = {
    get: (id) => localStorage.getItem(`pocket.draft.${id ?? "home"}`) ?? "",
    set: (id, text) => {
        if (text) {
            localStorage.setItem(`pocket.draft.${id ?? "home"}`, text);
        } else {
            localStorage.removeItem(`pocket.draft.${id ?? "home"}`);
        }
    },
};
