// Agent resources: what a Team session loads from the shared profile and its folder, listed with each file's path. It
// only reads: the files are changed on the deployment machine.
import { useEffect, useState } from "preact/hooks";
import { api, closeSheet } from "../store.js";
import { html, Loader, Sheet } from "../ui.js";

const TABS = [
    ["instructions", "Instructions"],
    ["skills", "Skills"],
    ["extensions", "Extensions"],
    ["mcp", "MCP"],
];

/** The file's name, or its folder's for an `index.*` or `SKILL.md` entry. */
function label(path) {
    const parts = path.split("/");
    const file = parts.at(-1);

    return /^index\.[cm]?[jt]s$|^SKILL\.md$/.test(file) ? parts.at(-2) : file;
}

/** Past this many characters a description shows two lines until opened: some run to a thousand. */
const LONG = 160;

function Description({ text }) {
    const [open, setOpen] = useState(false);
    const long = text.length > LONG;

    return html`<span class=${`ar-sub ar-desc ${long && !open ? "clamped" : ""}`}>${text}</span>
        ${
            long &&
            html`<button
                class="link ar-more"
                aria-expanded=${open}
                onClick=${() => setOpen(!open)}
            >
                ${open ? "Show less" : "Show more"}
            </button>`
        }`;
}

const Tag = ({ kind = "", children }) => html`<span class=${`ar-tag ${kind}`}>${children}</span>`;

/** One resource: name, notes and its path, with tags at the end. Shared rows in a project's view are dashed. */
function Row({ name, description = "", off = false, inherited = false, notes = [], path, tags }) {
    return html`<div class=${`ar-row ${inherited ? "inherited" : ""} ${off ? "off" : ""}`}>
        <div class="ar-main">
            <strong>${name}</strong>
            ${description && html`<${Description} text=${description} />`}
            ${notes
                .filter(Boolean)
                .map(([text, kind = ""]) => html`<span class=${`ar-sub ${kind}`}>${text}</span>`)}
            <code class="ar-path">${path}</code>
        </div>
        <div class="ar-tags">${tags}</div>
    </div>`;
}

const scopeTag = (scope) => html`<${Tag} kind=${scope}>${scope}<//>`;

/** Where a skill or extension came from, when not simply found in its folder. */
function origin(resource) {
    if (resource.packageRoot) {
        return [`Package ${resource.source} · ${resource.packageRoot}`];
    }

    return resource.source === "local" ? ["Listed in settings.json"] : null;
}

function Instructions({ list }) {
    if (list.instructions.length === 0) {
        return html`<p class="muted">No AGENTS.md found.</p>`;
    }

    return html`<div class="ar-chain">
        ${list.instructions.map(
            (file, index) => html`${index > 0 && html`<div class="ar-then">↓ then</div>`}
                <${Row}
                    name=${label(file.path)}
                    path=${file.path}
                    inherited=${list.project && file.scope !== "project"}
                    tags=${scopeTag(file.scope)}
                />`,
        )}
    </div>`;
}

