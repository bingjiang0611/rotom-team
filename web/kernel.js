// Native conversations use their own receipts/transcript. Polling is read-only; a lost POST is never resubmitted.
import { useEffect, useRef, useState } from "preact/hooks";
import { api, drafts, store } from "./store.js";
import { html, Markdown } from "./ui.js";

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
                const receipt =
                    pending.current &&
                    next.receipts.find((row) => row.requestId === `${me.id}:${pending.current}`);

                if (receipt && ["settled", "handled", "rejected"].includes(receipt.status)) {
                    localStorage.removeItem(pendingKey);
                    pending.current = null;
                    setWaiting(false);

                    if (receipt.status !== "rejected") {
                        drafts.set(draftKey, "");
                        setText("");
                    }

                    setError(
                        receipt.status === "rejected"
                            ? "Request rejected. Nothing will be resent automatically."
                            : "",
                    );
                }

                if (!next.streaming) {
                    setStopping(false);
                }
            } catch (failure) {
                if (disposed) {
                    return;
                }

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

    const unknown = view?.receipts.some((receipt) => receipt.status === "unknown");
    const running =
        view?.streaming || view?.receipts.some((receipt) => receipt.status === "dispatch-intent");
    const own = view?.memberId === me.id && me.role !== "viewer";

    const submit = async (event) => {
        event.preventDefault();

        if (!own || !text.trim() || pending.current || waiting || running || unknown) {
            return;
        }

        const requestId = crypto.randomUUID();

        try {
            // Persist identity before dispatch. A reload can only reconcile this key by GET, never allocate/replay a replacement.
            localStorage.setItem(pendingKey, requestId);
            pending.current = requestId;
            setWaiting(true);
            setError("");
            await api(`c/${id}/submit`, { text, requestId });
            await refresh.current?.();
        } catch (failure) {
            if (pending.current !== requestId) {
                return;
            }

            if ([400, 401, 403, 404, 409, 413, 422].includes(failure.status)) {
                // Native endpoint returns these only before admission; execution/close failures are receipts or HTTP 500.
                localStorage.removeItem(pendingKey);
                pending.current = null;
                setWaiting(false);
                setError(failure.message);
            } else {
                setError(
                    `${failure.message} Request outcome is unconfirmed; do not resend. Refresh receipts or ask the operator to reconcile.`,
                );
            }

            await refresh.current?.();
        }
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
            <p class="muted">Fixed account: ${store.state.users.find((user) => user.id === view?.memberId)?.name ?? view?.memberId ?? "loading"} · ${view?.model ?? "…"}. Frozen configuration. Cost unknown.</p>
            <p class="muted">Text and native tools only. No Qoder, cross-account takeover, forks, attachments or compaction yet. Results appear after durable readback; this is not a live stream.</p>
        </section>
        ${error && html`<p role="alert">${error}</p>`}
        ${unknown && html`<p role="status">Outcome unknown. This account is fenced; no automatic replay.</p>`}
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
        ${view?.receipts.length > 0 && html`<details><summary>Execution receipts · latest ${view.receipts.length}</summary>${view.receipts.map((receipt) => html`<p class="user-text mono">${receipt.status} · ${receipt.requestId}</p>`)}</details>`}
        ${running && html`<p role="status">Executing with the fixed account. Waiting for durable results…</p>`}
        ${waiting && !running && !unknown && html`<p role="status">Checking the saved request identity. No automatic resend.</p>`}
        ${view && !view.messages.length && !running && html`<div class="empty">No native messages yet.</div>`}
    </div></div>
    <div class="composer-wrap"><form class="composer" onSubmit=${submit}>
        <textarea aria-label="Message to rotom" placeholder=${own ? "Send to your pinned rotom kernel…" : "Read-only: another member owns this execution"} value=${text} disabled=${!own || waiting || running || unknown} onInput=${(
            event,
        ) => {
            setText(event.currentTarget.value);
            drafts.set(draftKey, event.currentTarget.value);
        }} />
        <div class="composer-row">
            <button class="button" type="button" aria-label="Refresh receipts" onClick=${() => refresh.current?.()}>Refresh</button>
            <span class="grow muted">Reasoning: ${view?.thinkingLevel ?? "unknown"}</span>
            ${running && me.role !== "viewer" ? html`<button class="button" type="button" disabled=${stopping} onClick=${stop}>${stopping ? "Stopping…" : "Stop"}</button>` : html`<button class="button primary" type="submit" disabled=${!own || !text.trim() || waiting || unknown}>Send</button>`}
        </div>
    </form></div>`;
}
