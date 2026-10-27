import { store, emptyView } from "./store-state.js";
import { keptEntries } from "./view-claim.js";
import { markOpenFinished, warmSession } from "./store-views.js";

function applyView(data, resync) {
    const perf = window.__rotomPerf;
    const started = perf ? performance.now() : 0;
    const becameReady =
        store.state.view.kernel?.initializing === true && data.kernel?.initializing === false;

    if (data.livePatch) {
        const before = store.state.view;
        const blocks = data.live?.generation?.message?.blocks;
        const append = data.livePatch.append;
        const valid =
            !data.full &&
            before.conversation?.id === data.conversation.id &&
            before.liveVersion === data.livePatch.base &&
            data.liveVersion === data.livePatch.base + 1 &&
            Array.isArray(blocks) &&
            Array.isArray(append) &&
            append.every(({ index, at }) => {
                const old = before.live?.generation?.message?.blocks[index];
                const next = blocks[index];

                return (
                    (next?.type === "text" || next?.type === "thinking") &&
                    old?.type === next.type &&
                    old.text.length === at
                );
            });

        if (!valid) {
            // A lost baseline must not produce truncated or concatenated text. Get a fresh full snapshot, read only.
            resync();

            return;
        }

        const joined = [...blocks];

        for (const { index } of append) {
            joined[index] = {
                ...blocks[index],
                text: before.live.generation.message.blocks[index].text + blocks[index].text,
            };
        }

        data = {
            ...data,
            live: {
                ...data.live,
                generation: { ...data.live.generation, message: { blocks: joined } },
            },
        };
    }

    let baseEntryCopies = 0;
    let deltaEntries = 0;
    let pruneChecks = 0;
    let orderIds = 0;

    store.set((state) => {
        const sameConversation = state.view.conversation?.id === data.conversation.id;
        // A full view that keeps a run the tab claimed starts from that run of what the tab held, and nothing else.
        const base =
            data.full && data.kept && sameConversation
                ? {
                      ...emptyView(),
                      entries: keptEntries(state.view.entries, data.order, data.kept),
                  }
                : data.full || !sameConversation
                  ? emptyView()
                  : state.view;
        // Live/status-only updates do not change transcript entries. Keep their immutable Map instead of copying it.
        const changesEntries = data.entries.length > 0 || data.order !== undefined;
        const entries = changesEntries ? new Map(base.entries) : base.entries;

        baseEntryCopies = changesEntries ? base.entries.size : 0;
        deltaEntries = data.entries.length;

        for (const entry of data.entries) {
            entries.set(entry.id, entry);
        }

        const order = data.order ?? base.order;

        if (data.order) {
            const keep = new Set(data.order);

            orderIds = data.order.length;

            for (const id of entries.keys()) {
                pruneChecks++;

                if (!keep.has(id)) {
                    entries.delete(id);
                }
            }
        }

        return {
            ...(state.view.kernel?.segmentId !== data.kernel?.segmentId
                ? { templates: null }
                : state.templates &&
                    (state.templates.revision ?? null) !== (data.kernel?.commandsRevision ?? null)
                  ? {
                        templates: {
                            ...state.templates,
                            at: 0,
                            freshness: "configuration-changed",
                        },
                    }
                  : {}),
            view: {
                ...base,
                conversation: data.conversation,
                entries,
                order,
                live: data.live,
                liveVersion: data.liveVersion,
                inbox: data.inbox,
                agent: data.agent,
                stats: data.stats,
                clients: data.clients,
                viewers: data.viewers,
                approvals: data.approvals,
                // The server sends these again only when they change: a missing one keeps its last value.
                artifacts: data.artifacts ?? base.artifacts,
                subagents: data.subagents ?? base.subagents,
                authors: data.authors ?? base.authors,
                reactions: data.reactions ?? base.reactions,
                pins: data.pins ?? base.pins,
                turns: data.turns ?? base.turns,
                decisions: data.decisions ?? base.decisions,
                readOnly: data.readOnly === undefined ? base.readOnly : data.readOnly,
                plan: data.plan ?? base.plan,
                schedules: data.schedules ?? base.schedules,
                // No goal is null, which the server sends too: only a missing field keeps the last value.
                goal: data.goal === undefined ? base.goal : data.goal,
                nativeGoal: data.nativeGoal === undefined ? base.nativeGoal : data.nativeGoal,
                // What the folder has checked out: `{ branch }` or `{ detached }`, and null outside a repository.
                branch: data.branch === undefined ? base.branch : data.branch,
                kernel: data.kernel ?? null,
                checking: false,
                build: data.full ? (state.server?.startedAt ?? null) : base.build,
            },
            missing: null,
        };
    });

    // The server keeps what the claim named; should the tab not hold all of it after all, connect again for everything.
    // Entries before `start` were not sent: the tab reads them when it needs them.
    if (
        data.full &&
        data.kept &&
        store.state.view.order
            .slice(data.start ?? 0)
            .some((id) => !store.state.view.entries.has(id))
    ) {
        resync();
    }

    if (perf) {
        perf.viewApplyCalls++;
        perf.viewApplyMs += performance.now() - started;
        perf.viewBaseEntryCopies += baseEntryCopies;
        perf.viewDeltaEntries += deltaEntries;
        perf.viewPruneChecks += pruneChecks;
        perf.viewOrderIds += orderIds;
    }

    markOpenFinished();

    if (data.full || becameReady) {
        warmSession();
    }
}

/** The `moving` marks that a session list has not caught up with yet: it still shows those sessions where they were. */
export function stillMoving(moving, sessions) {
    const next = { ...moving };

    for (const session of sessions) {
        if (next[session.id] === Boolean(session.archived)) {
            delete next[session.id];
        }
    }

    return next;
}

/** What the server sends, by event name. Both transports deliver the same events. */
/** A full-list request on the current stream is pending; deltas are ignored until its snapshot arrives. */

export { applyView };
