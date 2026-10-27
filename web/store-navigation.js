import {
    store,
    api,
    uid,
    SENDS_KEPT,
    lostSend,
    ApiError,
    notify,
    dropSend,
} from "./store-state.js";
import { connectSaved } from "./store-transport.js";
import { readView } from "./view-cache.js";
import { sending, sendFailed, sendAnswered } from "./perf.js";
import { pushRoute } from "./back.js";
import { loadAllEntries, markRunSeen } from "./store-views.js";

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

export const current = () => store.state.conversationId;

export const actions = {
    /** `inlineFiles`: the files the message mentions with @ go along with it. */
    submit: (text, attachments, mode, inlineFiles = false, wait) => {
        const view = store.state.view;
        // Only a message to an idle session is timed: a queued one waits for the run, and a command has no reply.
        const idle = view.conversation && !view.live?.busy && !text.trimStart().startsWith("/");
        // Native entries carry the browser request id; other backends keep their confirmed-only display.
        const optimistic = idle && view.kernel && text.trim() !== "";
        const requestId = uid();
        const timed = idle ? sending(view, { echoed: optimistic, requestId }) : undefined;
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
    markRunSeen,
    fullEntry: (entryId) => api(`c/${current()}/entry/${entryId}`),
    history: (before) => api(`c/${current()}/history?before=${before}`),
};

/**
 * Where the entries this tab holds without a gap begin in `view`'s order: 0 when it holds every entry. Those before
 * it, the view did not send (`TRANSCRIPT_TAIL`).
 */
