// Real Chromium + authenticated Team SSE/poll. Six sequential switches, no user sends or model inference.
import { channel } from "node:diagnostics_channel";
import { withAppPage } from "../../../test/fixtures/app-browser.ts";
import { cleanUp } from "../../../test/helpers.ts";
import { pushChannel } from "../../../src/server/perf-channels.ts";

try {
    const results = {};

    for (const transport of ["stream", "poll"]) {
        await withAppPage(async (evaluate) => {
            await evaluate(`(async () => {
                const { api, store, navigate } = await import('/store.js');
                const other = await api('sessions', { title: 'Switch fixture', backend: 'rotom' });
                window.switchFixture = {
                    ids: [store.state.conversationId, other.id],
                    select(id) { return new Promise((resolve, reject) => {
                        const timer = setTimeout(() => { stop(); reject(new Error('switch did not reach a fresh view')); }, 10000);
                        const stop = store.subscribe(state => {
                            if (state.view.conversation?.id === id && !state.view.checking) {
                                stop(); clearTimeout(timer); resolve(true);
                            }
                        });
                        navigate(id);
                    }); }
                }; return true;
            })()`);
            const counts = {
                streamOpens: 0,
                newPollSessions: 0,
                hello: 0,
                fullLists: 0,
                subscriptionPosts: 0,
                meRequests: 0,
            };

            const request = ({ request }) => {
                const url = new URL(request.url, "http://fixture.local");

                if (url.pathname === "/api/events") {
                    counts.streamOpens++;
                }

                if (url.pathname === "/api/poll" && !url.searchParams.has("session")) {
                    counts.newPollSessions++;
                }

                if (url.pathname === "/api/subscribe") {
                    counts.subscriptionPosts++;
                }

                if (url.pathname === "/api/me") {
                    counts.meRequests++;
                }
            };

            const pushed = ({ event }) => {
                if (event === "hello") {
                    counts.hello++;
                }

                if (event === "sessions") {
                    counts.fullLists++;
                }
            };

            channel("http.server.request.start").subscribe(request);
            pushChannel.subscribe(pushed);

            try {
                for (let i = 0; i < 6; i++) {
                    await evaluate(`switchFixture.select(switchFixture.ids[${(i + 1) % 2}])`);
                }

                results[transport] = counts;
            } finally {
                channel("http.server.request.start").unsubscribe(request);
                pushChannel.unsubscribe(pushed);
            }
        }, transport);
    }

    console.log(JSON.stringify({ switches: 6, results }, null, 2));
} finally {
    cleanUp();
}
