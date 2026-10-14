// Native command selections. Options and actions come from the authorized Team adapter.
import {
    actions,
    attempt,
    closeSheet,
    drafts,
    insertIntoComposer,
    navigate,
    notify,
    openSheet,
    store,
} from "../store.js";
import { html, Sheet } from "../ui.js";
import { useEffect, useRef, useState } from "preact/hooks";
import { FILTERS, TreeView } from "../native-tree.js";

export function nativeCommandAccepted(result) {
    return (
        !["unknown", "rejected", "interrupted"].includes(result.status) &&
        !result.nativeResult?.navigation?.cancelled
    );
}

export function showNativeResult(result) {
    if (["unknown", "rejected", "interrupted"].includes(result.status)) {
        notify(
            "warning",
            `Native command outcome: ${result.status}. Do not replay an unknown operation.`,
        );

        return;
    }

    const navigation = result.nativeResult?.navigation;

    if (navigation?.cancelled) {
        notify("warning", "Native tree navigation was cancelled.");

        return;
    }

    const editorText = result.editorText ?? navigation?.editorText;

    if (typeof editorText === "string") {
        drafts.set(result.conversationId ?? store.state.conversationId, editorText);
    }

    if (result.conversationId !== undefined) {
        navigate(result.conversationId);
    }

    if (typeof editorText === "string") {
        insertIntoComposer(editorText, [], { replace: true });
    }

    if (result.interaction) {
        openSheet(result.interaction);
    }

    if (result.nativeResult) {
        if (typeof result.nativeResult.clipboard === "string") {
            attempt(() => navigator.clipboard.writeText(result.nativeResult.clipboard));
        } else if (!navigation) {
            openSheet({ type: "native-info", result: result.nativeResult });
        }
    }

    if (result.download) {
        const link = document.createElement("a");

        link.href = result.download;
        link.download = "";
        link.click();
    }
}

export function NativeInfoSheet() {
    return html`<${Sheet} title="Native command result" onClose=${closeSheet}>
        <pre>${JSON.stringify(store.state.sheet.result, null, 2)}</pre>
    <//>`;
}

export function NativeSettingsSheet({ scope = false }) {
    const [settings, setSettings] = useState(null);
    const sharedWritable = store.state.me?.role === "owner";

    useEffect(() => {
        attempt(async () => setSettings(await actions.nativeSettings()));
    }, []);
    const save = (patch) => attempt(async () => setSettings(await actions.nativeSettings(patch)));

    const toggle = (name) => {
        const selected = settings.models
            .filter((model) => model.selected)
            .map((model) => model.nativeName);

        return save({
            enabledModels: selected.includes(name)
                ? selected.filter((item) => item !== name)
                : [...selected, name],
        });
    };

    const cycle = () =>
        attempt(async () => {
            const models = settings.models.filter(
                (model) => settings.enabledModels.length === 0 || model.selected,
            );
            const current = store.state.view.agent?.model;
            const index = models.findIndex(
                (model) => model.provider === current?.provider && model.id === current?.modelId,
            );
            const next = models[(index + 1) % models.length];

            if (next) {
                await actions.configure({
                    model: { provider: next.provider, modelId: next.id },
                    ...(next.thinkingLevel ? { thinkingLevel: next.thinkingLevel } : {}),
                });
            }
        });

    return html`<${Sheet} title=${scope ? "Native model cycle scope" : "Native execution settings"} onClose=${closeSheet}>
        ${
            !settings
                ? html`<p>Loading…</p>`
                : scope
                  ? html`
            <p class="muted">The owner sets shared model patterns. An empty scope means all your available models; model cycling still uses your own account.</p>
            ${settings.models.map(
                (model) => html`<label class="field">
                <input type="checkbox" disabled=${!sharedWritable} checked=${model.selected} onChange=${() => toggle(model.nativeName)} />
                ${model.name}
            </label>`,
            )}
            ${settings.scopeWarnings.map((warning) => html`<p class="muted">${warning}</p>`)}
            <button class="button" onClick=${cycle}>Cycle model</button>
        `
                  : html`
            <p class="muted">Only the owner can change shared native settings. Project settings cannot override them. Retry and compaction use the pinned rotom defaults.</p>
            ${["steeringMode", "followUpMode"].map(
                (key) => html`<label class="field">
                ${key}
                <select disabled=${!sharedWritable} value=${settings[key]} onChange=${(event) => save({ [key]: event.currentTarget.value })}>
                    <option value="one-at-a-time">One at a time</option>
                    <option value="all">All</option>
                </select>
            </label>`,
            )}
            ${["imageAutoResize", "blockImages", "enableSkillCommands"].map(
                (key) => html`<label class="field">
                <input type="checkbox" disabled=${!sharedWritable} checked=${settings[key]} onChange=${(event) => save({ [key]: event.currentTarget.checked })} />
                ${key}
            </label>`,
            )}
        `
        }
    <//>`;
}

