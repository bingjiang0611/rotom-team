import { store, emptyView, notify } from "./store-state.js";
import { keepViews, dropView } from "./view-cache.js";
import { sessionDelta, sessionSnapshot } from "./session-list.js";
import { stillMoving } from "./store-projection.js";
import { markOpenFinished, applyChat } from "./store-views.js";

/** Both transports deliver the same events; connection ownership stays in store-transport. */
export function createEventHandlers({
    resyncSessions,
    resetSessionSync,
    isSyncing,
    handleAuth,
    navigate,
    applyView,
}) {
    return {
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

            resetSessionSync();
            keepViews(new Set(snapshot.sessions.map((session) => session.id)));
            store.set((state) => ({
                ...snapshot,
                sessionsLoaded: true,
                moving: stillMoving(state.moving, snapshot.sessions),
            }));
            markOpenFinished();
        },
        "sessions-delta": (data) => {
            if (isSyncing()) {
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
            data.conversationId === store.state.conversationId &&
            store.set({ presence: data.people }),
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
}
