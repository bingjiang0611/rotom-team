// What a rotom session shows above its composer: questions its run asks, and an operation whose outcome is unknown.
import { useState } from "preact/hooks";
import { actions, api, attempt, store } from "./store.js";
import { html } from "./ui.js";

/** Send one answer; the room update that follows removes the question. */
function reply(dialog, answer) {
    void attempt(() => api(`c/${store.state.conversationId}/dialog`, { id: dialog.id, ...answer }));
}

/** One question from the running prompt, such as ask_user_question's choices. Only its payer answers it. */
function Question({ dialog, yours, memberName }) {
    const [text, setText] = useState(dialog.prefill ?? "");

    if (!yours) {
        return html`<div class="native-banner" role="status">
            Pi is waiting for ${memberName} to answer: ${dialog.title.split("\n")[0]}
        </div>`;
    }

    return html`<div class="native-banner native-question" role="dialog" aria-label="Pi asks">
        <div class="native-question-title">${dialog.title}</div>
        ${dialog.message && html`<div class="muted">${dialog.message}</div>`}
        ${
            dialog.method === "select" &&
            html`<div class="native-question-options">
                ${dialog.options?.map(
                    (option) =>
                        html`<button class="button" onClick=${() => reply(dialog, { value: option })}>
                            ${option}
                        </button>`,
                )}
            </div>`
        }
        ${
            dialog.method === "confirm" &&
            html`<div class="native-question-options">
                <button class="button primary" onClick=${() => reply(dialog, { confirmed: true })}>
                    Yes
                </button>
                <button class="button" onClick=${() => reply(dialog, { confirmed: false })}>No</button>
            </div>`
        }
        ${
            (dialog.method === "input" || dialog.method === "editor") &&
            html`<form
                onSubmit=${(event) => {
                    event.preventDefault();
                    reply(dialog, { value: text });
                }}
            >
                <textarea
                    rows=${dialog.method === "editor" ? 8 : 2}
                    placeholder=${dialog.placeholder ?? ""}
                    value=${text}
                    onInput=${(event) => setText(event.currentTarget.value)}
                />
                <button class="button primary" type="submit">Answer</button>
            </form>`
        }
        <button class="link small" onClick=${() => reply(dialog, { cancelled: true })}>
            Dismiss
        </button>
    </div>`;
}

/**
 * Above the composer of a rotom session. A run cut off by a server stop has an unknown outcome: it may have changed
 * files or spent quota, so it is never resent by itself.
 */
export function NativeBanner() {
    const kernel = store.state.view.kernel;
    const dialog = kernel?.dialogs?.[0];
    const pending = kernel?.pending;

    if (dialog) {
        return html`<${Question}
            key=${dialog.id}
            dialog=${dialog}
            yours=${kernel.yours}
            memberName=${kernel.memberName}
        />`;
    }

    if (kernel?.cutOff && !store.state.view.live?.busy) {
        return html`<div class="native-banner" role="status">
            A server restart cut Pi off, and it did not continue by itself.
            <button
                class="button small"
                onClick=${() =>
                    attempt(() =>
                        actions.submit(
                            "Continue the interrupted task from where it stopped. Do not repeat finished steps.",
                            [],
                            "followUp",
                        ),
                    )}
            >
                Continue
            </button>
        </div>`;
    }

    if (!pending || pending.status !== "unknown") {
        return null;
    }

    return html`<div class="native-banner" role="status">
        The last ${pending.operation === "prompt" ? "run" : pending.operation} stopped with an unknown
        outcome. It is not sent again by itself.
    </div>`;
}
