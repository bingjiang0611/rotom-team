// Model providers: signing in and out, and the dialog a sign-in uses to ask for a code or a key.
import { useEffect, useState } from "preact/hooks";
import { api, attempt, closeSheet, store } from "../store.js";
import { html, Icon, Loader, Sheet } from "../ui.js";

export function ProvidersSheet() {
    const { me } = store.state;
    const [providers, setProviders] = useState(null);
    const [query, setQuery] = useState("");
    const load = () => attempt(async () => setProviders(await api("providers")));

    useEffect(() => {
        load();
    }, [store.state.models]);
    const owner = me?.role !== "viewer";
    const login = (provider, type) =>
        attempt(() => api(`providers/${encodeURIComponent(provider.id)}/login`, { type }));
    const logout = (provider) =>
        confirm(
            `Disconnect your ${provider.name} account? Other members' accounts are not changed.`,
        ) &&
        attempt(async () => {
            await api(`providers/${encodeURIComponent(provider.id)}/logout`, {});
            load();
        });
    const needle = query.trim().toLowerCase();
    const list = (providers ?? [])
        .filter(
            (provider) =>
                needle === "" || `${provider.id} ${provider.name}`.toLowerCase().includes(needle),
        )
        .sort(
            (a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name),
        );

    return html`<${Sheet} title="My model accounts" onClose=${closeSheet}>
        <p class="muted small">
            Signed in as ${me?.name}. Tasks you start use your own model account and quota. Viewing a shared session does not use a model. ${owner ? "" : "Your membership is view-only."}
        </p>
        <p class="muted small">
            Trusted-team alpha: credentials are stored on this server. Native tools share its operating-system permissions. Qoder is an unofficial integration; real subscription usage is not a dollar bill.
        </p>
        <label class="search">
            <${Icon} name="search" size=${16} />
            <input
                placeholder="Search providers"
                value=${query}
                onInput=${(event) => setQuery(event.currentTarget.value)}
            />
        </label>
        ${providers === null && html`<${Loader} label="Loading providers" />`}
        ${list.map(
            (provider) => html`<div class="provider">
                <div>
                    <div>
                        ${provider.name} ${provider.configured && html`<span class="ok">✓</span>`}
                    </div>
                    <div class="muted small">
                        ${provider.configured ? `signed in${provider.label ? ` · ${provider.label}` : provider.source ? ` · ${provider.source}` : ""}` : "not configured"} · ${provider.models} models
                    </div>
                    ${provider.catalogError && html`<p role="alert">Account model catalog unavailable. No static catalog or other account is substituted. Check the service or reconnect independently.</p>`}
                </div>
                ${
                    owner &&
                    html`<div class="provider-actions">
                        ${
                            provider.oauth &&
                            html`<button
                                class="button small"
                                onClick=${() => login(provider, "oauth")}
                            >
                                ${provider.oauth}
                            </button>`
                        }
                        ${
                            provider.apiKey &&
                            html`<button
                                class="button small"
                                onClick=${() => login(provider, "api_key")}
                            >
                                API key
                            </button>`
                        }
                        ${
                            provider.configured &&
                            html`<button
                                class="button small ghost"
                                onClick=${() => logout(provider)}
                            >
                                Log out
                            </button>`
                        }
                    </div>`
                }
            </div>`,
        )}
    <//>`;
}

export function AuthDialog() {
    const { auth } = store.state;
    const [value, setValue] = useState("");

    if (!auth) {
        return null;
    }

    const answer = (payload) =>
        attempt(async () => {
            await api(`auth/${auth.flowId}/${auth.prompt.id}`, payload);
            setValue("");
            // A following prompt may arrive over SSE before this HTTP answer completes.
            store.set((state) =>
                state.auth?.flowId === auth.flowId && state.auth.prompt?.id === auth.prompt.id
                    ? { auth: { ...state.auth, prompt: null } }
                    : {},
            );
        });

    const close = () => {
        // Stop the sign-in on the server too, also while it waits without a question (an OAuth callback holds a port).
        if (!auth.done) {
            api(`auth/${encodeURIComponent(auth.flowId)}/cancel`, {}).catch(() => {});
        }

        store.set({ auth: null, dismissedAuthFlowId: auth.flowId });
    };

    const prompt = auth.prompt;

    return html`<${Sheet} title=${`Sign in: ${auth.providerId}`} onClose=${close}>
        ${
            !auth.done &&
            auth.events.map((event) => {
                if (event.type === "auth_url") {
                    return html`<div class="auth-event">
                    <a class="button primary wide" href=${event.url} target="_blank" rel="noopener">
                        Open the sign-in page
                    </a>
                    ${event.instructions && html`<p class="muted small">${event.instructions}</p>`}
                </div>`;
                }

                if (event.type === "device_code") {
                    return html`<div class="auth-event">
                    <p>
                        Enter this code at <a href=${event.verificationUri} target="_blank" rel="noopener">${event.verificationUri}</a>
                    </p>
                    <div class="code-big">${event.userCode}</div>
                </div>`;
                }

                return html`<p class="muted small">
                ${event.message}
                ${event.links?.map(
                    (link) => html` <a href=${link.url} target="_blank" rel="noopener">
     ${link.label ?? link.url}
 </a>`,
                )}
            </p>`;
            })
        }
        ${
            prompt &&
            (prompt.type === "select"
                ? html`<div class="field">
                    <div class="label">${prompt.message}</div>
                    ${prompt.options.map(
                        (option) =>
                            html`<button
                                class="list-item"
                                onClick=${() => answer({ value: option.id })}
                            >
                                <span>${option.label}</span>
                                <span class="muted small">${option.description ?? ""}</span>
                            </button>`,
                    )}
                </div>`
                : html`<div class="field">
                    <div class="label">${prompt.message}</div>
                    ${
                        prompt.type === "manual_code" &&
                        html`<p class="muted small">On a different computer from the team server? After you approve, the browser ends on a page that cannot be reached. That is expected: copy that page's full address from the address bar and paste it here. It works once, for this sign-in only.</p>`
                    }
                    <div class="row">
                        <input
                            type=${prompt.type === "secret" ? "password" : "text"}
                            autocomplete="off"
                            placeholder=${prompt.placeholder ?? ""}
                            value=${value}
                            onInput=${(event) => setValue(event.currentTarget.value)}
                            onKeyDown=${(event) => event.key === "Enter" && answer({ value })}
                        />
                        <button class="button primary" onClick=${() => answer({ value })}>
                            Continue
                        </button>
                    </div>
                </div>`)
        }
        ${!prompt && !auth.done && html`<${Loader} label="Waiting for the provider" />`}
        ${auth.done && !auth.done.ok && html`<div class="error-box">${auth.done.error}</div>`}
        ${auth.done && html`<button class="button wide" onClick=${close}>Close</button>`}
    <//>`;
}
