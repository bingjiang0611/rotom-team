/** Append-only live text on the wire; every other field stays a snapshot, including tool calls and retries. */
import type { ClientLive } from "./projection.ts";

export type LivePatch = { base: number; append: { index: number; at: number }[] };
export type LiveSnapshot = { live: ClientLive; version: number };

/** A bounded per-connection baseline. Full views and reconnects always start with a complete live snapshot. */
export function liveUpdate(previous: LiveSnapshot | undefined, live: ClientLive) {
    const version = (previous?.version ?? 0) + 1;
    const append: LivePatch["append"] = [];
    const blocks = live.generation?.message?.blocks.map((block, index) => {
        const before = previous?.live.generation?.message?.blocks[index];

        if (
            (block.type === "text" || block.type === "thinking") &&
            before?.type === block.type &&
            // Small prefixes cost less than the patch metadata. A changed or shortened block is a full replacement.
            before.text.length > 128 &&
            block.text.startsWith(before.text)
        ) {
            append.push({ index, at: before.text.length });

            return { ...block, text: block.text.slice(before.text.length) };
        }

        return block;
    });
    const snapshot: LiveSnapshot = { live, version };

    if (previous && append.length && blocks && live.generation?.message) {
        return {
            snapshot,
            wire: {
                live: { ...live, generation: { ...live.generation, message: { blocks } } },
                liveVersion: version,
                livePatch: { base: previous.version, append },
            },
        };
    }

    return { snapshot, wire: { live, liveVersion: version } };
}
