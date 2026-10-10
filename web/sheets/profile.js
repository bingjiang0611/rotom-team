import { useEffect, useState } from "preact/hooks";
import { api, closeSheet, store, notify } from "../store.js";
import { html, Loader, Sheet } from "../ui.js";

/** Personal drafts stay private; only explicitly activated snapshots enter shared sessions. */
export function ProfileSheet() {
    const [profile, setProfile] = useState(null);
    const [snapshot, setSnapshot] = useState(null);
    const [devices, setDevices] = useState([]);
    const [deviceLink, setDeviceLink] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const id = store.state.conversationId;
    const editable = store.state.me?.role !== "viewer";
    const native = store.state.sessions.some(
        (session) => session.id === id && session.backend === "rotom",
    );

    useEffect(() => {
        Promise.all([
            api("profile"),
            id ? api(`c/${id}/configuration`) : Promise.resolve(null),
            api("devices"),
        ])
            .then(([p, s, d]) => {
                setDevices(d);
                setProfile(p);
                setSnapshot(s);
            })
            .catch((e) => setError(e.message));
    }, [id]);
    const change = (field, value) => setProfile({ ...profile, [field]: value });

    const save = async (activate) => {
        setBusy(true);
        setError("");

        try {
            setProfile(await api("profile", profile));

            if (activate) {
                setSnapshot(await api(`c/${id}/configuration`, { activate: "mine" }));
            }

            notify(
                "info",
                activate
                    ? "Configuration activated for this shared session."
                    : "Personal profile saved. Existing sessions are unchanged.",
            );
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
        }
    };

    return html`<${Sheet} title="Configuration & skills" onClose=${closeSheet}>
        <p>Your draft belongs to you. New sessions freeze it with project rules. Taking over preserves the existing snapshot.</p>
        ${error && html`<p role="alert">${error}</p>`}
        ${!profile && !error && html`<${Loader} label="Loading configuration" />`}
        ${
            profile &&
            html`<form onSubmit=${(event) => {
                event.preventDefault();
                void save(false);
            }}>
            <label class="field">Profile name
                <input value=${profile.name} maxlength="80" required disabled=${!editable || busy} onInput=${(event) => change("name", event.currentTarget.value)} />
            </label>
            <label class="field">Personal instructions / AGENTS.md
                <textarea rows="8" maxlength="16000" value=${profile.instructions} disabled=${!editable || busy} onInput=${(event) => change("instructions", event.currentTarget.value)} />
            </label>
            <label class="field">Skill directories on this server — one per line
                <textarea rows="4" value=${profile.skillDirectories.join("\n")} disabled=${!editable || busy} onInput=${(
                    event,
                ) =>
                    change(
                        "skillDirectories",
                        event.currentTarget.value
                            .split("\n")
                            .map((path) => path.trim())
                            .filter(Boolean),
                    )} />
            </label>
            <p class="muted">Each directory needs SKILL.md. References and scripts are copied into the snapshot; duplicate names and symlinks are rejected. An activated profile is readable by everyone with session access.</p>
            <button class="button primary" type="submit" disabled=${!editable || busy}>${busy ? "Saving…" : "Save my profile"}</button>
        </form>`
        }
        ${
            id &&
            html`<div class="group">
            <div class="group-title">This session</div>
            ${snapshot ? html`<p>${snapshot.name} · <code>${snapshot.digest.slice(0, 12)}</code></p><details><summary>Inspect active configuration</summary><pre>${snapshot.context}</pre><ul>${snapshot.skills.map((skill) => html`<li>${skill.name} — ${skill.description}</li>`)}</ul></details>` : html`<p>Legacy session: resources have not been frozen yet.</p>`}
            ${
                native
                    ? html`<p class="muted">Save your profile here, then use “Activate saved profile” in the native conversation. Activation creates a new execution segment and is recorded before dispatch.</p>`
                    : html`<button class="button" disabled=${!editable || !profile || busy} onClick=${() => {
                          if (
                              confirm(
                                  "Save and activate your configuration in this shared session? Everyone with access can read it. This is an explicit version change; taking over does not change it automatically.",
                              )
                          ) {
                              void save(true);
                          }
                      }}>Save & activate in this session</button>`
            }
        </div>`
        }
        <div class="group">
            <div class="group-title">My browser sign-ins</div>
            <p>Use the same member and model accounts on another browser. These are browser credentials, not remote execution workers. Keep links private; revoking a sign-in reconnects your open tabs. Maximum 32 additional sign-ins.</p>
            <button class="button" disabled=${busy || devices.length >= 32} onClick=${async () => {
                setBusy(true);
                setError("");

                try {
                    const result = await api("devices", {});

                    setDeviceLink(
                        `${location.origin}/login?token=${encodeURIComponent(result.token)}`,
                    );
                    setDevices(await api("devices"));
                } catch (e) {
                    setError(e.message);
                } finally {
                    setBusy(false);
                }
            }}>Create my private sign-in link</button>
            ${deviceLink && html`<p role="status">Copy privately to your browser. This bearer link grants your current access.</p><input readonly value=${deviceLink} aria-label="Private browser sign-in link" onClick=${(event) => event.currentTarget.select()} />`}
            <ul>${devices.map(
                (device) =>
                    html`<li>${new Date(device.createdAt).toLocaleString()} <button class="button" disabled=${busy} onClick=${async () => {
                        if (
                            !confirm("Revoke this browser sign-in? Your open tabs will reconnect.")
                        ) {
                            return;
                        }

                        setBusy(true);
                        setError("");

                        try {
                            await api(`devices/${device.id}`, undefined, { method: "DELETE" });
                            setDeviceLink("");
                            setDevices(await api("devices"));
                        } catch (e) {
                            setError(e.message);
                        } finally {
                            setBusy(false);
                        }
                    }}>Revoke</button></li>`,
            )}</ul>
        </div>
    <//>`;
}
