// The terminal /tree selector's model, ported from the pinned TreeSelectorComponent's TreeList: the same order,
// connectors, filters, search, folding and branch jumps. Rows come from src/server/native-tree.ts.

export const FILTERS = ["default", "no-tools", "user-only", "labeled-only", "all"];
const STATUS = {
    "no-tools": " [no-tools]",
    "user-only": " [user]",
    "labeled-only": " [labeled]",
    all: " [all]",
};
const SETTINGS = [
    "label",
    "context_edit",
    "custom",
    "model_change",
    "thinking_level_change",
    "session_info",
];

/** Roots and children like SessionManager.getTree(): orphans are roots, children oldest first. */
function buildTree(nodes) {
    const byId = new Map(nodes.map((node) => [node.id, { node, children: [] }]));
    const roots = [];

    for (const node of nodes) {
        const parent = node.parentId === node.id ? undefined : byId.get(node.parentId);

        (parent ? parent.children : roots).push(byId.get(node.id));
    }

    for (const item of byId.values()) {
        item.children.sort((a, b) => new Date(a.node.timestamp) - new Date(b.node.timestamp));
    }

    return roots;
}

export class TreeView {
    flat = [];
    rows = [];
    selected = 0;
    filter = "default";
    query = "";
    folded = new Set();
    showLabelTimes = false;
    active = new Set();
    visibleParent = new Map();
    visibleChildren = new Map();
    lastSelectedId = null;
    multipleRoots = false;

    constructor(nodes, leafId) {
        const roots = buildTree(nodes);

        this.leafId = leafId;
        this.byId = new Map(nodes.map((node) => [node.id, node]));
        this.multipleRoots = roots.length > 1;
        this.flat = this.#flatten(roots);

        for (let id = leafId; id && this.byId.has(id); id = this.byId.get(id).parentId) {
            this.active.add(id);
        }

        this.#applyFilter();
        this.selected = this.#nearestVisible(leafId);
        this.lastSelectedId = this.rows[this.selected]?.node.id ?? null;
    }

    #nearestVisible(id) {
        if (this.rows.length === 0) {
            return 0;
        }

        const index = new Map(this.rows.map((row, i) => [row.node.id, i]));

        for (let current = id; current !== null && current !== undefined;) {
            if (index.has(current)) {
                return index.get(current);
            }

            current = this.byId.get(current)?.parentId;
        }

