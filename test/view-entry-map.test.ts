import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

// Exercise the real browser reducer, isolated from its network/navigation startup. The benchmark runs the full page.
const source = readFileSync(new URL("../web/store.js", import.meta.url), "utf8");
const empty = source.slice(
    source.indexOf("const emptyView ="),
    source.indexOf("export const store ="),
);
const apply = source.slice(
    source.indexOf("function applyView(data)"),
    source.indexOf("/** The `moving`"),
);

function reducer() {
    const perf = {
        viewApplyCalls: 0,
        viewApplyMs: 0,
        viewBaseEntryCopies: 0,
        viewDeltaEntries: 0,
        viewPruneChecks: 0,
        viewOrderIds: 0,
    };
    const store = {
        state: { view: undefined as any, templates: null },
        set(change: (state: any) => any) {
            this.state = { ...this.state, ...change(this.state) };
        },
    };
    const context = {
        store,
        window: { __rotomPerf: perf },
        performance,
        Map,
        Set,
        markOpenFinished() {},
    };

    runInNewContext(
        `${empty}\nstore.state.view = emptyView();\n${apply}\nthis.apply = applyView;`,
        context,
    );

    return {
        store,
        perf,
        apply: (context as typeof context & { apply: (data: any) => void }).apply,
    };
}

const view = (entries: any[] = [], extra: Record<string, unknown> = {}) => ({
    conversation: { id: 1 },
    entries,
    live: { busy: false },
    inbox: [],
    agent: null,
    stats: { cost: 0 },
    clients: 1,
    viewers: ["Alice"],
    approvals: [],
    ...extra,
});

test("live-only views reuse entry maps but still publish a new view and fresh live/kernel fields", () => {
    const r = reducer();
    const entry = { id: 1, kind: "user", text: "hello" };

    r.apply(view([entry], { full: true, order: [1], authors: { "1": "Alice" } }));
    const before = r.store.state.view;
    const copies = r.perf.viewBaseEntryCopies;

    r.apply(view([], { live: { busy: true }, kernel: { segmentId: "s", yours: true } }));
    const after = r.store.state.view;

    assert.notEqual(after, before);
    assert.equal(after.entries, before.entries);
    assert.equal(after.order, before.order);
    assert.equal(after.authors, before.authors);
    assert.equal(after.entries.get(1), entry);
    assert.equal(after.live.busy, true);
    assert.equal(before.live.busy, false);
    assert.equal(after.kernel.yours, true);
    assert.equal(r.perf.viewBaseEntryCopies, copies, "a live-only update copies no old entries");
});

test("append, replacement and order-only reset copy maps without mutating prior snapshots", () => {
    const r = reducer();
    const first = { id: 1, kind: "user", text: "first" };
    const second = { id: 2, kind: "assistant", text: "second" };

    r.apply(view([first], { full: true, order: [1] }));
    const before = r.store.state.view;

    r.apply(view([second], { order: [1, 2] }));
    const appended = r.store.state.view;

    assert.notEqual(appended.entries, before.entries);
    assert.equal(before.entries.size, 1);
    assert.equal(appended.entries.size, 2);
    r.apply(view([{ ...first, text: "changed" }]));
    const replaced = r.store.state.view;

    assert.equal(appended.entries.get(1).text, "first");
    assert.equal(replaced.entries.get(1).text, "changed");
    r.apply(view([], { order: [2] }));
    assert.equal(r.store.state.view.entries.size, 1);
    assert.equal(r.store.state.view.entries.get(2), second);
    assert.equal(replaced.entries.size, 2);
    r.apply(view([], { order: [] }));
    assert.equal(r.store.state.view.entries.size, 0);
    assert.ok(r.perf.viewPruneChecks > 0);
});

test("full reconnect and conversation switch discard old maps, including empty transcripts", () => {
    const r = reducer();

    r.apply(view([{ id: 1 }], { full: true, order: [1] }));
    const old = r.store.state.view.entries;

    r.apply(view([], { full: true, order: [] }));
    assert.notEqual(r.store.state.view.entries, old);
    assert.equal(r.store.state.view.entries.size, 0);
    assert.equal(old.size, 1);
    r.apply(view([{ id: 3 }], { conversation: { id: 2 }, order: [3] }));
    const switched = r.store.state.view.entries;

    assert.equal(switched.has(1), false);
    assert.equal(switched.has(3), true);
    r.apply(view([], { conversation: { id: 3 } }));
    assert.notEqual(r.store.state.view.entries, switched);
    assert.equal(r.store.state.view.entries.size, 0);
    assert.equal(switched.has(3), true);
});
