import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

// Exercise the real browser reducer, isolated from its network/navigation startup. The benchmark runs the full page.
const stateSource = readFileSync(new URL("../web/store-state.js", import.meta.url), "utf8");
const projectionSource = readFileSync(
    new URL("../web/store-projection.js", import.meta.url),
    "utf8",
);
const transportSource = readFileSync(new URL("../web/store-transport.js", import.meta.url), "utf8");
const empty = stateSource
    .slice(
        stateSource.indexOf("export const emptyView ="),
        stateSource.indexOf("export const store ="),
    )
    .replace("export const emptyView", "const emptyView")
    .replace("export function savedView", "function savedView");
const apply = projectionSource.slice(
    projectionSource.indexOf("function applyView(data, resync)"),
    projectionSource.indexOf("/** The `moving`"),
);
const resync = transportSource.slice(
    transportSource.indexOf("function resyncView()"),
    transportSource.indexOf("export function connect()"),
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
        warmCalls: 0,
        warmSession() {
            context.warmCalls++;
        },
        unclaimed: false,
        reconnects: 0,
        connect() {
            context.reconnects++;
        },
    };

    runInNewContext(
        `${empty}\nstore.state.view = emptyView();\n${apply}\n${resync}\nthis.apply = (data) => applyView(data, resyncView);`,
        context,
    );

    return {
        store,
        perf,
        context,
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

test("versioned live text patches reconstruct immutable snapshots and reject missing baselines", () => {
    const r = reducer();
    const live = (text: string) => ({
        busy: true,
        generation: { attempt: 1, message: { blocks: [{ type: "text", text }] } },
    });

    r.apply(view([], { full: true, order: [], live: live("prefix"), liveVersion: 1 }));
    const before = r.store.state.view;
    const patch = { base: 1, append: [{ index: 0, at: 6 }] };

    r.apply(view([], { live: live(" suffix"), liveVersion: 2, livePatch: patch }));
    assert.equal(r.store.state.view.live.generation.message.blocks[0].text, "prefix suffix");
    assert.equal(before.live.generation.message.blocks[0].text, "prefix");
    assert.equal(r.context.reconnects, 0);
    const confirmed = r.store.state.view;

    r.apply(view([], { live: live(" suffix"), liveVersion: 2, livePatch: patch }));
    assert.equal(
        r.context.reconnects,
        1,
        "a repeated or missed patch reconnects without applying it",
    );
    assert.equal(r.store.state.view, confirmed);
    r.apply(view([], { full: true, order: [], live: live("complete"), liveVersion: 1 }));
    assert.equal(r.store.state.view.live.generation.message.blocks[0].text, "complete");
    r.apply(
        view([], {
            live: live("x"),
            liveVersion: 2,
            livePatch: { base: 1, append: [{ index: 0, at: 99 }] },
        }),
    );
    assert.equal(r.context.reconnects, 2, "a wrong prefix length cannot silently truncate text");
    assert.equal(r.store.state.view.live.generation.message.blocks[0].text, "complete");
});

test("an initializing open retries warming only on authoritative readiness, not every incremental update", () => {
    const r = reducer();

    r.apply(view([], { full: true, order: [], kernel: { initializing: true } }));
    assert.equal(r.context.warmCalls, 1);
    r.apply(view([], { kernel: { initializing: false } }));
    assert.equal(
        r.context.warmCalls,
        2,
        "readiness after the initial full view is an open trigger too",
    );
    r.apply(view([], { kernel: { initializing: false } }));
    assert.equal(r.context.warmCalls, 2, "ordinary streaming updates cannot cause warm requests");
});