        return this.rows.length - 1;
    }

    #flatten(roots) {
        const result = [];
        const containsActive = new Map();
        const all = [];
        const pre = [...roots];

        while (pre.length > 0) {
            const item = pre.pop();

            all.push(item);

            for (let i = item.children.length - 1; i >= 0; i--) {
                pre.push(item.children[i]);
            }
        }

        for (let i = all.length - 1; i >= 0; i--) {
            const item = all[i];

            containsActive.set(
                item,
                item.node.id === this.leafId ||
                    item.children.some((child) => containsActive.get(child)),
            );
        }

        const ordered = [...roots].sort((a, b) => containsActive.get(b) - containsActive.get(a));
        const stack = ordered.reverse();

        // Only order here. The filtered tree gets its connectors once, in #layout().
        while (stack.length > 0) {
            const item = stack.pop();

            result.push({ node: item.node });
            const children = [
                ...item.children.filter((child) => containsActive.get(child)),
                ...item.children.filter((child) => !containsActive.get(child)),
            ];

            for (let i = children.length - 1; i >= 0; i--) {
                stack.push(children[i]);
            }
        }

        return result;
    }

    #childIndent(indent, justBranched, multipleChildren) {
        return multipleChildren || (justBranched && indent > 0) ? indent + 1 : indent;
    }

    #childGutters(indent, showConnector, isLast, gutters, isVirtualRootChild) {
        if (!showConnector || isVirtualRootChild) {
            return gutters;
        }

        const displayIndent = this.multipleRoots ? Math.max(0, indent - 1) : indent;

        return [...gutters, { position: Math.max(0, displayIndent - 1), show: !isLast }];
    }

    #passes(row) {
        const node = row.node;

        if (node.type === "usage" || (node.toolOnly && node.id !== this.leafId)) {
            return false;
        }

        const settings = SETTINGS.includes(node.type);
        const passes = {
            "user-only": node.role === "user",
            "no-tools": !settings && node.role !== "toolResult",
            "labeled-only": node.label !== undefined,
            all: true,
            default: !settings,
        }[this.filter];
        const tokens = this.query.toLowerCase().split(/\s+/).filter(Boolean);
        const text = node.search.toLowerCase();

        return passes && tokens.every((token) => text.includes(token));
    }

    #applyFilter() {
        if (this.rows.length > 0) {
            this.lastSelectedId = this.rows[this.selected]?.node.id ?? this.lastSelectedId;
        }

        this.rows = this.flat.filter((row) => this.#passes(row));

        if (this.folded.size > 0) {
            const skip = new Set();

            for (const row of this.flat) {
                const parent = row.node.parentId;

                if (parent != null && (this.folded.has(parent) || skip.has(parent))) {
                    skip.add(row.node.id);
                }
            }

            this.rows = this.rows.filter((row) => !skip.has(row.node.id));
        }

        this.#layout();

        if (this.lastSelectedId) {
            this.selected = this.#nearestVisible(this.lastSelectedId);
        } else if (this.selected >= this.rows.length) {
            this.selected = Math.max(0, this.rows.length - 1);
        }
    }

    /** Filtering hides entries; descendants attach to the nearest visible ancestor, as in the terminal. */
    #layout() {
        if (this.rows.length === 0) {
            return;
        }

        const visible = new Set(this.rows.map((row) => row.node.id));
        const visibleParent = new Map();
        const visibleChildren = new Map([[null, []]]);

        for (const row of this.rows) {
            let ancestor = this.byId.get(row.node.parentId)?.id ?? null;

            while (ancestor !== null && !visible.has(ancestor)) {
                ancestor = this.byId.get(this.byId.get(ancestor).parentId)?.id ?? null;
            }

            visibleParent.set(row.node.id, ancestor);

            if (!visibleChildren.has(ancestor)) {
                visibleChildren.set(ancestor, []);
            }

            visibleChildren.get(ancestor).push(row.node.id);
        }

        const roots = visibleChildren.get(null);
        const rowById = new Map(this.rows.map((row) => [row.node.id, row]));
        const stack = [];

        this.multipleRoots = roots.length > 1;

        for (let i = roots.length - 1; i >= 0; i--) {
            const multiple = this.multipleRoots;

            stack.push([
                roots[i],
                multiple ? 1 : 0,
                multiple,
                multiple,
                i === roots.length - 1,
                [],
                multiple,
            ]);
        }

        while (stack.length > 0) {
            const [id, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] =
                stack.pop();
            const row = rowById.get(id);

            Object.assign(row, { indent, showConnector, isLast, gutters, isVirtualRootChild });
            const children = visibleChildren.get(id) ?? [];
            const childGutters = this.#childGutters(
                indent,
                showConnector,
                isLast,
                gutters,
                isVirtualRootChild,
            );

            for (let i = children.length - 1; i >= 0; i--) {
                stack.push([
                    children[i],
                    this.#childIndent(indent, justBranched, children.length > 1),
                    children.length > 1,
                    children.length > 1,
                    i === children.length - 1,
                    childGutters,
                    false,
                ]);
            }
        }

        this.visibleParent = visibleParent;
        this.visibleChildren = visibleChildren;
    }

    #foldable(id) {
        const children = this.visibleChildren.get(id);

        if (!children || children.length === 0) {
            return false;
        }

        const parent = this.visibleParent.get(id);

        return (
            parent === null || parent === undefined || this.visibleChildren.get(parent)?.length > 1
        );
    }

    #segmentStart(direction) {
        const selectedId = this.rows[this.selected]?.node.id;

        if (!selectedId) {
            return this.selected;
        }

        const index = new Map(this.rows.map((row, i) => [row.node.id, i]));
        let current = selectedId;

        if (direction === "down") {
            for (;;) {
                const children = this.visibleChildren.get(current) ?? [];

                if (children.length === 0) {
                    return index.get(current);
                }

                if (children.length > 1) {
                    return index.get(children[0]);
                }

                current = children[0];
            }
        }

        for (;;) {
            const parent = this.visibleParent.get(current) ?? null;

            if (parent === null) {
                return index.get(current);
            }

            if (this.visibleChildren.get(parent).length > 1 && index.get(current) < this.selected) {
                return index.get(current);
            }

            current = parent;
        }
    }

    /** The terminal row: tree prefix, fold marker, active-path dot and label, before the entry text. */
    line(row) {
        const id = row.node.id;
        const displayIndent = this.multipleRoots ? Math.max(0, row.indent - 1) : row.indent;
        const connector = row.showConnector && !row.isVirtualRootChild;
        const folded = this.folded.has(id);
        let prefix = "";

        for (let i = 0; i < displayIndent * 3; i++) {
            const level = Math.floor(i / 3);
            const position = i % 3;
            const gutter = row.gutters.find((each) => each.position === level);

            if (gutter) {
                prefix += position === 0 && gutter.show ? "│" : " ";
            } else if (connector && level === displayIndent - 1) {
                prefix += [
                    row.isLast ? "└" : "├",
                    folded ? "⊞" : this.#foldable(id) ? "⊟" : "─",
                    " ",
                ][position];
            } else {
                prefix += " ";
            }
        }

        return {
            id,
            prefix,
            fold: folded && !connector ? "⊞ " : "",
            active: this.active.has(id) ? "• " : "",
            label: row.node.label ? `[${row.node.label}] ` : "",
            labelTime:
                this.showLabelTimes && row.node.label && row.node.labelTimestamp
                    ? `${labelTime(row.node.labelTimestamp)} `
                    : "",
            parts: row.node.parts,
        };
    }

    status() {
        return `${STATUS[this.filter] ?? ""}${this.showLabelTimes ? " [+label time]" : ""}`;
    }

    move(step) {
        const count = this.rows.length;

        if (count > 0) {
            this.selected = (((this.selected + step) % count) + count) % count;
        }
    }

    page(step) {
        this.selected = Math.max(0, Math.min(this.rows.length - 1, this.selected + step));
    }

    foldOrUp() {
        const id = this.rows[this.selected]?.node.id;

        if (id && this.#foldable(id) && !this.folded.has(id)) {
            this.folded.add(id);
            this.#applyFilter();
        } else {
            this.selected = this.#segmentStart("up");
        }
    }

    unfoldOrDown() {
        const id = this.rows[this.selected]?.node.id;

        if (id && this.folded.has(id)) {
            this.folded.delete(id);
            this.#applyFilter();
        } else {
            this.selected = this.#segmentStart("down");
        }
    }

    /** Ctrl+D sets the default view; the other filter keys toggle their view and the default. */
    setFilter(mode) {
        this.filter = mode === "default" || this.filter === mode ? "default" : mode;
        this.folded.clear();
        this.#applyFilter();
    }

    cycleFilter(step) {
        const index = FILTERS.indexOf(this.filter);

        this.filter = FILTERS[(index + step + FILTERS.length) % FILTERS.length];
        this.folded.clear();
        this.#applyFilter();
    }

    search(query) {
        this.query = query;
        this.folded.clear();
        this.#applyFilter();
    }

    toggleLabelTimes() {
        this.showLabelTimes = !this.showLabelTimes;
    }
}

function labelTime(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;

    if (date.toDateString() === now.toDateString()) {
        return time;
    }

    const day = `${date.getMonth() + 1}/${date.getDate()} ${time}`;

    return date.getFullYear() === now.getFullYear()
        ? day
        : `${String(date.getFullYear()).slice(-2)}/${day}`;
}