function Skills({ list }) {
    return html`${list.skillProblems.map((each) => html`<p class="ar-note warn">${each}</p>`)}
    ${list.skills.length === 0 && html`<p class="muted">No skills found.</p>`}
    ${list.skills.map(
        (skill) =>
            html`<${Row}
                name=${skill.name}
                off=${!skill.enabled}
                inherited=${list.project && skill.scope === "shared"}
                path=${skill.path}
                description=${skill.description}
                notes=${[
                    origin(skill),
                    skill.sameNameAs && [
                        `Not loaded: ${skill.sameNameAs} has the same name.`,
                        "warn",
                    ],
                ]}
                tags=${html`${scopeTag(skill.scope)}
                ${skill.sameNameAs && html`<${Tag} kind="warn">same name<//>`}
                ${!skill.enabled && !skill.sameNameAs && html`<${Tag}>disabled<//>`}`}
            />`,
    )}`;
}

/** Notes for an extension the product, Team or Pi adds to every session. */
function bundledNotes(extension) {
    return [
        extension.packages && [`Packages: ${extension.packages.join(", ")}`],
        extension.from === "pi" && ["Built into Pi: no file."],
    ];
}

function Extensions({ list }) {
    const none = list.project ? "No shared or project extensions." : "No shared extensions.";

    return html`${list.extensions.length === 0 && html`<p class="muted">${none}</p>`}
    ${list.extensions.map(
        (extension) =>
            html`<${Row}
                name=${label(extension.path)}
                off=${!extension.enabled}
                inherited=${list.project && extension.scope === "shared"}
                path=${extension.path}
                notes=${[origin(extension)]}
                tags=${html`${scopeTag(extension.scope)}
                ${!extension.enabled && html`<${Tag}>disabled<//>`}`}
            />`,
    )}
    <h3 class="ar-group">Bundled with rotom ${list.bundled.version}</h3>
    <p class="ar-hint">${BUNDLED}</p>
    ${list.bundled.extensions.map(
        (extension) =>
            html`<${Row}
                name=${extension.name}
                path=${extension.path}
                notes=${bundledNotes(extension)}
                tags=${html`<${Tag} kind="bundled">${extension.from}<//>`}
            />`,
    )}`;
}

function Mcp({ list }) {
    return html`${list.mcpProblems.map((each) => html`<p class="ar-note warn">${each}</p>`)}
    ${list.mcp.length === 0 && html`<p class="muted">No MCP servers configured.</p>`}
    ${list.mcp.map(
        (server) =>
            html`<${Row}
                name=${server.name}
                off=${!server.enabled}
                inherited=${list.project && server.scope === "shared"}
                path=${`${server.file} → mcpServers.${server.name}`}
                notes=${[[server.target], server.override && [`Overridden in ${server.override}`]]}
                tags=${html`${scopeTag(server.scope)}
                ${server.override && html`<${Tag}>overridden<//>`}
                ${!server.enabled && html`<${Tag}>disabled<//>`}`}
            />`,
    )}`;
}

const BUNDLED =
    "Every Team session loads these, whatever the files above say: the pinned rotom product's, " +
    "Team's own, and Pi's built-in ones.";

const FOOT =
    "Read only. Change shared and project files on the deployment machine, then run /reload in a " +
    "running session. Bundled entries change only with the pinned rotom release.";

/** A project by name, any other folder by path, with its session count. */
function folderName(folder) {
    const sessions = `${folder.sessions} session${folder.sessions === 1 ? "" : "s"}`;
    const notes = folder.isDefault ? `default, ${sessions}` : sessions;

    return `${folder.project ? `${folder.project} — ` : ""}${folder.path} (${notes})`;
}

const BODIES = { instructions: Instructions, skills: Skills, extensions: Extensions, mcp: Mcp };

export function AgentResourcesSheet() {
    const [folders, setFolders] = useState(null);
    const [folder, setFolder] = useState(null);
    const [tab, setTab] = useState("skills");
    const [list, setList] = useState(null);
    const [error, setError] = useState("");

    useEffect(() => {
        api("agent-resources/folders")
            .then(setFolders)
            .catch((e) => setError(e.message));
    }, []);

    useEffect(() => {
        let current = true;

        setList(null);
        setError("");
        api(`agent-resources${folder ? `?folder=${encodeURIComponent(folder)}` : ""}`)
            .then((result) => current && setList(result))
            .catch((e) => current && setError(e.message));

        return () => {
            current = false;
        };
    }, [folder]);

    const counts = list && {
        instructions: list.instructions.length,
        skills: list.skills.length,
        extensions: list.extensions.length + list.bundled.extensions.length,
        mcp: list.mcp.length,
    };
    const scanned = list && tab !== "instructions" ? list.scanned[tab] : null;
    const Body = BODIES[tab];

    return html`<${Sheet} title="Agent resources" onClose=${closeSheet}>
        <div class="ar-scope">
            <div class="segmented" role="group" aria-label="Scope">
                <button
                    class=${folder ? "" : "on"}
                    aria-pressed=${!folder}
                    onClick=${() => setFolder(null)}
                >
                    Shared
                </button>
                <button
                    class=${folder ? "on" : ""}
                    aria-pressed=${!!folder}
                    disabled=${!folders?.length}
                    onClick=${() => folder || setFolder(folders[0].path)}
                >
                    Folder
                </button>
            </div>
            ${
                folder &&
                html`<select
                    aria-label="Folder"
                    value=${folder}
                    onChange=${(event) => setFolder(event.currentTarget.value)}
                >
                    ${folders.map(
                        (each) => html`<option value=${each.path}>${folderName(each)}</option>`,
                    )}
                </select>`
            }
        </div>
        <p class="ar-hint">
            ${
                folder
                    ? "What a session in this folder loads: the shared profile and the folder, which " +
                      "the session trusts, merged. Dashed rows come from the shared profile."
                    : "The shared profile every Team session loads."
            }
        </p>
        ${
            // The owner always has the default folder; a member may have no project yet.
            folders?.length === 0 &&
            html`<p class="ar-hint">No projects are shared with you yet.</p>`
        }
        <div class="ar-tabs" role="tablist">
            ${TABS.map(
                ([key, name]) => html`<button
                    role="tab"
                    aria-selected=${tab === key}
                    class=${tab === key ? "on" : ""}
                    onClick=${() => setTab(key)}
                >
                    ${name} ${counts && html`<span class="ar-count">${counts[key]}</span>`}
                </button>`,
            )}
        </div>
        ${error && html`<p role="alert">${error}</p>`}
        ${!list && !error && html`<${Loader} label="Scanning agent resources" />`}
        ${
            list?.problems.length > 0 &&
            html`<div class="ar-note err" role="alert">
                <strong>Lists below may be incomplete.</strong>
                ${list.problems.map((each) => html`<div>${each}</div>`)}
            </div>`
        }
        ${
            scanned &&
            html`<div class="ar-scanned">
                Scanned:
                ${scanned.map(
                    (place) =>
                        html`<div>
                            <code>${place.path}</code>
                            ${!place.exists && html`<span class="ar-none">(none)</span>`}
                        </div>`,
                )}
            </div>`
        }
        ${list && html`<${Body} list=${list} />`}
        <p class="ar-foot">${FOOT}</p>
    <//>`;
}
