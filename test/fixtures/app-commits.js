// Real Preact render+diff+commit hooks, installed before app.js. No production instrumentation or state library.
import { options } from "preact";
import "preact/hooks";

const tracked = [
    "App",
    "Transcript",
    "Topbar",
    "SessionList",
    "Composer",
    "NativeBanner",
    "Notices",
];
const rendered = new WeakSet();
let staged = [];
let counts = {};
let store;
const beforeRender = options.__r;
const afterDiff = options.diffed;
const commit = options.__c;

options.__r = (vnode) => {
    rendered.add(vnode);
    beforeRender?.(vnode);
};

options.diffed = (vnode) => {
    // diffed alone includes shouldComponentUpdate bailouts in Preact 11. Only count a completed render.
    if (rendered.delete(vnode) && tracked.includes(vnode.type?.name)) {
        staged.push(vnode.type.name);
    }

    afterDiff?.(vnode);
};

options.__c = (vnode, queue) => {
    const finished = staged;

    staged = [];
    commit?.(vnode, queue);

    for (const name of finished) {
        counts[name] = (counts[name] ?? 0) + 1;
    }
};

// Fields sent afresh in every room.ts view, even when only token text changes. Entries/order and omitted fields keep
// their references in applyView. Round-trip these JSON fields so a reference-only shortcut cannot pass the benchmark.
const repeated = [
    "conversation",
    "inbox",
    "agent",
    "stats",
    "clients",
    "viewers",
    "approvals",
    "kernel",
];
const fixture = (window.appCommitFixture = {
    async attach() {
        ({ store } = await import("/store.js"));
    },
    state: () => store.state,
    counts: () => Object.fromEntries(tracked.map((name) => [name, counts[name] ?? 0])),
    reset() {
        counts = {};
    },
    async flush() {
        // Includes Preact's microtask commits, Markdown's deferred frame and the subsequent paint.
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
    },
    update(live, patch = {}) {
        const view = store.state.view;
        const metadata = Object.fromEntries(
            repeated.map((key) => [
                key,
                view[key] === undefined ? undefined : JSON.parse(JSON.stringify(view[key])),
            ]),
        );

        store.set({
            view: {
                ...view,
                ...metadata,
                live,
                liveVersion: (view.liveVersion ?? 0) + 1,
                ...patch,
            },
        });
    },
    async measure(kind) {
        fixture.update({ busy: true });
        await fixture.flush();
        fixture.reset();
        let text = "";

        for (let i = 0; i < 20; i++) {
            text += `D4-${kind}-${i} `;
            fixture.update({
                busy: true,
                ...(kind === "tool"
                    ? {
                          generation: {
                              attempt: 1,
                              message: {
                                  blocks: [
                                      {
                                          type: "toolCall",
                                          id: "d4-tool",
                                          name: "bash",
                                          args: { command: "echo fixture" },
                                      },
                                  ],
                              },
                          },
                          tools: [
                              {
                                  callId: "d4-tool",
                                  name: "bash",
                                  status: "running",
                                  output: text,
                              },
                          ],
                      }
                    : { generation: { attempt: 1, message: { blocks: [{ type: kind, text }] } } }),
            });
            await fixture.flush();
        }

        return fixture.counts();
    },
});
