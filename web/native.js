// What a rotom session shows above its composer: an operation whose outcome the server could not prove.
import { store } from "./store.js";
import { html } from "./ui.js";

/**
 * A rotom run cut off by a server stop has an unknown outcome: it may have changed files or spent quota. It is never
 * resent by itself; the person who sent it decides.
 */
export function NativeBanner() {
    const pending = store.state.view.kernel?.pending;

    if (!pending || pending.status !== "unknown") {
        return null;
    }

    return html`<div class="native-banner" role="status">
        The last ${pending.operation === "prompt" ? "run" : pending.operation} stopped with an unknown
        outcome. It is not sent again by itself.
    </div>`;
}
