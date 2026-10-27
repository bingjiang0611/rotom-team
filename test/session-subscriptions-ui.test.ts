// Chromium runs the real Team store, cached views, route history and both transports. No inference or user sends.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { withAppPage } from "./fixtures/app-browser.ts";
import { cleanUp, owner, until } from "./helpers.ts";

after(cleanUp);

for (const transport of ["stream", "poll"] as const) {
    test(
        `Chromium ${transport}: rapid navigation, Back/Forward and home reuse one connection; disconnect selects the latest session`,
        {
            skip: findBrowser() === undefined && "no Chromium available",
            timeout: 60_000,
        },
        async () => {
            await withAppPage(async (evaluate, app) => {
                const setup = await evaluate(`(async () => {
                const { api, store, navigate } = await import('/store.js');
                const original = window.fetch;
                window.subscriptionRequests = [];
                window.fetch = async (...args) => {
                    const response = await original(...args);
                    if (args[1]?.method === 'POST') subscriptionRequests.push({
                        path: String(args[0]), body: JSON.parse(args[1].body), status: response.status
                    });
                    return response;
                };
                const other = await api('sessions', { title: 'Second session', backend: 'rotom' });
                const a = store.state.conversationId;
                window.subscriptionFixture = {
                    a, b: other.id, store, navigate,
                    wait(id, action) { return new Promise((resolve, reject) => {
                        const timer = setTimeout(() => { stop(); reject(new Error('fresh view did not arrive')); }, 10000);
                        const stop = store.subscribe(state => {
                            if (state.conversationId === id && state.view.conversation?.id === id && !state.view.checking) {
                                stop(); clearTimeout(timer); resolve(true);
                            }
                        });
                        action();
                    }); }
                };
                return { a, b: other.id, connection: store.state.streamId };
            })()`);
                const select = (id: number) =>
                    evaluate(
                        `subscriptionFixture.wait(${id}, () => subscriptionFixture.navigate(${id}))`,
                    );
                const state = () =>
                    evaluate(`({ id: subscriptionFixture.store.state.view.conversation?.id,
                connection: subscriptionFixture.store.state.streamId,
                checking: !!subscriptionFixture.store.state.view.checking,
                title: subscriptionFixture.store.state.view.conversation?.title })`);

                await select(setup.b);
                await select(setup.a);
                await evaluate(`subscriptionFixture.wait(${setup.a}, () => {
                subscriptionFixture.navigate(${setup.b}); subscriptionFixture.navigate(${setup.a});
            })`);
                await evaluate(`subscriptionFixture.wait(${setup.b}, () => history.back())`);
                await evaluate(`subscriptionFixture.wait(${setup.a}, () => history.forward())`);
                assert.equal((await state()).connection, setup.connection);
                await evaluate(`(subscriptionFixture.navigate(null), true)`);
                await until(
                    async () =>
                        evaluate(
                            `subscriptionRequests.some(r => r.path === '/api/subscribe' && r.body.conversationId === null)`,
                        ),
                    "home subscription",
                );
                assert.equal(
                    [...app.clients].find((c) => c.connection === setup.connection)?.conversationId,
                    undefined,
                );
                await select(setup.b);
                assert.equal((await state()).connection, setup.connection);
                const current = [...app.clients].find((c) => c.connection === setup.connection)!;

                assert.equal(current.conversationId, setup.b);
                current.close!();
                await app.commands.updateSession(current.conversationId!, owner(app), {
                    title: "Changed while disconnected",
                });
                await until(async () => {
                    const current = await state();

                    return (
                        current.connection !== setup.connection &&
                        current.id === setup.b &&
                        current.title === "Changed while disconnected" &&
                        !current.checking
                    );
                }, "reconnected to latest session, not the URL's initial session");
                const requests = await evaluate("subscriptionRequests");

                assert.ok(requests.filter((r: any) => r.path === "/api/subscribe").length >= 6);
                assert.equal(requests.filter((r: any) => /\/send$/.test(r.path)).length, 0);
                assert.equal(
                    [...app.clients].filter((c) => c.conversationId === setup.b).length,
                    1,
                );
                assert.equal(
                    [...app.clients].filter((c) => c.conversationId === setup.a).length,
                    0,
                );
            }, transport);
        },
    );
}
