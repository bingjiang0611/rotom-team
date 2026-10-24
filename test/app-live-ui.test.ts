// Real Team UI in Chromium. Store updates carry fresh wire metadata, not accidentally shared fixture objects.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { cleanUp } from "./helpers.ts";
import { withAppPage } from "./fixtures/app-browser.ts";

after(cleanUp);

test("only high-frequency live data uses Transcript's local subscription", async (t) => {
    await withAppPage(async (evaluate) => {
        for (const kind of ["text", "thinking", "tool"]) {
            await t.test(
                `${kind}: 20 visible updates without 20 unrelated component commits`,
                async () => {
                    const counts = await evaluate(
                        `appCommitFixture.measure(${JSON.stringify(kind)})`,
                    );

                    assert.deepEqual(counts, {
                        App: 0,
                        Transcript: 20,
                        Topbar: 0,
                        SessionList: 0,
                        Composer: 0,
                        NativeBanner: 0,
                        Notices: 0,
                    });
                    const result = await evaluate(`(async () => {
                    const kind = ${JSON.stringify(kind)};
                    if (kind === 'thinking') document.querySelector('.thought-head').click();
                    if (kind === 'tool') document.querySelector('.tool-head').click();
                    await appCommitFixture.flush();
                    return document.querySelector('.transcript').textContent;
                })()`);

                    assert.match(result, new RegExp(`D4-${kind}-19`));
                },
            );
        }

        await t.test(
            "the root selector never hides non-live, busy, identity or permission changes",
            async () => {
                const result = await evaluate(`(async () => {
                const { liveOnlyChange } = await import('/store.js');
                const before = appCommitFixture.state();
                const next = () => ({ ...before, view: { ...before.view, live: { ...before.view.live } } });
                const cases = [];
                const check = (name, change) => { const after = next(); change(after); cases.push([name, liveOnlyChange(before, after)]); };
                check('busy', s => s.view.live.busy = !before.view.live.busy);
                check('permission', s => s.me = { ...s.me, role: 'viewer' });
                check('missing', s => s.missing = 'Access removed');
                check('connection', s => s.connection = 'closed');
                check('route', s => s.conversationId = null);
                check('notices', s => s.notices = []);
                check('entries', s => s.view.entries = new Map(before.view.entries));
                check('order', s => s.view.order = [...before.view.order]);
                check('artifact', s => s.view.artifacts = []);
                check('title', s => s.view.conversation = { ...s.view.conversation, title: 'new' });
                check('payer', s => s.view.kernel = { ...s.view.kernel, memberId: 'another-member' });
                check('unknown', s => s.view.kernel = { ...s.view.kernel, pending: { status: 'unknown' } });
                check('statuses', s => s.view.kernel = { ...s.view.kernel, statuses: { changed: 'changed' } });
                check('dialogs', s => s.view.kernel = { ...s.view.kernel, dialogs: [{ id: 'new' }] });
                check('widgets', s => s.view.kernel = { ...s.view.kernel, widgets: { changed: ['new'] } });
                check('cost', s => s.view.stats = { ...s.view.stats, cost: 900 });
                check('agent', s => s.view.agent = { ...s.view.agent, cwd: '/changed' });
                check('viewers', s => s.view.viewers = ['new-viewer']);
                check('approvals', s => s.view.approvals = [{ id: 99 }]);
                check('inbox', s => s.view.inbox = [{ id: 99, text: 'queued' }]);
                check('array-kind', s => s.view.inbox = {});
                check('new-key', s => s.view.extra = undefined);
                check('removed-key', s => delete s.view.kernel);
                cases.push(['theme/no-op notification', liveOnlyChange(before, before)]);
                check('key-order', s => s.view.kernel = Object.fromEntries(Object.entries(before.view.kernel).reverse()));
                const fresh = next();
                fresh.view.kernel = JSON.parse(JSON.stringify(before.view.kernel));
                return { cases, equalJson: liveOnlyChange(before, fresh) };
            })()`);

                assert.equal(
                    result.equalJson,
                    true,
                    "fresh wire JSON with equal values and iteration order",
                );

                for (const [name, skipped] of result.cases) {
                    assert.equal(skipped, false, name);
                }
            },
        );

        await t.test(
            "busy, native status, title, permissions and final entries still reach the whole UI",
            async () => {
                const result = await evaluate(`(async () => {
                const f = appCommitFixture;
                const { store } = await import('/store.js');
                const original = store.state;
                f.update({ busy: false }); await f.flush();
                const idle = !document.querySelector('.composer [aria-label="Stop"]');
                f.reset(); f.update({ busy: true }); await f.flush();
                const running = Boolean(document.querySelector('.composer [aria-label="Stop"]'));
                const busyCommits = f.counts().App;
                f.update({ busy: true }, { kernel: { ...store.state.view.kernel, statuses: { d4: 'D4 native status' } },
                    conversation: { ...store.state.view.conversation, title: 'D4 fresh title' } });
                await f.flush();
                const status = document.querySelector('[data-status-key="d4"]')?.textContent;
                const title = document.title;
                f.update({ busy: true }, { kernel: { ...store.state.view.kernel, statuses: { first: 'one', second: 'two' } } });
                await f.flush();
                f.update({ busy: true }, { kernel: { ...store.state.view.kernel, statuses: { second: 'two', first: 'one' } } });
                await f.flush();
                const statusOrder = [...document.querySelectorAll('[data-status-key]')].map(node => node.dataset.statusKey);
                store.set({ me: { ...store.state.me, role: 'viewer' } }); await f.flush();
                const readonly = !document.querySelector('.composer [aria-label="Stop"]');
                store.set({ me: original.me }); await f.flush();
                const entry = { id: 900001, kind: 'assistant', blocks: [{ type: 'text', text: 'D4 final entry' }] };
                f.update({ busy: false }, { entries: new Map([[entry.id, entry]]), order: [entry.id] });
                await f.flush();
                const final = document.querySelector('.transcript').textContent;
                const stopped = !document.querySelector('.composer [aria-label="Stop"]');
                const icon = document.querySelector('link[rel="icon"]').getAttribute('href');
                store.set(original); await f.flush();
                return { idle, running, busyCommits, status, title, statusOrder, readonly, final, stopped, icon };
            })()`);

                assert.equal(result.idle, true);
                assert.equal(result.running, true);
                assert.equal(result.busyCommits, 1);
                assert.equal(result.status, "D4 native status");
                assert.equal(result.title, "D4 fresh title · rotom team");
                assert.deepEqual(result.statusOrder, ["second", "first"]);
                assert.equal(result.readonly, true);
                assert.match(result.final, /D4 final entry/);
                assert.equal(result.stopped, true);
                assert.equal(result.icon, "/icon.svg");
            },
        );

        await t.test(
            "queued root work uses the latest live state and preserves existing listener order",
            async () => {
                const result = await evaluate(`(async () => {
                const f = appCommitFixture;
                const { store } = await import('/store.js');
                f.update({ busy: true }); await f.flush();
                const originalListeners = [...store.listeners];
                const events = [];
                const a = store.subscribe(() => events.push('a'));
                const b = store.subscribe(() => events.push('b'));
                f.reset();
                store.set({ notices: [{ id: 98765, level: 'info', message: 'D4 root notice' }] });
                f.update({ busy: true, generation: { message: { blocks: [{ type: 'text', text: 'D4 intermediate' }] } } });
                f.update({ busy: true, generation: { message: { blocks: [{ type: 'text', text: 'D4 latest' }] } } });
                await f.flush();
                const counts = f.counts();
                const text = document.querySelector('.transcript').textContent;
                const notice = document.querySelector('.notices').textContent;
                a(); b();
                const sameOrder = [...store.listeners].every((listener, i) => listener === originalListeners[i]);
                const sameCount = store.listeners.size === originalListeners.length;
                store.set({ notices: [] }); await f.flush();
                return { counts, text, notice, events, sameOrder, sameCount };
            })()`);

                assert.equal(result.counts.App, 1);
                assert.equal(result.counts.Transcript, 1);
                assert.match(result.text, /D4 latest/);
                assert.doesNotMatch(result.text, /D4 intermediate/);
                assert.match(result.notice, /D4 root notice/);
                assert.deepEqual(result.events, ["a", "b", "a", "b", "a", "b"]);
                assert.equal(result.sameOrder, true);
                assert.equal(result.sameCount, true);
            },
        );

        await t.test(
            "unmount removes the local subscriber, remount catches up, and no-op invalidation still works",
            async () => {
                const result = await evaluate(`(async () => {
                const f = appCommitFixture;
                const { store } = await import('/store.js');
                const original = store.state;
                const listeners = [...store.listeners];
                const sizes = [];
                for (let i = 0; i < 3; i++) {
                    store.set({ me: null }); await f.flush();
                    sizes.push(store.listeners.size);
                    f.update({ busy: true, generation: { message: { blocks: [{ type: 'text', text: 'D4 while unmounted' }] } } });
                    store.set({ me: original.me }); await f.flush();
                    sizes.push(store.listeners.size);
                }
                const remaining = listeners.filter(listener => store.listeners.has(listener));
                const unchangedOrder = [...store.listeners].filter(listener => remaining.includes(listener)).every((listener, i) => listener === remaining[i]);
                const text = document.querySelector('.transcript').textContent;
                f.reset(); store.set({}); await f.flush();
                return { initial: listeners.length, sizes, unchangedOrder, text, commits: f.counts().App };
            })()`);

                assert.deepEqual(
                    result.sizes,
                    Array.from({ length: 3 }, () => [result.initial - 1, result.initial]).flat(),
                );
                assert.equal(result.unchangedOrder, true);
                assert.match(result.text, /D4 while unmounted/);
                assert.equal(result.commits, 1);
            },
        );
    });
});
