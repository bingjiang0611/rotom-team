import { useEffect, useState } from "preact/hooks";
import { api, closeSheet, store } from "../store.js";
import { html, Loader, Sheet } from "../ui.js";

export function ProjectsSheet() {
    const [projects, setProjects] = useState(null);
    const [draft, setDraft] = useState(null);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const owner = store.state.me?.role === "owner";
    const people = store.state.users ?? [];

    useEffect(() => {
        api("projects")
            .then(setProjects)
            .catch((e) => setError(e.message));
    }, []);

    const grant = (id, action, enabled) => {
        const rights = {
            view: false,
            continue: false,
            fork: false,
            ...draft.members[id],
            [action]: enabled,
        };

        if (enabled && action !== "view") {
            rights.view = true;
        }

        if (!rights.view) {
            rights.continue = false;
            rights.fork = false;
        }

        setDraft({ ...draft, members: { ...draft.members, [id]: rights } });
    };

    const save = async (event) => {
        event.preventDefault();
        setBusy(true);
        setError("");

        try {
            await api("projects", draft);
            setProjects(await api("projects"));
            setDraft(null);
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
        }
    };

    return html`<${Sheet} title="Projects & access" onClose=${closeSheet}>
        <p>Project grants control shared sessions, not OS access. Native execution is for trusted teammates. Existing unassigned sessions keep their current sharing.</p>
        ${error && html`<p role="alert">${error}</p>`}
        ${!projects && !error && html`<${Loader} label="Loading projects" />`}
        ${projects?.length === 0 && html`<p>No projects yet.</p>`}
        ${projects?.map((project) => html`<div class="list-item"><span>${project.name}<br /><span class="muted">${project.cwd}</span></span>${owner && html`<button class="button small" onClick=${() => setDraft(project)}>Edit access</button>`}</div>`)}
        ${owner && !draft && html`<button class="button" onClick=${() => setDraft({ name: "", cwd: store.state.server?.defaultCwd ?? "", members: {} })}>New project</button>`}
        ${
            draft &&
            html`<form onSubmit=${save}>
            <label class="field">Name<input required maxlength="100" value=${draft.name} disabled=${busy} onInput=${(event) => setDraft({ ...draft, name: event.currentTarget.value })} /></label>
            <label class="field">Project directory<input required value=${draft.cwd} disabled=${busy || !!draft.id} onInput=${(event) => setDraft({ ...draft, cwd: event.currentTarget.value })} /></label>
            <div class="group"><div class="group-title">Member grants</div>
                ${people.filter((person) => person.role !== "owner").map((person) => html`<div class="group"><strong>${person.name}</strong>${["view", "continue", "fork"].map((action) => html`<label><input type="checkbox" checked=${draft.members[person.id]?.[action] ?? false} disabled=${busy} onChange=${(event) => grant(person.id, action, event.currentTarget.checked)} /> ${action}</label>`)}</div>`)}
            </div>
            <p class="muted">Revoking access removes live views and stops that member's active execution. Already dispatched provider usage cannot be undone.</p>
            <button class="button primary" type="submit" disabled=${busy}>${busy ? "Saving…" : "Save project"}</button>
            <button class="button" type="button" disabled=${busy} onClick=${() => setDraft(null)}>Cancel</button>
        </form>`
        }
    <//>`;
}
