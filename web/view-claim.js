// What a tab says it already holds of a transcript when it connects (`src/server/view-claim.ts` checks it), and how it
// keeps that run when the server agrees. Pure helpers, so the store and the tests use the same code.

/** Must match `src/server/view-claim.ts`: two FNV-1a 32-bit passes over the ids joined by commas. */
export function claimDigest(ids) {
    let a = 0x811c9dc5;
    let b = 0x050c5d1f;
    const text = ids.join(",");

    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);

        a = Math.imul(a ^ code, 0x01000193) >>> 0;
        b = Math.imul(b ^ code, 0x01000193) >>> 0;
    }

    return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/** The most entries one claim names: the newest of the transcript, which a reopened session shows first. */
export const CLAIM_ENTRIES = 400;

/**
 * The claim for a view of conversation `id`, or null: the newest run of its order whose entries the tab holds, named by
 * the server run (`build`) whose projection made them.
 */
export function claimOf(view, id) {
    if (view.conversation?.id !== id || typeof view.build !== "number" || view.order.length === 0) {
        return null;
    }

    let from = view.order.length;

    while (
        from > 0 &&
        view.order.length - from < CLAIM_ENTRIES &&
        view.entries.has(view.order[from - 1])
    ) {
        from--;
    }

    const run = view.order.slice(from);

    return run.length === 0 ? null : `${view.build}.${run[0]}.${run.length}.${claimDigest(run)}`;
}

/** The entries of `held` the server said to keep (`kept`: the first id and length of a run of its new `order`). */
export function keptEntries(held, order, kept) {
    const entries = new Map();
    const from = order.indexOf(kept.first);

    if (from < 0) {
        return entries;
    }

    for (const id of order.slice(from, from + kept.count)) {
        const entry = held.get(id);

        if (entry !== undefined) {
            entries.set(id, entry);
        }
    }

    return entries;
}
