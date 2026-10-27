import assert from "node:assert/strict";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { owner } from "../helpers.ts";
import type { JsonValue } from "@earendil-works/chord";
import type { ConversationId } from "@earendil-works/pi-durable";
import { NATIVE_ENTRY } from "../../src/server/entry-format.ts";
import { measureWebOpen } from "./browser.ts";
import { claimFor } from "./view-claim.ts";
import { type Transcript, viewTab } from "./view-tab.ts";
import { sessionListTab } from "./session-list.ts";
import { WORKLOAD } from "./workload.ts";
import type { ScenarioContext } from "./scenario-context.ts";

/** Measure list-delta correctness, transcript reclaim/reopen, and paged long-history readback. */
export async function runHistoryScenarios(context: ScenarioContext): Promise<void> {
    const { alice, app, base, call, history, ownerToken, quiet, raw, root, scenario, token } =
        context;
    // Four tabs with the full catalogue already loaded: two renames change one row at a time. Setup and first snapshots
    // are outside this window; the renames, resulting pushes, and correctness readback are all inside it.
    const listTabs = Array.from({ length: WORKLOAD.projectionTabs }, () =>
        sessionListTab(base, token, raw),
    );

    try {
        await Promise.all(listTabs.map((tab) => tab.until(() => true)));
        await scenario("sessions.rename.tabs", async () => {
            for (const title of ["Catalogue rename one", "Catalogue rename two"]) {
                await call(`sessions/${history}`, "POST", { title });
                await Promise.all(
                    listTabs.map((tab) =>
                        tab.until((rows) =>
                            rows.some((row) => row.id === history && row.title === title),
                        ),
                    ),
                );
            }

            const expected = raw.stringify(await app.sessions(owner(app)));

            for (const tab of listTabs) {
                assert.equal(
                    raw.stringify(tab.rows),
                    expected,
                    "each tab reconstructs the full list",
                );
            }
        });
    } finally {
        await Promise.all(listTabs.map((tab) => tab.close()));
    }

    // A tab that held the 12-turn session's transcript connects again (a network blip, or a reload with a saved copy) and
    // says which entries it holds. A server that ignores the claim sends them all again; either way the rebuilt
    // transcript must equal the one the tab had, entry for entry.
    const build = ((await call("me")).value as { server: { startedAt: number } }).server.startedAt;
    const holder = viewTab(base, token, raw, history);
    const held = await holder.full;

    await holder.close();
    await quiet();
    await scenario("session.reclaim", async () => {
        const again = viewTab(base, token, raw, history, {
            have: claimFor(build, held.order),
            entries: held.entries,
        });
        const view = await again.full;

        await again.close();
        assert.deepEqual(view.order, held.order);

        for (const id of view.order) {
            assert.deepEqual(view.entries.get(id), held.entries.get(id), `entry ${id}`);
        }
    });

    // Coming back to a session opened before in this browser: until the page shows the server's own view.
    const reopen = await measureWebOpen({
        base,
        ownerToken,
        sessionId: history,
        marker: `END-OF-ANSWER-${WORKLOAD.seededTurns}`,
        quiet,
        profile: join(root, "perf-browser-reopen"),
        reopen: true,
    });

    context.results.push(
        "unavailable" in reopen
            ? { scenario: "web.reopen", unavailable: reopen.unavailable }
            : {
                  scenario: "web.reopen",
                  ms: reopen.ms,
                  counts: reopen.counts,
                  extra: reopen.metrics,
              },
    );

    // A long history, seeded as the native mirror stores it (no model): opening it, then reading all of it.
    const long = (await call("sessions", "POST", { title: "Long", backend: "rotom" })).value
        .id as unknown as ConversationId;

    await app.harness.commit(async (tx) => {
        for (let turn = 1; turn <= WORKLOAD.longTurns; turn++) {
            const parent = turn === 1 ? null : `long-answer-${turn - 1}`;

            await tx.appendEntry(long, {
                kind: NATIVE_ENTRY,
                data: {
                    entry: {
                        type: "message",
                        id: `long-question-${turn}`,
                        parentId: parent,
                        message: {
                            role: "user",
                            timestamp: turn,
                            content: `Long question ${turn}?`,
                        },
                    },
                } as JsonValue,
            });
            await tx.appendEntry(long, {
                kind: NATIVE_ENTRY,
                data: {
                    entry: {
                        type: "message",
                        id: `long-answer-${turn}`,
                        parentId: `long-question-${turn}`,
                        message: {
                            role: "assistant",
                            timestamp: turn,
                            stopReason: "stop",
                            content: [
                                {
                                    type: "text",
                                    text: `LONG-ANSWER-${turn} `.padEnd(
                                        WORKLOAD.longAnswerChars,
                                        "x",
                                    ),
                                },
                            ],
                        },
                    },
                } as JsonValue,
            });
        }
    }, BACKGROUND_CONTEXT);

    // The reference: an unpaged view of the same history, outside every window.
    const reference = viewTab(base, token, raw, long as unknown as number);
    const whole = await reference.full;

    await reference.close();
    // The server learns that an event stream closed when it next writes to it; push once, so the reference tab has left
    // before the window opens instead of whenever the next write happens to fall (inside the window or not).
    app.roomChanged(long);

    for (let waited = 0; app.watching(alice.id, long) && waited < 5_000; waited += 20) {
        await new Promise((resolve) => setTimeout(resolve, 20));
    }

    assert.equal(app.watching(alice.id, long), false, "the reference tab has left");
    await quiet();

    let longTab: ReturnType<typeof viewTab> | undefined;
    let opened: Transcript & { kept: number };

    try {
        await scenario("session.open.long", async () => {
            longTab = viewTab(
                base,
                token,
                raw,
                long as unknown as number,
                undefined,
                `&tail=${WORKLOAD.longTail}`,
            );
            opened = await longTab.full;
            assert.deepEqual(opened.order, whole.order, "the whole order, whatever is sent");
            assert.equal(opened.order.at(-1), whole.order.at(-1));
            assert.ok(opened.entries.has(whole.order.at(-1)!), "the newest entry is there");

            for (const [id, entry] of opened.entries) {
                assert.deepEqual(entry, whole.entries.get(id), `entry ${id}`);
            }
        });
        // Read back what the tab lacks, newest page first, as scrolling up does; a tab that has everything asks nothing.
        await scenario("session.history.earlier", async () => {
            const held = opened.entries;
            let bytes = 0;

            for (let page = 0; page < 1000; page++) {
                const first = opened.order.findIndex((id) => held.has(id));

                if (first <= 0) {
                    break;
                }

                const response = await fetch(
                    `${base}/api/c/${long}/entries?before=${opened.order[first]}`,
                    { headers: { authorization: `Bearer ${token}` } },
                );
                const text = await response.text();

                assert.equal(response.status, 200, text);
                bytes += Buffer.byteLength(text);

                const { entries } = raw.parse(text) as { entries: { id: number }[] };

                assert.ok(entries.length > 0, "a page makes progress");

                for (const entry of entries) {
                    held.set(entry.id, entry);
                }
            }

            assert.deepEqual(
                opened.order.filter((id) => !held.has(id)),
                [],
                "the tab holds the whole history",
            );

            for (const id of opened.order) {
                assert.deepEqual(held.get(id), whole.entries.get(id), `entry ${id}`);
            }

            return { "http.body.bytes": bytes };
        });
    } finally {
        await longTab?.close();
    }

    const webLong = await measureWebOpen({
        base,
        ownerToken,
        sessionId: long as unknown as number,
        marker: `LONG-ANSWER-${WORKLOAD.longTurns} `,
        quiet,
        profile: join(root, "perf-browser-long"),
    });

    context.results.push(
        "unavailable" in webLong
            ? { scenario: "web.open.long", unavailable: webLong.unavailable }
            : {
                  scenario: "web.open.long",
                  ms: webLong.ms,
                  counts: webLong.counts,
                  extra: webLong.metrics,
              },
    );
}
