import { useEffect, useState } from "preact/hooks";
import { api, closeSheet, store, notify } from "../store.js";
import { html, Loader, Sheet } from "../ui.js";

/** The files of one picked skill folder, as the server takes them: relative path → base64. */
async function skillFiles(list) {
    const files = {};
    let name = "";

    for (const file of list) {
        const [top, ...rest] = file.webkitRelativePath.split("/");

        name = top;
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = "";

        for (let index = 0; index < bytes.length; index += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
        }

        files[rest.join("/")] = { base64: btoa(binary) };
    }

    return { name, files };
}

/**
 * The member's personal rotom layer: their AGENTS.md, skills and MCP servers, private to them. Each run they pay for
 * loads it next to the project's own AGENTS.md and skills, whoever started the session.
 */
function PersonalLayer({ editable }) {
    const [layer, setLayer] = useState(null);
    const [instructions, setInstructions] = useState("");
    const [mcp, setMcp] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        api("kernel-profile")
            .then((value) => {
                setLayer(value);
                setInstructions(value.instructions);
                setMcp(value.mcp);
            })
            .catch((e) => setError(e.message));
    }, []);

    const run = async (work, done) => {
        setBusy(true);
        setError("");

        try {
            setLayer(await work());
            notify("info", done);
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
        }
    };

    return html`<div class="group">
        <div class="group-title">My instructions & skills</div>
        <p>
            Private to you. Every run on your account loads them with the project's own AGENTS.md
            and skills, in your sessions and in ones you continue or fork.
        </p>
        ${error && html`<p role="alert">${error}</p>`}
        ${!layer && !error && html`<${Loader} label="Loading your instructions" />`}
        ${
            layer &&
            html`<form
                onSubmit=${(event) => {
                    event.preventDefault();
                    void run(
                        () => api("kernel-profile", { instructions, mcp }),
                        "Saved. Your next run uses it.",
                    );
                }}
            >
                <label class="field">
                    My AGENTS.md
                    <textarea
                        rows="8"
                        maxlength="65536"
                        value=${instructions}
                        disabled=${!editable || busy}
                        onInput=${(event) => setInstructions(event.currentTarget.value)}
                    />
                </label>
                <label class="field">
                    My MCP servers (mcp.json)
                    <textarea
                        rows="6"
                        maxlength="65536"
                        spellcheck="false"
                        placeholder='{ "mcpServers": { "name": { "command": "…" } } }'
                        value=${mcp}
                        disabled=${!editable || busy}
                        onInput=${(event) => setMcp(event.currentTarget.value)}
                    />
                </label>
                <p class="muted small">
                    Commands run on the server. \${NAME} values do not see the server's environment,
                    so write tokens in place. Sign-in (OAuth) servers are not supported.
                </p>
                <button class="button primary" type="submit" disabled=${!editable || busy}>
                    ${busy ? "Saving…" : "Save"}
                </button>
            </form>
            <ul>
                ${layer.skills.map(
                    (skill) =>
                        html`<li>
                            <strong>${skill.name}</strong> — ${skill.description}
                            <span class="muted small"> · ${skill.files} files</span>
                            <button
                                class="button small"
                                disabled=${!editable || busy}
                                onClick=${() => {
                                    if (confirm(`Remove your skill ${skill.name}?`)) {
                                        void run(
                                            () =>
                                                api(
                                                    `kernel-profile/skills/${skill.name}`,
                                                    undefined,
                                                    {
                                                        method: "DELETE",
                                                    },
                                                ),
                                            "Skill removed.",
                                        );
                                    }
                                }}
                            >
                                Remove
                            </button>
                        </li>`,
                )}
            </ul>
            <label class="field">
                Add or replace a skill: pick its folder (it needs SKILL.md)
                <input
                    type="file"
                    webkitdirectory
                    disabled=${!editable || busy}
                    onChange=${(event) => {
                        const list = [...event.currentTarget.files];

                        event.currentTarget.value = "";

                        if (list.length > 0) {
                            void run(async () => {
                                const { name, files } = await skillFiles(list);

                                return api(
                                    `kernel-profile/skills/${encodeURIComponent(name)}`,
                                    { files },
                                    {
                                        method: "PUT",
                                    },
                                );
                            }, "Skill saved. Your next run has it.");
                        }
                    }}
                />
            </label>`
        }
    </div>`;
}

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
    const native = Boolean(store.state.server?.kernel);

    useEffect(() => {
        Promise.all([api("profile"), api("devices")])
            .then(([p, d]) => {
                setDevices(d);
                setProfile(p);
            })
            .catch((e) => setError(e.message));
    }, [id]);

    useEffect(() => {
        const active = id && !native ? api(`c/${id}/configuration`) : Promise.resolve(null);

        active.then(setSnapshot).catch((e) => setError(e.message));
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

    return html`<${Sheet} title=${native ? "My instructions & skills" : "Configuration & skills"} onClose=${closeSheet}>
        ${native && html`<${PersonalLayer} editable=${editable} />`}
        ${!native && html`<p>Your draft belongs to you. New sessions freeze it with project rules. Taking over preserves the existing snapshot.</p>`}
        ${error && html`<p role="alert">${error}</p>`}
        ${!profile && !error && html`<${Loader} label="Loading configuration" />`}
        ${
            !native &&
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
            !native &&
            html`<div class="group">
            <div class="group-title">This session</div>
            ${snapshot ? html`<p>${snapshot.name} · <code>${snapshot.digest.slice(0, 12)}</code></p><details><summary>Inspect active configuration</summary><pre>${snapshot.context}</pre><ul>${snapshot.skills.map((skill) => html`<li>${skill.name} — ${skill.description}</li>`)}</ul></details>` : html`<p>Legacy session: resources have not been frozen yet.</p>`}
            <button class="button" disabled=${!editable || !profile || busy} onClick=${() => {
                if (
                    confirm(
                        "Save and activate your configuration in this shared session? Everyone with access can read it. This is an explicit version change; taking over does not change it automatically.",
                    )
                ) {
                    void save(true);
                }
            }}>Save & activate in this session</button>
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
