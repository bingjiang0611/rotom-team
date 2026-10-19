// Browser projection of pi-context-view 0.1.25's usage-map.ts and usage-view.ts.
// Keep allocation/rounding in parity with the pinned native implementation (test/native-context.test.ts).
export const contextTokens = (value) => {
    if (!Number.isFinite(value)) {
        return "unknown";
    }

    const compact = (number) => number.toFixed(1).replace(/\.0$/, "");

    return value < 1_000
        ? String(value)
        : value < 1_000_000
          ? `${compact(value / 1_000)}k`
          : `${compact(value / 1_000_000)}M`;
};

export function contextPercent(tokens, total) {
    if (!Number.isFinite(tokens) || !Number.isFinite(total) || total <= 0) {
        return "unknown";
    }

    const percent = (tokens / total) * 100;

    return percent >= 10 ? `${Math.round(percent)}%` : `${percent.toFixed(1).replace(/\.0$/, "")}%`;
}

export function contextSpace(context) {
    const window = context.reported?.contextWindow;

    if (!Number.isFinite(window) || window <= 0) {
        return {};
    }

    const buffer = Math.min(
        context.autoCompactReserveTokens ?? 0,
        Math.max(0, window - context.estimatedTokens),
    );

    return { buffer, free: Math.max(0, window - context.estimatedTokens - buffer) };
}

export const contextColor = (id) =>
    ({
        "system-prompt": "var(--warn)",
        "context-files": "var(--ok)",
        skills: "var(--o-magenta)",
        "built-in-tools": "var(--warn)",
        "custom-tools": "var(--accent)",
        "mcp-tools": "var(--o-cyan)",
        "user-messages": "var(--brand)",
        "assistant-messages": "var(--warn)",
        "assistant-thinking": "var(--o-red)",
        "tool-calls": "var(--o-cyan)",
        "tool-output": "var(--body)",
        extensions: "var(--ok)",
        "compacted-data": "var(--o-magenta)",
    })[id] ?? "var(--muted)";

const overlap = (start, end, otherStart, otherEnd) =>
    Math.max(0, Math.min(end, otherEnd) - Math.max(start, otherStart));
const clamp = (value, max) => (Number.isFinite(value) ? Math.min(max, Math.max(0, value)) : 0);

// A cell shows its largest category overlap; mixed/boundary cells have a partial fill.
// Buffer belongs at the END of the window, after free space, never directly after used space.
export function buildContextMap(context, columns = 16, rows = 16) {
    const window = context.reported?.contextWindow;

    if (!Number.isFinite(window) || window <= 0 || columns <= 0 || rows <= 0) {
        return undefined;
    }

    columns = Math.floor(columns);
    rows = Math.floor(rows);
    const count = columns * rows;
    const categories = context.categories ?? [];
    const total = categories.reduce((sum, category) => sum + category.tokens, 0);
    const occupied = (clamp(total, window) / window) * count;
    const buffer = clamp(context.autoCompactReserveTokens ?? 0, window - clamp(total, window));
    const bufferStart = ((window - buffer) / window) * count;
    let cursor = 0;
    const segments = categories.map((category) => {
        const start = cursor;

        cursor += total > 0 ? (category.tokens / total) * occupied : 0;

        return { id: category.id, start, end: cursor };
    });
    const cells = Array.from({ length: count }, (_, index) => {
        if (overlap(index, index + 1, 0, occupied) <= 0) {
            return {
                fill: overlap(index, index + 1, bufferStart, index + 1) >= 0.5 ? "buffer" : "free",
            };
        }

        let categoryId;
        let largest = 0;

        for (const segment of segments) {
            const shared = overlap(index, index + 1, segment.start, segment.end);

            if (shared > largest) {
                categoryId = segment.id;
                largest = shared;
            }
        }

        return { categoryId, fill: largest >= 0.7 ? "full" : "partial" };
    });

    return { columns, rows, blockTokens: window / count, cells };
}