/** Run the chosen native selection; its result restores a draft or opens the next step, never auto-submits. */
const runChoice = (text) =>
    attempt(async () => {
        const result = await actions.submit(text, [], "steer", false, true);

        closeSheet();
        showNativeResult(result);
    });

export function NativeCommandSheet() {
    const sheet = store.state.sheet;

    return html`<${Sheet} title=${sheet.title} onClose=${closeSheet}>
        ${sheet.options.length === 0 && html`<p class="muted">No native entries yet.</p>`}
        ${sheet.options.map(
            (option) => html`<button
                class="button wide"
                data-entry-id=${option.entryId}
                onClick=${() => runChoice(option.text)}
            >
                ${option.label}
            </button>`,
        )}
    <//>`;
}

const FILTER_NAMES = {
    default: "default",
    "no-tools": "no-tools",
    "user-only": "user",
    "labeled-only": "labeled",
    all: "all",
};
const FILTER_KEYS = { d: "default", t: "no-tools", u: "user-only", l: "labeled-only", a: "all" };
const TREE_HELP =
    "↑/↓ move · ←/→ page · option+←/→ branch · shift+t label time · " +
    "filters ctrl+d/t/u/l/a · cycle ctrl+o/shift+ctrl+o";
const TREE_NOTE =
    "Enter or a tap goes to an entry. Choosing a user message puts its text back in the box. " +
    "The shared transcript keeps every branch for audit.";
const toneClass = (tone) =>
    tone
        .split(" ")
        .filter(Boolean)
        .map((each) => `tone-${each}`)
        .join(" ");

