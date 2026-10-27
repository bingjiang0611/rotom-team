import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../web/store-views.js", import.meta.url), "utf8");
const warm = source.slice(
    source.indexOf("const warmedAt ="),
    source.indexOf("/** Entries that show as transcript rows."),
);

test("open warming keeps ownership, visibility, authoritative-view and steering gates, and deduplicates focus", async () => {
    let now = 1_000_000;
    let calls = 0;
    let steer = true;
    let admitted = true;
    const state: any = {
        conversationId: 1,
        view: {
            conversation: { id: 1 },
            kernel: { yours: true },
            live: { busy: false },
            checking: false,
        },
    };
    const context = {
        store: { state },
        document: { hidden: false },
        Date: { now: () => now },
        canSteer: () => steer,
        api: () => {
            calls++;

            return Promise.resolve({ warmed: admitted });
        },
        warmSession: undefined as unknown as () => void,
    };

    runInNewContext(warm.replace("export function warmSession", "function warmSession"), context);

    for (const [object, field, value] of [
        [context.document, "hidden", true],
        [state.view, "checking", true],
        [state.view.kernel, "yours", false],
        [state.view.kernel, "initializing", true],
        [state.view.live, "busy", true],
        [state, "conversationId", 2],
    ] as [any, string, unknown][]) {
        const previous = object[field];

        object[field] = value;
        context.warmSession();
        assert.equal(calls, 0, `${field} blocks a warm request`);
        object[field] = previous;
    }

    steer = false;
    context.warmSession();
    assert.equal(calls, 0);
    steer = true;
    context.warmSession();
    assert.equal(calls, 1);
    context.warmSession();
    assert.equal(calls, 1, "focus after open shares the same deduplication");
    now += 4 * 60_000;
    context.warmSession();
    assert.equal(calls, 2);
    await Promise.resolve();
    now += 4 * 60_000;
    admitted = false;
    context.warmSession();
    await Promise.resolve();
    assert.equal(calls, 3);
    admitted = true;
    context.warmSession();
    assert.equal(
        calls,
        4,
        "a declined open warm does not suppress a later composer-focus fallback",
    );
});
