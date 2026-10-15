// Terminal-style selections shared by native thinking, fork, settings and Goal menus.
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { html } from "../ui.js";

export function NativeSelector({
    items,
    onChoose,
    selectedValue,
    searchable = true,
    cycleValues = false,
    label = "Choices",
}) {
    const id = useId();
    const [query, setQuery] = useState("");
    const [picked, setPicked] = useState(() => selectedValue ?? items[0]?.value);
    const [busy, setBusy] = useState(false);
    const box = useRef(null);
    const search = useRef(null);
    const needle = query.toLowerCase();
    const shown = items.filter((item) =>
        `${item.label} ${item.description ?? ""}`.toLowerCase().includes(needle),
    );
    const active = Math.max(
        0,
        shown.findIndex((item) => item.value === picked),
    );
    const selected = shown[active];

    useEffect(() => {
        (searchable && matchMedia("(pointer: fine)").matches ? search.current : box.current)?.focus(
            { preventScroll: true },
        );
    }, []);
    useEffect(() => {
        box.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
    }, [picked, query]);

    const choose = async (item, step = 1) => {
        if (!item || item.disabled || busy) {
            return;
        }

        setBusy(true);

        try {
            await onChoose(item, step);
        } finally {
            setBusy(false);
        }
    };

    const keydown = (event) => {
        if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey || busy) {
            return;
        }

        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();

            if (shown.length) {
                const index =
                    (active + (event.key === "ArrowUp" ? -1 : 1) + shown.length) % shown.length;

                setPicked(shown[index].value);
            }
        } else if (
            event.key === "Enter" ||
            (cycleValues && ["ArrowLeft", "ArrowRight"].includes(event.key))
        ) {
            event.preventDefault();
            void choose(selected, event.key === "ArrowLeft" ? -1 : 1);
        }
    };

    return html`<div class="native-selector" ref=${box} tabindex="-1" onKeyDown=${keydown}
        role=${searchable ? undefined : "listbox"}
        aria-label=${searchable ? undefined : label}
        aria-activedescendant=${!searchable && selected ? `${id}-${active}` : undefined}
        aria-busy=${busy}
    >
        ${
            searchable &&
            html`<input
            ref=${search}
            aria-label=${`Search ${label}`}
            role="combobox"
            aria-expanded="true"
            aria-controls=${id}
            aria-activedescendant=${selected ? `${id}-${active}` : undefined}
            placeholder="Type to search…"
            value=${query}
            onInput=${(event) => setQuery(event.currentTarget.value)}
        />`
        }
        <div id=${id} class="native-selector-list" role=${searchable ? "listbox" : "presentation"} aria-label=${searchable ? label : undefined}>
            ${shown.length === 0 && html`<p class="muted">No matches.</p>`}
            ${shown.map(
                (item, index) => html`<button
                key=${item.value}
                id=${`${id}-${index}`}
                data-value=${item.value}
                class=${`native-selector-row ${item === selected ? "on" : ""}`}
                role="option"
                aria-selected=${item === selected}
                aria-disabled=${item.disabled || busy}
                data-entry-id=${item.entryId}
                onFocus=${() => setPicked(item.value)}
                onClick=${() => {
                    setPicked(item.value);
                    void choose(item);
                }}
            >
                <span class="native-selector-cursor">${item === selected ? "›" : ""}</span>
                <span class="native-selector-content">
                    <span class="native-selector-name">${item.label}</span>
                    ${item.description && html`<span class="native-selector-description">${item.description}</span>`}
                </span>
                ${item.current !== undefined && html`<span class="native-selector-value">${item.current}</span>`}
            </button>`,
            )}
        </div>
        <div class="muted small">${busy ? "Working…" : cycleValues ? "↑/↓ move · Enter or ←/→ change · Esc close" : "↑/↓ move · Enter select · Esc cancel"}</div>
    </div>`;
}