/** /tree as the terminal draws it: the same rows, keys and filters, with taps for touch screens. */
export function NativeTreeSheet() {
    const sheet = store.state.sheet;
    const [view] = useState(() => new TreeView(sheet.nodes, sheet.leafId));
    const [, setVersion] = useState(0);
    const [summarize, setSummarize] = useState(false);
    const list = useRef(null);
    const search = useRef(null);
    const scroll = useRef("center");

    const update = (block = "nearest") => {
        scroll.current = block;
        setVersion((version) => version + 1);
    };

    const choose = (id) => runChoice(`/tree ${id}${summarize ? " --summarize" : ""}`);

    useEffect(() => {
        // A phone keyboard would cover the tree; pointer devices type to search at once, as in the terminal.
        if (matchMedia("(pointer: fine)").matches) {
            search.current.focus({ preventScroll: true });
        }
    }, []);

    useEffect(() => {
        if (scroll.current) {
            list.current
                ?.querySelector(".native-tree-row.on")
                ?.scrollIntoView({ block: scroll.current });
            scroll.current = null;
        }
    });

    useEffect(() => {
        const observer = new ResizeObserver(() => {
            list.current.querySelector(".native-tree-row.on")?.scrollIntoView({ block: "nearest" });
        });

        observer.observe(list.current);

        return () => observer.disconnect();
    }, []);

    const pageSize = () => {
        const row = list.current?.querySelector(".native-tree-row");

        return Math.max(
            5,
            Math.floor((list.current?.clientHeight ?? 0) / (row?.offsetHeight || 1)),
        );
    };

    const onKey = (event) => {
        const key = event.key.toLowerCase();
        const ctrl = event.ctrlKey && !event.metaKey;
        const control = event.target.closest("button, input[type=checkbox]");

        if (event.isComposing || event.metaKey) {
            return;
        }

        if (key === "escape") {
            if (view.query) {
                event.stopPropagation();
                view.search("");
                update();
            }

            return;
        }

        if (key === "enter") {
            if (!control && view.rows[view.selected]) {
                event.preventDefault();
                choose(view.rows[view.selected].node.id);
            }

            return;
        }

        if (key === "arrowup" || key === "arrowdown") {
            view.move(key === "arrowup" ? -1 : 1);
        } else if ((key === "arrowleft" || key === "arrowright") && (event.altKey || ctrl)) {
            key === "arrowleft" ? view.foldOrUp() : view.unfoldOrDown();
        } else if (key === "arrowleft" || key === "pageup") {
            view.page(-pageSize());
        } else if (key === "arrowright" || key === "pagedown") {
            view.page(pageSize());
        } else if (ctrl && FILTER_KEYS[key]) {
            view.setFilter(FILTER_KEYS[key]);
        } else if (ctrl && key === "o") {
            view.cycleFilter(event.shiftKey ? -1 : 1);
        } else if (event.shiftKey && !ctrl && !event.altKey && key === "t") {
            view.toggleLabelTimes();
        } else {
            if (
                event.target !== search.current &&
                !control &&
                event.key.length === 1 &&
                !ctrl &&
                !event.altKey
            ) {
                event.preventDefault();
                search.current.focus({ preventScroll: true });
                view.search(view.query + event.key);
                update();
            }

            return;
        }

        event.preventDefault();
        update();
    };

    const selected = view.rows[view.selected]?.node.id;

    return html`<${Sheet} title=${sheet.title} wide className="native-tree-sheet" onClose=${closeSheet}>
        <div class="native-tree" onKeyDown=${onKey}>
            <div class="native-tree-help">${TREE_HELP}</div>
            <label class="native-tree-search">
                <span>Type to search:</span>
                <input
                    ref=${search}
                    type="text"
                    autocomplete="off"
                    spellcheck="false"
                    role="combobox"
                    aria-label="Search the session tree"
                    aria-autocomplete="list"
                    aria-expanded="true"
                    aria-controls="native-tree-entries"
                    aria-activedescendant=${selected ? `native-tree-entry-${selected}` : undefined}
                    value=${view.query}
                    onInput=${(event) => {
                        view.search(event.currentTarget.value);
                        update();
                    }}
                />
            </label>
            <div class="segmented" role="group" aria-label="Tree filter">
                ${FILTERS.map(
                    (mode) => html`<button
                        class=${view.filter === mode ? "on" : ""}
                        aria-pressed=${view.filter === mode}
                        onClick=${() => {
                            view.setFilter(mode);
                            update("center");
                        }}
                    >
                        ${FILTER_NAMES[mode]}
                    </button>`,
                )}
            </div>
            <div
                id="native-tree-entries"
                class="native-tree-list"
                role="listbox"
                aria-label="Session entries"
                ref=${list}
            >
                ${view.rows.length === 0 && html`<div class="native-tree-empty">No entries found</div>`}
                ${view.rows.map((row) => {
                    const line = view.line(row);

                    return html`<button
                        key=${line.id}
                        id=${`native-tree-entry-${line.id}`}
                        class=${`native-tree-row ${line.id === selected ? "on" : ""}`}
                        role="option"
                        tabindex="-1"
                        aria-selected=${line.id === selected}
                        data-entry-id=${line.id}
                        onClick=${() => choose(line.id)}
                    >
                        <span class="native-tree-cursor">${line.id === selected ? "› " : "  "}</span>
                        <span class="tone-dim">${line.prefix}</span>
                        <span class="tone-accent">${line.fold}${line.active}</span>
                        <span class="tone-warning">${line.label}</span>
                        <span class="tone-muted">${line.labelTime}</span>
                        ${line.parts.map(
                            ([tone, text]) => html`<span class=${toneClass(tone)}>${text}</span>`,
                        )}
                    </button>`;
                })}
            </div>
            <div class="native-tree-count">
                (${view.rows.length === 0 ? 0 : view.selected + 1}/${view.rows.length})${view.status()}
            </div>
            <label class="field native-tree-summary">
                <input
                    type="checkbox"
                    checked=${summarize}
                    onChange=${(event) => setSummarize(event.currentTarget.checked)}
                />
                Summarize the abandoned branch using my selected model and account
            </label>
            <p class="muted small">${TREE_NOTE}</p>
        </div>
    <//>`;
}
