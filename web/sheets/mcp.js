// The project's MCP servers as your runs reach them, and signing in to those that use OAuth with your own account.
import { useEffect, useState } from "preact/hooks";
import { api, closeSheet, store } from "../store.js";
import { html, Loader, Sheet } from "../ui.js";

const STATES = { connected: "connected", "needs-auth": "needs your sign-in", failed: "failed" };

/** One server: its state for you, and Sign in or Sign out where it uses OAuth. */
function Server({ server, busy, onSignIn, onSignOut }) {
    const tools = server.state === "connected" ? ` · ${server.tools.length} tools` : "";
    const label = `${STATES[server.state] ?? server.state}${tools}`;
    const problem = server.state === "failed" ? server.error : "";
    const action =
        server.state === "needs-auth"
            ? html`<button class="button small" disabled=${busy} onClick=${onSignIn}>Sign in</button>`
            : server.state === "connected" && /^https?:/.test(server.transport)
              ? html`<button class="link small" disabled=${busy} onClick=${onSignOut}>Sign out</button>`
              : null;

    return html`<li>
        <strong>${server.name}</strong> <span class="muted">${label}</span> ${action}
        ${problem && html`<div class="muted">${problem}</div>`}
    </li>`;
}

export function McpSheet() {
    const id = store.state.conversationId;
    const [report, setReport] = useState(null);
    const [signIn, setSignIn] = useState(store.state.sheet?.signIn ?? null);
    const [pasted, setPasted] = useState("");
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState(store.state.sheet?.message ?? "");
    const [error, setError] = useState("");

    const load = () =>
        api(`c/${id}/mcp`)
            .then(setReport)
            .catch((e) => setError(e.message));

    useEffect(() => void load(), [id]);

    const act = async (action, body) => {
        setBusy(true);
        setError("");
        setMessage("");

        try {
            const result = await api(`c/${id}/mcp/${action}`, body);

            if (result.status === "open") {
                setSignIn({ ...result, server: body.server ?? signIn?.server });
                setPasted("");
            } else {
                setSignIn(null);
                (result.status === "failed" ? setError : setMessage)(result.message);
                await load();
            }
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
        }
    };

    return html`<${Sheet} title="MCP sign-ins" onClose=${closeSheet}>
        <p>
            The shared Team agent's MCP servers, as your runs reach them. A server that uses OAuth needs your own
            sign-in: only your runs use it.
        </p>
        ${error && html`<p role="alert">${error}</p>`}
        ${message && html`<p role="status">${message}</p>`}
        ${!report && !error && html`<${Loader} label="Checking the shared agent's MCP servers" />`}
        ${
            signIn &&
            html`<form
                class="stack"
                onSubmit=${(event) => {
                    event.preventDefault();
                    void act("finish", { url: pasted });
                }}
            >
                <p>1. Open the sign-in page and approve:</p>
                <p>
                    <a href=${signIn.url} target="_blank" rel="noopener noreferrer">${signIn.server}</a>
                </p>
                <label class="field">
                    2. Your browser then ends on a page that does not load. Paste its address (it starts
                    with ${signIn.callback}):
                    <input
                        value=${pasted}
                        placeholder=${`${signIn.callback}?code=…`}
                        disabled=${busy}
                        onInput=${(event) => setPasted(event.currentTarget.value)}
                    />
                </label>
                <p class="muted">On the server's own computer the page loads; leave this empty.</p>
                <button class="button primary" type="submit" disabled=${busy}>Finish sign-in</button>
            </form>`
        }
        ${
            report &&
            html`<ul class="list">
                ${report.servers.map(
                    (server) =>
                        html`<${Server}
                            server=${server}
                            busy=${busy}
                            onSignIn=${() => act("login", { server: server.name })}
                            onSignOut=${() => act("logout", { server: server.name })}
                        />`,
                )}
                ${
                    report.servers.length === 0 &&
                    html`<li class="muted">The shared agent declares no MCP servers.</li>`
                }
            </ul>`
        }
        ${report?.errors.map((each) => html`<p role="alert">${each}</p>`)}
    <//>`;
}
