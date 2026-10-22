import assert from "node:assert/strict";
import { test } from "node:test";
import { liveUpdate } from "../src/server/live-delta.ts";
import type { ClientLive } from "../src/server/projection.ts";

const live = (text: string): ClientLive => ({
    busy: true,
    generation: { attempt: 1, message: { blocks: [{ type: "text", text }] } },
});

test("live text sends only the appended suffix, with an exact versioned baseline", () => {
    const first = liveUpdate(undefined, live("a".repeat(6000)));
    const next = liveUpdate(first.snapshot, live("a".repeat(6000) + "new"));

    assert.equal(first.wire.liveVersion, 1);
    assert.equal(first.wire.livePatch, undefined);
    assert.deepEqual(next.wire.livePatch, { base: 1, append: [{ index: 0, at: 6000 }] });
    assert.deepEqual(next.wire.live.generation?.message?.blocks, [{ type: "text", text: "new" }]);
    assert.ok(JSON.stringify(next.wire).length < JSON.stringify(next.snapshot.live).length / 10);
    assert.deepEqual(first.snapshot.live, live("a".repeat(6000)), "no mutation of the baseline");
});

test("replacement, shrink, retry, tool blocks and full snapshots cannot be mistaken for appended text", () => {
    const first = liveUpdate(undefined, live("a".repeat(500)));

    for (const text of ["replacement", "a".repeat(200)]) {
        const next = liveUpdate(first.snapshot, live(text));

        assert.equal(next.wire.livePatch, undefined);
        assert.deepEqual(next.wire.live, live(text));
    }

    const tool: ClientLive = {
        busy: true,
        generation: {
            attempt: 2,
            retry: { at: 1, error: "retry" },
            message: { blocks: [{ type: "toolCall", id: "t", name: "read", args: { path: "x" } }] },
        },
    };

    assert.deepEqual(liveUpdate(first.snapshot, tool).wire.live, tool);
    assert.equal(liveUpdate(first.snapshot, { busy: false }).wire.livePatch, undefined);
    assert.equal(liveUpdate(undefined, first.snapshot.live).wire.livePatch, undefined);
});

test("thinking text and appended blocks preserve all nontext metadata", () => {
    const before: ClientLive = {
        busy: true,
        generation: {
            attempt: 1,
            message: { blocks: [{ type: "thinking", text: "x".repeat(300) }] },
        },
    };
    const next: ClientLive = {
        busy: true,
        generation: {
            attempt: 1,
            message: {
                blocks: [
                    { type: "thinking", text: "x".repeat(300) + "y", redacted: true },
                    { type: "text", text: "answer" },
                ],
            },
        },
    };
    const result = liveUpdate(liveUpdate(undefined, before).snapshot, next);

    assert.deepEqual(result.wire.live.generation?.message?.blocks, [
        { type: "thinking", text: "y", redacted: true },
        { type: "text", text: "answer" },
    ]);
});
