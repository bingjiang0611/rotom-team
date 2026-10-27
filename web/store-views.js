import {
    store,
    api,
    collab,
    canSteer,
    sessionFinishedUnread,
    markChatRead,
    notify,
    TAB,
} from "./store-state.js";
import { writtenFiles } from "./calls.js";

const markingFinished = new Set();

/** Mark only the current visible member's loaded result. A newer finish keeps its own unread marker. */
export function markOpenFinished() {
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
    markRunSeen(id, session.finishedAt)
        .catch(() => {})
        .finally(() => markingFinished.delete(key));
}

export const markRunSeen = (id, finishedAt) =>
    api(`c/${id}/seen`, { finishedAt }).then(() => {
        store.set((state) => ({
            sessions: state.sessions.map((session) =>
                session.id === id && session.finishedAt <= finishedAt
                    ? { ...session, finishedUnread: false }
                    : session,
            ),
        }));
    });

const CHAT_LIMIT = 500;

export function applyChat(data) {
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
export function sheetChange(sheet, state) {
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
