// Native conversations use their own receipts/transcript. Polling is read-only; a lost POST is never resubmitted.
import { useEffect, useRef, useState } from "preact/hooks";
import { api, drafts, navigate, openSheet, store } from "./store.js";
import { html, Markdown } from "./ui.js";

// Legacy saved values contain only a UUID. New values bind the operation as well.
const identity = (value) => {
    const [operation, requestId] = value.includes(":") ? value.split(":") : ["submit", value];

    return { operation, requestId };
};

const lookup = (id, value) => {
    const { operation, requestId } = identity(value);

    return api(
        `c/${id}/kernel-request?operation=${encodeURIComponent(operation)}&requestId=${encodeURIComponent(requestId)}`,
    );
};

export function KernelConversation({ id }) {
    const me = store.state.me;
    const draftKey = `kernel.${me.id}.${id}`;
    const pendingKey = `rotom.kernel.pending.${me.id}.${id}`;
    const [text, setText] = useState(() => drafts.get(draftKey));
    const [view, setView] = useState(null);
    const [error, setError] = useState("");
    const pending = useRef(localStorage.getItem(pendingKey));
    const [waiting, setWaiting] = useState(Boolean(pending.current));
    const [stopping, setStopping] = useState(false);
    const [prepared, setPrepared] = useState(null);
    const refresh = useRef(null);

    useEffect(() => {
        let disposed = false,
            timer;

        const load = async () => {
            clearTimeout(timer);

            try {
                const next = await api(`c/${id}/kernel`);

                if (disposed) {
                    return;
                }

                setView(next);
                const saved = pending.current;
                const result = saved ? await lookup(id, saved) : null;

                if (disposed || pending.current !== saved) {
                    return;
                }

                setPrepared(result?.preparedOnly === true ? saved : null);
                const receipt = result?.receipt;
                const operation = saved ? identity(saved).operation : null;

                if (receipt && ["settled", "handled", "rejected"].includes(receipt.status)) {
                    localStorage.removeItem(pendingKey);
                    pending.current = null;
                    setWaiting(false);

                    if (receipt.status !== "rejected" && operation === "submit") {
                        drafts.set(draftKey, "");
                        setText("");
                    }

                    setError(
                        receipt.status === "rejected"
                            ? "Request rejected. Nothing will be resent automatically."
                            : "",
                    );

                    if (operation === "fork" && receipt.status === "settled") {
                        navigate(result.targetId);
                    }
                }

                if (receipt?.status === "unknown") {
                    setError(
                        "Recorded outcome is unknown. No automatic replay; operator reconciliation is required.",
                    );
                } else if (
                    ["fork", "configuration"].includes(operation) &&
                    result.targetId !== null &&
                    !receipt
                ) {
                    setError(
                        result.preparedOnly
                            ? `${operation} was prepared, but native dispatch did not begin in the current journal. You may dismiss this pending request; its server record will remain and will never be retried automatically.`
                            : `${operation} for session ${result.targetId} is recorded; completion is not yet confirmed. Readback only, no automatic replay.`,
                    );
                }

                if (!next.streaming) {
                    setStopping(false);
                }
            } catch (failure) {
                if (disposed) {
                    return;
                }

                setPrepared(null);

                if ([401, 403, 404].includes(failure.status)) {
                    setView(null);
                }

                setError(failure.message);
            } finally {
                if (!disposed) {
                    timer = setTimeout(load, 1500);
                }
            }
        };

        refresh.current = load;
        void load();

        return () => {
            disposed = true;
            clearTimeout(timer);
            refresh.current = null;
        };
    }, [id, me.id]);

    const dismissPrepared = async () => {
        const saved = pending.current;

        if (!saved || prepared !== saved) {
            return;
        }

        try {
            const result = await lookup(id, saved);

            if (pending.current !== saved) {
                return;
            }

            if (result.preparedOnly !== true) {
                setPrepared(null);
                await refresh.current?.();

                return;
            }

            localStorage.removeItem(pendingKey);
            pending.current = null;
            setPrepared(null);
            setWaiting(false);
            setError(
                "Unexecuted pending request dismissed. Its server record and draft are retained; nothing was replayed.",
            );
        } catch (failure) {
            setPrepared(null);
            setError(failure.message);
        }
    };

    const unknown = view?.receipts.some((receipt) => receipt.status === "unknown");
    const running =
        view?.streaming || view?.receipts.some((receipt) => receipt.status === "dispatch-intent");
    const own = view?.memberId === me.id && me.role !== "viewer";
    const blocked = !view || view.initializing || waiting || running || unknown;

    const dispatch = async (operation) => {
        if (me.role === "viewer" || blocked || pending.current) {
            return;
        }

        if (["submit", "compact", "configuration"].includes(operation) && !own) {
            return;
        }

        if (operation === "submit" && !text.trim()) {
            return;
        }

        const requestId = crypto.randomUUID();
        const saved = `${operation}:${requestId}`;

        try {
            // Persist identity before dispatch. A reload can only reconcile this key by GET, never allocate/replay a replacement.
            localStorage.setItem(pendingKey, saved);
            pending.current = saved;
            setWaiting(true);
            setError("");
            await api(`c/${id}/${operation}`, {
                requestId,
                ...(operation === "submit"
                    ? { text }
                    : operation === "compact"
                      ? {}
                      : {
                            expectedHead: view.segmentId,
                            ...(operation === "configuration" ? { activate: "mine" } : {}),
                        }),
            });
            await refresh.current?.();
        } catch (failure) {
            if (pending.current !== saved) {
                return;
            }

            if ([400, 401, 403, 404, 409, 413, 422].includes(failure.status)) {
                // Fork may have allocated its target before an admission failure. Reconcile, never resend it.
                try {
                    const result = await lookup(id, saved);

                    if (
                        !result.receipt &&
                        (!["fork", "configuration"].includes(operation) || result.targetId === null)
                    ) {
                        localStorage.removeItem(pendingKey);
                        pending.current = null;
                        setWaiting(false);
                    }
                } catch {
                    // Readback unavailable: keep the original identity, including across reloads.
                }

                setError(failure.message);
            } else {
                setError(
                    `${failure.message} Request outcome is unconfirmed; do not resend. Refresh receipts or ask the operator to reconcile.`,
                );
            }

            await refresh.current?.();
        }
    };

    const submit = (event) => {
        event.preventDefault();
        void dispatch("submit");
    };

    const stop = async () => {
        setStopping(true);

        try {
            await api(`c/${id}/abort`, {});
            await refresh.current?.();
        } catch (failure) {
            setError(
                `${failure.message} Stop outcome is unknown; do not assume tools rolled back.`,
            );
        }
    };

    return html`<div class="scroller"><div class="transcript">
        <section class="assistant" aria-label="Execution details">
            <strong>rotom · experimental</strong>
            <p class="muted">Current account: ${store.state.users.find((user) => user.id === view?.memberId)?.name ?? view?.memberId ?? "loading"} · ${view?.model ?? "…"}. Frozen configuration. Cost unknown.</p>
            <details class="muted">
                <summary>Execution rules</summary>
                <p>Handoff uses your selected account. Fork copies public context and frozen configuration; old usage stays with its payer. Compact calls the current account. Results appear after durable readback, not as a live stream.</p>
            </details>
            <div class="composer-row" style="flex-wrap: wrap" aria-label="Native session actions">
                <button
                    class="button" type="button"
                    disabled=${blocked || me.role === "viewer"}
                    onClick=${() => dispatch("handoff")}
                >Use my account</button>
                <button
                    class="button" type="button"
                    disabled=${blocked || me.role === "viewer" || Array.isArray(me.sessions)}
                    onClick=${() => dispatch("fork")}
                >Fork</button>
                <button
                    class="button" type="button"
                    disabled=${blocked || !own}
                    onClick=${() => dispatch("compact")}
                >Compact</button>
                <button
                    class="button" type="button"
                    onClick=${() => openSheet({ type: "profile" })}
                >Configuration & skills</button>
                <button
                    class="button" type="button"
                    disabled=${blocked || !own}
                    onClick=${() => dispatch("configuration")}
                >Activate saved profile</button>
            </div>
        </section>
        ${
            view?.credits?.length > 0 &&
            html`<details><summary>Qoder credits · reported subtotals</summary>
            <p class="muted">Partial, billable-reported credits by execution segment. Not USD or a complete account ledger.</p>
            ${view.credits.map((row) => html`<p class="user-text mono">${store.state.users.find((user) => user.id === row.memberId)?.name ?? row.memberId} · ${row.credits === null ? "Cr unknown" : `${row.credits.toFixed(3)} Cr`} · ${row.reported} reported · ${row.unknown} unknown observations · ${row.unmeteredOperations} unmetered operations · segment ${row.segmentId}</p>`)}
        </details>`
        }
        ${error && html`<p role="alert">${error}</p>`}
        ${
            prepared &&
            !running &&
            !unknown &&
            html`<button
            class="button"
            type="button"
            onClick=${dismissPrepared}
        >Dismiss unexecuted pending request</button>`
        }
        ${unknown && html`<p role="status">Outcome unknown. This account is fenced; no automatic replay.</p>`}
        ${view?.initializing && html`<p role="status">Initialization is incomplete. An operator must reconcile the recorded setup; no automatic seed or model request will run.</p>`}
        ${view?.messages.map((message, index) => {
            const content =
                typeof message.content === "string"
                    ? [{ type: "text", text: message.content }]
                    : (message.content ?? []);
            const text = content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n");

            if (message.role === "user") {
                return html`<div key=${index} class="user-row"><div class="bubble"><div class="user-text">${text}</div></div></div>`;
            }

            if (message.role === "toolResult") {
                return html`<details key=${index}><summary>${message.toolName ?? "Tool result"}${message.isError ? " · error" : ""}</summary><pre class="user-text">${text}</pre></details>`;
            }

            if (message.role !== "assistant") {
                return null;
            }

            return html`<article key=${index} class="assistant"><${Markdown} text=${text} />
                ${content.filter((part) => part.type === "toolCall").map((part) => html`<details><summary>Tool · ${part.name}</summary><pre class="user-text">${JSON.stringify(part.arguments, null, 2)}</pre></details>`)}
                ${["error", "aborted", "length"].includes(message.stopReason) && html`<p class="muted">Model ended: ${message.stopReason}. Settled does not mean the task succeeded.</p>`}
            </article>`;
        })}
        ${view?.receipts.length > 0 && html`<details><summary>Execution receipts · latest ${view.receipts.length}</summary>${view.receipts.map((receipt) => html`<p class="user-text mono">${receipt.operation} · ${receipt.status} · ${store.state.users.find((user) => user.id === receipt.memberId)?.name ?? receipt.memberId} · ${receipt.requestId}</p>`)}</details>`}
        ${running && html`<p role="status">Executing with the fixed account. Waiting for durable results…</p>`}
        ${waiting && !running && !unknown && html`<p role="status">Checking the saved request identity. No automatic resend.</p>`}
        ${view && !view.messages.length && !running && html`<div class="empty">No native messages yet.</div>`}
    </div></div>
    <div class="composer-wrap"><form class="composer" onSubmit=${submit}>
        <textarea aria-label="Message to rotom" placeholder=${own ? "Send to your pinned rotom kernel…" : "Read-only: another member owns this execution"} value=${text} disabled=${!own || blocked} onInput=${(
            event,
        ) => {
            setText(event.currentTarget.value);
            drafts.set(draftKey, event.currentTarget.value);
        }} />
        <div class="composer-row">
            <button class="button" type="button" aria-label="Refresh receipts" onClick=${() => refresh.current?.()}>Refresh</button>
            <span class="grow muted">Reasoning: ${view?.thinkingLevel ?? "unknown"}</span>
            ${running && me.role !== "viewer" ? html`<button class="button" type="button" disabled=${stopping} onClick=${stop}>${stopping ? "Stopping…" : "Stop"}</button>` : html`<button class="button primary" type="submit" disabled=${!own || !text.trim() || blocked}>Send</button>`}
        </div>
    </form></div>`;
}
