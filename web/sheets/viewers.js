// Artifacts and images, each in a viewer of its own.
import { useEffect, useMemo, useState } from "preact/hooks";
import { writtenFiles } from "../calls.js";
import { filesAvailable, setFilesOpen } from "../files-panel.js";
import { canSteer, closeSheet, openSheet, store } from "../store.js";
import { downloadUrl, formatBytes, html, Icon, openFile, Sheet, timeAgo } from "../ui.js";

export function ArtifactsSheet() {
    const { artifacts, order, entries } = store.state.view;
    const files = useMemo(
        () => writtenFiles(order.map((id) => entries.get(id)).filter(Boolean)),
        [order],
    );
    const items = [...artifacts].sort(
        (a, b) => (b.versions.at(-1)?.createdAt ?? 0) - (a.versions.at(-1)?.createdAt ?? 0),
    );

    return html`<${Sheet} title="Outputs" onClose=${closeSheet}>
        <p class="muted small">
            Files written in this conversation's history, including inherited history. These open the
            current files, not saved versions; copies and branches can share the same folder.
        </p>
        ${filesAvailable() && html`<button class="button" onClick=${() => setFilesOpen(true, "files")}>Browse project files</button>`}
        <div class="group-title">Files · ${files.length}</div>
        ${files.length === 0 && html`<p class="muted">No successful file writes recorded yet. Files made by shell commands or other tools can be found in the project folder.</p>`}
        ${files.map(
            (file) => html`<a
            class="list-item output-file"
            href=${downloadUrl(file.path)}
            target="_blank"
            rel="noopener noreferrer"
            onClick=${(event) => {
                if (
                    canSteer() &&
                    !event.ctrlKey &&
                    !event.metaKey &&
                    !event.shiftKey &&
                    !event.altKey
                ) {
                    event.preventDefault();
                    openFile(file.path);
                }
            }}
        >
            <span>
                <span class="mono">${file.path}</span>
                <span class="muted small">${file.action === "write" ? "Written" : "Edited"} · open current file</span>
            </span>
            <${Icon} name="file" size=${16} />
        </a>`,
        )}
        <div class="group-title">Published artifacts · ${items.length}</div>
        ${items.length === 0 && html`<p class="muted">No separately published artifacts. Generated files appear above; open an HTML file to preview or run it.</p>`}
        ${items.map((artifact) =>
            [...artifact.versions].reverse().map(
                (version) => html`<button
                    class="list-item"
                    onClick=${() => openSheet({ type: "viewer", id: artifact.id, version: version.version })}
                >
                    <span>
                        ${artifact.title}
                        <br />
                        <span class="muted small mono">${artifact.id}</span>
                    </span>
                    <span class="muted small mono">
                        ${artifact.type} v${version.version} · ${formatBytes(version.size)} · ${timeAgo(version.createdAt)}
                    </span>
                </button>`,
            ),
        )}
    <//>`;
}

export function ArtifactViewer({ id, version }) {
    const { view } = store.state;
    const artifact = view.artifacts.find((each) => each.id === id);
    const [shown, setShown] = useState(version ?? artifact?.versions.at(-1)?.version);
    const [nonce, setNonce] = useState(0);
    const latest = artifact?.versions.at(-1)?.version;
    const src = `/a/${view.conversation.id}/${encodeURIComponent(id)}/${shown ?? "latest"}`;

    return html`<div class="viewer">
        <header class="viewer-head">
            <div class="viewer-title">
                <strong>${artifact?.title ?? id}</strong>
                <span class="muted small">
                    ${artifact?.type ?? ""} · version ${shown}
                    ${latest && shown !== latest ? html` · <button class="link" onClick=${() => setShown(latest)}>latest is v${latest}</button>` : ""}
                </span>
            </div>
            ${
                artifact &&
                artifact.versions.length > 1 &&
                html`<select
                    aria-label="Version"
                    value=${shown}
                    onChange=${(event) => setShown(Number(event.currentTarget.value))}
                >
                    ${[...artifact.versions]
                        .reverse()
                        .map(
                            (each) => html`<option value=${each.version}>v${each.version}</option>`,
                        )}
                </select>`
            }
            <button class="icon-button" title="Reload" onClick=${() => setNonce(nonce + 1)}>
                ↻
            </button>
            <a class="button small" href=${src} target="_blank" rel="noopener">Open tab</a>
            <button class="icon-button" onClick=${closeSheet} aria-label="Close">
                <${Icon} name="close" />
            </button>
        </header>
        <iframe
            key=${`${src}#${nonce}`}
            src=${src}
            sandbox="allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock allow-downloads"
            allow="fullscreen; clipboard-write; accelerometer; gyroscope"
            title=${artifact?.title ?? id}
        ></iframe>
    </div>`;
}

/** An image full screen. Tap anywhere to close; Open shows it in its own tab to zoom, save, or share. */
export function ImageViewer({ src, alt }) {
    useEffect(() => {
        const onKey = (event) => event.key === "Escape" && closeSheet();

        addEventListener("keydown", onKey);

        return () => removeEventListener("keydown", onKey);
    }, []);

    return html`<div
        class="lightbox"
        role="dialog"
        aria-label=${alt || "Image"}
        onClick=${closeSheet}
    >
        <img src=${src} alt=${alt ?? ""} />
        <div class="lightbox-bar" onClick=${(event) => event.stopPropagation()}>
            <span class="lightbox-title">${alt ?? ""}</span>
            <a class="button small" href=${src} target="_blank" rel="noopener">Open</a>
            <button class="icon-button" onClick=${closeSheet} aria-label="Close">
                <${Icon} name="close" />
            </button>
        </div>
    </div>`;
}
