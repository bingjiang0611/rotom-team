// A tab's claim of the entries it holds: the same digest everywhere, strict matching, and a room that sends only the rest.
import {
    cleanUp,
    context,
    fakeTab,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { projectEntry } from "../src/server/projection.ts";
import { claimDigest, claimedRun, parseClaim } from "../src/server/view-claim.ts";
import * as bench from "./perf/view-claim.ts";

after(cleanUp);
const WEB: string = "../web/view-claim.js";
const web = await import(WEB);

test("server, browser and benchmark compute the same claim digest", () => {
    const runs = [
        [],
        [1],
        [1, 2, 3],
        [10, 200, 3000, 40000],
        Array.from({ length: 500 }, (_, i) => i * 7 + 1),
    ];

    for (const run of runs) {
        assert.equal(web.claimDigest(run), claimDigest(run));
        assert.equal(bench.claimDigest(run), claimDigest(run));
    }

    assert.notEqual(claimDigest([1, 2, 3]), claimDigest([1, 3, 2]), "order matters");
    assert.notEqual(claimDigest([12, 3]), claimDigest([1, 23]), "ids are separated");
    assert.match(claimDigest([5]), /^[0-9a-f]{16}$/);
});

test("a claim is parsed strictly and matches only its exact run from this server run", () => {
    const order = [4, 7, 9, 12, 15];
    const raw = bench.claimFor(1000, [7, 9, 12]);
    const claim = parseClaim(raw)!;

    assert.deepEqual(claim, { build: "1000", first: 7, count: 3, digest: claimDigest([7, 9, 12]) });
    assert.deepEqual(claimedRun(claim, 1000, order), [7, 9, 12]);
    assert.equal(claimedRun(claim, 1001, order), undefined, "another server run");
    assert.equal(claimedRun(claim, 1000, [4, 7, 9, 11, 15]), undefined, "another run of ids");
    assert.equal(claimedRun(claim, 1000, [4, 9, 12]), undefined, "first id gone");
    assert.equal(claimedRun(claim, 1000, [4, 7, 9]), undefined, "past the end");
    assert.equal(claimedRun({ ...claim, count: 2 }, 1000, order), undefined, "count is digested");

    for (const bad of [
        null,
        "",
        "1000.7.0.0123456789abcdef",
        "1000.7.3.0123456789ABCDEF",
        "1000.7.3.0123",
        "x.7.3.0123456789abcdef",
        "1000.7.3.0123456789abcdef.extra",
        `${"9".repeat(17)}.7.3.0123456789abcdef`,
        "1000.7.12345678.0123456789abcdef",
    ]) {
        assert.equal(parseClaim(bad), undefined, String(bad));
    }
});

test("the browser claims its newest held run and keeps only what the server names", () => {
    const entries = new Map([2, 3, 5, 8].map((id) => [id, { id }]));
    const view = { conversation: { id: 1 }, build: 99, order: [1, 2, 3, 5, 8], entries };

    // Entry 1 is not held: the run is the newest held ones, 2..8.
    assert.equal(web.claimOf(view, 1), bench.claimFor(99, [2, 3, 5, 8]));
    assert.equal(web.claimOf(view, 2), null, "another session");
    assert.equal(web.claimOf({ ...view, build: null }, 1), null, "no server run known");
    assert.equal(web.claimOf({ ...view, order: [] }, 1), null);

    const long = Array.from({ length: 450 }, (_, i) => i + 1);
    const claim = web.claimOf(
        { ...view, order: long, entries: new Map(long.map((id) => [id, { id }])) },
        1,
    );

    assert.equal(
        claim,
        bench.claimFor(99, long.slice(-web.CLAIM_ENTRIES)),
        "bounded to the newest",
    );

    const kept = web.keptEntries(entries, [3, 5, 8, 13], { first: 5, count: 2 });

    assert.deepEqual([...kept.keys()], [5, 8], "only the named run, never held entries outside it");
    assert.equal(web.keptEntries(entries, [3, 5], { first: 21, count: 1 }).size, 0);
});

async function append(app: Awaited<ReturnType<typeof openApp>>, id: ConversationId, text: string) {
    return app.harness.commit(
        (tx) =>
            tx.appendEntry(id, {
                kind: "pi.user",
                model: [{ role: "user", content: text, timestamp: 1 }],
            }),
        context,
    );
}

test("a room sends only what a valid claim lacks, once, and everything for any other claim", async () => {
    const app = await openApp(scriptedModel(), join(root, "claims"));

    try {
        const id = await newSession(app);

        for (const text of ["one", "two", "three"]) {
            await append(app, id, text);
        }

        const room = await app.room(id);
        const all = room.value!.entries.flatMap((entry) => projectEntry(entry) ?? []);
        const order = all.map((entry) => entry.id);
        const held = order.slice(0, 2);

        const fullWith = (have: string | undefined) => {
            const tab = fakeTab(id, owner(app));

            tab.client.viewClaim = parseClaim(have ?? null);
            room.push(tab.client, true);

            return tab;
        };

        const claimed = fullWith(bench.claimFor(app.startedAt, held));
        const view = claimed.last("view")!;

        assert.deepEqual(view.kept, { first: held[0], count: 2 });
        assert.deepEqual(view.order, order, "the whole order still comes");
        assert.deepEqual(view.entries, all.slice(2), "only entries the tab lacks");
        assert.equal(claimed.client.viewClaim, undefined, "a claim is used up");

        await append(app, id, "four");
        room.push(claimed.client, false);
        const added = claimed.last("view")!;

        assert.equal((added.entries as unknown[]).length, 1, "later updates are deltas as before");
        assert.ok(!("kept" in added));
        room.push(claimed.client, true);
        assert.equal(
            (claimed.last("view")!.entries as unknown[]).length,
            order.length + 1,
            "a later full view sends everything: the claim no longer applies",
        );

        const fresh = room.value!.entries.flatMap((entry) => projectEntry(entry) ?? []);

        for (const have of [
            bench.claimFor(app.startedAt + 1, held),
            bench.claimFor(app.startedAt, [held[1]!, held[0]!]),
            `${app.startedAt}.${held[0]}.2.0000000000000000`,
            "nonsense",
            undefined,
        ]) {
            const view = fullWith(have).last("view")!;

            assert.ok(!("kept" in view), String(have));
            assert.deepEqual(view.entries, fresh, `${have}: everything`);
        }
    } finally {
        await app.close();
    }
});
