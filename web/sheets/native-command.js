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
import { NativeSelector } from "./native-selector.js";
import {
    buildContextMap,
    contextColor,
    contextPercent,
    contextSpace,
    contextTokens,
} from "../context-usage.js";

export function nativeCommandAccepted(result) {
    return (
        !["unknown", "rejected", "interrupted"].includes(result.status) &&
        !result.nativeResult?.navigation?.cancelled
    );
}

export function showNativeResult(result, commandName) {
    if (["unknown", "rejected", "interrupted"].includes(result.status)) {
        notify(
            "warning",
            `Native command outcome: ${result.status}. Do not replay an unknown operation.`,
        );

        return;
    }

    if (result.operation === "compact" && result.status === "settled") {
        notify("info", "Context compacted.");
    } else if (commandName === "reload" && result.status === "handled") {
        notify("info", "Native resources reloaded.");
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

function ContextRows({ rows, total, depth = 0 }) {
    return rows.map((row) => {
        const cells = html`<span>${row.label}</span>
            <span class="native-context-row-bar" aria-hidden="true">
                <i style=${`width: ${Math.min(100, (row.tokens / Math.max(total, 1)) * 100)}%`}></i>
            </span>
            <strong>${contextTokens(row.tokens)}</strong>`;

        return row.children?.length
            ? html`<details class="native-context-row-wrap" key=${row.id ?? row.label}>
                <summary class="native-context-row" style=${`--context-depth: ${depth}`}>
                    ${cells}
                </summary>
                <${ContextRows} rows=${row.children} total=${total} depth=${depth + 1} />
            </details>`
            : html`<div class="native-context-row" key=${row.id ?? row.label} style=${`--context-depth: ${depth}`}>
                ${cells}
            </div>`;
    });
}

function UsageRows({ rows, total, depth = 0, color }) {
    return rows.map((row) => {
        const rowColor = color ?? contextColor(row.id);
        const style = `--context-depth: ${depth}; --context-color: ${rowColor}`;
        const cells = html`<span class="native-context-label">
                <i class=${`native-context-swatch ${depth ? "breakdown" : ""}`} aria-hidden="true"></i>
                <span>${row.label}</span>
            </span>
            <span class="native-context-leader" aria-hidden="true"></span>
            <strong title=${`${row.tokens.toLocaleString()} estimated tokens`}>${contextTokens(row.tokens)}</strong>
            <span class="native-context-percent">${contextPercent(row.tokens, total)}</span>`;

        return row.children?.length
            ? html`<details
                class="native-context-category"
                key=${row.id ?? row.label}
                open=${row.id === "tool-output" || depth > 0}
            >
                <summary class="native-context-usage-row" style=${style}>${cells}</summary>
                <${UsageRows} rows=${row.children} total=${total} depth=${depth + 1} color=${rowColor} />
            </details>`
            : html`<div class="native-context-usage-row" key=${row.id ?? row.label} style=${style}>
                ${cells}
            </div>`;
    });
}

function SpaceRow({ label, tokens, total, fill }) {
    return html`<div class="native-context-usage-row native-context-space">
        <span class="native-context-label">
            <i class=${`native-context-swatch ${fill}`} aria-hidden="true"></i>
            <span>${label}</span>
        </span>
        <span class="native-context-leader" aria-hidden="true"></span>
        <strong>${contextTokens(tokens)}</strong>
        <span class="native-context-percent">${contextPercent(tokens, total)}</span>
    </div>`;
}

function NativeContext({ context }) {
    if (context.view === "injections") {
        return html`<div class="native-context">
            <div class="native-context-summary">
                <div><strong>${contextTokens(context.totalTokens)}</strong><span>estimated tokens</span></div>
                <div><strong>${context.groups?.length ?? 0}</strong><span>sources</span></div>
                <div><strong>${context.hiddenTools?.length ?? 0}</strong><span>hidden tools</span></div>
            </div>
            ${
                !context.captured &&
                html`<p class="native-context-note">No completed model request was captured yet. Showing the current prompt and tools.</p>`
            }
            <div class="native-context-groups">
                ${context.groups?.map(
                    (group) => html`<section class="native-context-group" key=${group.source}>
                        <header>
                            <span>${group.source}${group.native ? " · native" : ""}</span>
                            <strong>${contextTokens(group.totalTokens)}</strong>
                        </header>
                        <${ContextRows} rows=${group.items ?? []} total=${context.totalTokens} />
                    </section>`,
                )}
            </div>
            <p class="muted small">Content text stays inside the native process; Team stores only labels and token estimates.</p>
        </div>`;
    }

    const windowTokens = context.reported?.contextWindow;
    const usedTokens = context.estimatedTokens;
    const { buffer, free } = contextSpace(context);
    const map = buildContextMap(context);
    const labels = new Map(context.categories?.map((category) => [category.id, category.label]));

    return html`<div class="native-context native-context-usage">
        <div class="native-context-meta">
            <span class="native-context-model">${context.model ?? "Current model"}</span>
            <span>${contextTokens(usedTokens)} / ${contextTokens(windowTokens)} tokens · ${contextPercent(usedTokens, windowTokens)}</span>
        </div>
        <div class=${`native-context-dashboard ${map ? "" : "no-map"}`}>
            <div class="native-context-map-panel">
                ${
                    map
                        ? html`<div
                        class="native-context-map"
                        role="img"
                        aria-label=${`Estimated context: ${contextTokens(usedTokens)} of ${contextTokens(windowTokens)} tokens. Each square represents ${contextTokens(Math.round(map.blockTokens))} tokens. Category breakdown follows.`}
                    >
                        ${map.cells.map(
                            (cell, index) => html`<i
                            key=${index}
                            class=${`native-context-cell ${cell.fill}`}
                            style=${`--context-color: ${contextColor(cell.categoryId)}`}
                            aria-hidden="true"
                            title=${cell.categoryId ? labels.get(cell.categoryId) : cell.fill === "buffer" ? "Auto-Compact Buffer" : "Free Space"}
                        ></i>`,
                        )}
                    </div>
                    <div class="native-context-map-key">
                        <span><i class="native-context-swatch" aria-hidden="true"></i>One category</span>
                        <span><i class="native-context-swatch partial" aria-hidden="true"></i>Mixed</span>
                        <span>${contextTokens(Math.round(map.blockTokens))} tokens / square (${contextPercent(1, map.cells.length)})</span>
                    </div>`
                        : html`<p class="native-context-note">Context window unknown. The map and percentages are unavailable.</p>`
                }
            </div>
            <section class="native-context-legend" aria-label="Context categories">
                <div class="native-context-legend-head" aria-hidden="true">
                    <span>Category</span><span>Tokens</span><span>Window %</span>
                </div>
                <${UsageRows} rows=${context.categories ?? []} total=${windowTokens} />
                <div class="native-context-space-rows">
                    <${SpaceRow} label="Auto-Compact Buffer" tokens=${buffer} total=${windowTokens} fill="buffer" />
                    <${SpaceRow} label="Free Space" tokens=${free} total=${windowTokens} fill="free" />
                </div>
            </section>
        </div>
        <div class="native-context-meta native-context-footnote">
            <span>Native estimate · not billing usage</span>
            ${context.captured && Number.isFinite(context.reported?.tokens) && html`<span>Provider total: ${contextTokens(context.reported.tokens)}</span>`}
            ${!context.captured && html`<span>No request captured yet · no probe sent</span>`}
        </div>
    </div>`;
}

export function NativeInfoSheet() {
    const [result] = useState(store.state.sheet.result);

    if (result.context?.type === "native-context") {
        return html`<${Sheet} title=${result.context.title} wide className="native-context-sheet" onClose=${closeSheet}>
            <${NativeContext} context=${result.context} />
        <//>`;
    }

    return html`<${Sheet} title=${result.title ?? "Native command result"} onClose=${closeSheet}>
        <pre class="native-command-output">${result.text ?? JSON.stringify(result, null, 2)}</pre>
    <//>`;
}

const EXECUTION_SETTINGS = [
    [
        "steeringMode",
        "Steering mode",
        "How queued steering messages reach the running agent.",
        ["one-at-a-time", "all"],
    ],
    [
        "followUpMode",
        "Follow-up mode",
        "How queued follow-up messages are delivered.",
        ["one-at-a-time", "all"],
    ],
    [
        "imageAutoResize",
        "Auto-resize images",
        "Resize large images before sending them to the model.",
        [true, false],
    ],
    ["blockImages", "Block images", "Prevent images from being sent to the model.", [false, true]],
    [
        "enableSkillCommands",
        "Skill commands",
        "Expose installed skills as slash commands.",
        [true, false],
    ],
];

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
            <p class="muted small">Only the owner can change shared native settings while accounts are idle. Terminal appearance and keybindings are not browser settings.</p>
            <${NativeSelector}
                label="Settings"
                cycleValues
                items=${[
                    ...EXECUTION_SETTINGS.map(([value, label, description]) => ({
                        value,
                        label,
                        description,
                        current: String(settings[value]),
                        disabled: !sharedWritable,
                    })),
                    {
                        value: "autoRetry",
                        label: "Auto retry",
                        current: String(settings.autoRetry),
                        description: "Inherited from native rotom settings; read-only here.",
                        disabled: true,
                    },
                    {
                        value: "autoCompaction",
                        label: "Auto compaction",
                        current: String(settings.autoCompaction),
                        description: "Inherited from native rotom settings; read-only here.",
                        disabled: true,
                    },
                    {
                        value: "scope",
                        label: "Model cycle scope…",
                        description: "Choose which personal models participate in cycling.",
                    },
                ]}
                onChoose=${(item, step) => {
                    if (item.value === "scope") {
                        openSheet({ type: "native-models" });

                        return;
                    }

                    const [, , , values] = EXECUTION_SETTINGS.find(([name]) => name === item.value);
                    const index = values.indexOf(settings[item.value]);

                    return save({
                        [item.value]: values[(index + step + values.length) % values.length],
                    });
                }}
            />
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
    const [sheet] = useState(store.state.sheet);
    const fork = sheet.command === "fork";
    const items = sheet.options.map((option, index) => ({
        ...option,
        value: option.entryId ?? option.text,
        label: fork ? option.label.replace(/^user: /, "") : option.label,
        description: fork ? `Message ${index + 1} of ${sheet.options.length}` : "",
    }));

    return html`<${Sheet} title=${fork ? "Fork from Message" : sheet.title} onClose=${closeSheet}>
        ${fork && html`<p class="muted small">Select a user message. Copy its preceding history into a new session and put the selected message back in the composer.</p>`}
        ${
            items.length === 0
                ? html`<p class="muted">No user messages found.</p>`
                : html`<${NativeSelector}
            items=${items}
            selectedValue=${fork ? items.at(-1)?.value : undefined}
            searchable=${!fork}
            label=${fork ? "User messages" : "Commands"}
            onChoose=${(item) => runChoice(item.text)}
        />`
        }
    <//>`;
}

const THINKING_DESCRIPTIONS = {
    off: "No reasoning",
    minimal: "Very brief reasoning (~1k tokens)",
    low: "Light reasoning (~2k tokens)",
    medium: "Moderate reasoning (~8k tokens)",
    high: "Deep reasoning (~16k tokens)",
    xhigh: "Extra-high reasoning (~32k tokens)",
    max: "Maximum reasoning",
};

export function NativeThinkingSheet() {
    const [choice] = useState(store.state.sheet);
    const items = choice.levels.map((level) => ({
        value: level,
        label: `${choice.thinkingLevel === level ? "✓ " : ""}${level}`,
        description: THINKING_DESCRIPTIONS[level],
    }));

    return html`<${Sheet} title="Thinking Level" onClose=${closeSheet}>
        <${NativeSelector}
            label="Thinking levels"
            items=${items}
            selectedValue=${choice.thinkingLevel}
            onChoose=${(item) =>
                attempt(async () => {
                    const result = await actions.configure({ thinkingLevel: item.value });

                    if (result.receipt && !nativeCommandAccepted(result.receipt)) {
                        showNativeResult(result.receipt);

                        return;
                    }

                    closeSheet();
                    notify("info", "Thinking preference updated.");
                })}
        />
        <p class="muted small">The paying member can change thinking while running. Changes apply to subsequent model requests, not the response already streaming.</p>
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
