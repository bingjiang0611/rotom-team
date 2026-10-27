// Real authenticated HTTP: connection ownership, monotonic subscriptions, frozen queued events and cancellation.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { createHandler } from "../src/server/http.ts";
import {
    cleanUp,
    seedHistoricalSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";

after(cleanUp);
let fixtures = 0;

async function fixture() {
    const app = await openApp(scriptedModel(), join(root, `subscriptions-${++fixtures}`));
    const a = await seedHistoricalSession(app);
    const b = await seedHistoricalSession(app);
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart() {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    const login = async (token: string) => {
        const response = await fetch(`${base}/login?token=${encodeURIComponent(token)}`, {
            redirect: "manual",
        });

        return response.headers.get("set-cookie")!.split(";")[0]!;
    };

    const cookie = await login(app.config.ownerToken);
    const get = (path: string, as = cookie) =>
        fetch(`${base}/api/${path}`, { headers: { cookie: as } });
    const post = (body: unknown, as = cookie) =>
        fetch(`${base}/api/subscribe`, {
            method: "POST",
            headers: { cookie: as, "x-pocket": "1", "content-type": "application/json" },
            body: JSON.stringify(body),
        });

    const sse = async (query: string, as = cookie) => {
        const controller = new AbortController();
        const response = await fetch(`${base}/api/events?${query}`, {
            headers: { cookie: as, "accept-encoding": "identity" },
            signal: controller.signal,
        });

        assert.equal(response.status, 200);
        const events: { event: string; data: any }[] = [];
        const pump = (async () => {
            const decoder = new TextDecoder();
            let buffer = "";

            try {
                for await (const chunk of response.body!) {
                    buffer += decoder.decode(chunk, { stream: true });
                    let end;

                    while ((end = buffer.indexOf("\n\n")) !== -1) {
                        const frame = buffer.slice(0, end);

                        buffer = buffer.slice(end + 2);
                        const event = /^event: (.+)$/m.exec(frame)?.[1];
                        const data = /^data: (.+)$/m.exec(frame)?.[1];

                        if (event && data) {
                            events.push({ event, data: JSON.parse(data) });
                        }
                    }
                }
            } catch (error) {
                if (!controller.signal.aborted) {
                    throw error;
                }
            }
        })();

        return {
            events,
            async close() {
                controller.abort();
                await pump;
            },
        };
    };

    return {
        app,
        a,
        b,
        cookie,
        login,
        get,
        post,
        sse,
        async close() {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await app.close();
        },
    };
}

for (const transport of ["events", "poll"] as const) {
    test(
        `${transport}: switching reuses the connection, ACK precedes full view, stale intents cannot undo A→B→A`,
        { timeout: 30_000 },
        async () => {
            const f = await fixture();
            const query = `subscriptions=1&generation=1&sessions=delta&live=delta&c=${f.a}`;
            const stream = transport === "events" ? await f.sse(query) : undefined;

            try {
                const first = stream ? undefined : await (await f.get(`poll?${query}`)).json();
                const events = stream?.events ?? first.events;

                await until(() => events.some((e: any) => e.event === "view"), "initial snapshot");
                const connection = events.find((e: any) => e.event === "hello").data.connection;
                const client = [...f.app.clients].find((c) => c.connection === connection)!;
                const old = JSON.stringify(events.find((e: any) => e.event === "view"));

                for (const [generation, conversationId] of [
                    [2, f.b],
                    [3, f.a],
                ] as const) {
                    const response = await f.post({ connection, generation, conversationId });

                    assert.equal(response.status, 200);
                    assert.equal((await response.json()).generation, generation);
                }

                assert.equal(
                    (await f.post({ connection, generation: 2, conversationId: f.b })).status,
                    200,
                );
                assert.equal(client.conversationId, f.a);
                assert.equal((await f.app.room(f.a)).clients.has(client), true);
                assert.equal((await f.app.room(f.b)).clients.has(client), false);
                const all =
                    stream?.events ??
                    (await (await f.get(`poll?session=${first.session}&ack=0`)).json()).events;

                await until(
                    () => all.some((e: any) => e.event === "view" && e.data.generation === 3),
                    "new A",
                );
                assert.equal(all.filter((e: any) => e.event === "hello").length, 1);
                assert.equal(all.filter((e: any) => e.event === "sessions").length, 1);

                for (const generation of [1, 2, 3]) {
                    const ack = all.findIndex(
                        (e: any) => e.event === "subscription" && e.data.generation === generation,
                    );
                    const view = all.findIndex(
                        (e: any) => e.event === "view" && e.data.generation === generation,
                    );

                    assert.ok(
                        ack >= 0 && ack < view,
                        `generation ${generation}: ordered ACK/full snapshot`,
                    );
                    assert.equal(all[view].data.data.full, true);
                }

                assert.equal(
                    JSON.stringify(
                        all.find((e: any) => e.event === "view" && e.data.generation === 1),
                    ),
                    old,
                    "queued/retransmitted old payload keeps its original generation",
                );
                assert.equal(
                    (await f.post({ connection, generation: 4, conversationId: null })).status,
                    200,
                );
                assert.equal(client.conversationId, undefined);
                assert.equal((await f.app.room(f.a)).clients.has(client), false);

                if (first) {
                    assert.equal(
                        (await f.get(`poll?session=${first.session}&ack=9007199254740991`)).status,
                        400,
                    );
                    assert.equal((await f.get(`poll?session=${first.session}&ack=-1`)).status, 400);
                    const stillQueued = await (
                        await f.get(`poll?session=${first.session}&ack=0`)
                    ).json();

                    assert.ok(
                        stillQueued.events.some(
                            (e: any) => e.event === "view" && e.data.generation === 1,
                        ),
                    );
                    await f.get(`poll?session=${first.session}&close=1`);
                }
            } finally {
                await stream?.close();
                await f.close();
            }
        },
    );
}

test(
    "subscriptions reject malformed input and another member's connection; legacy tabs retain unwrapped events",
    { timeout: 30_000 },
    async () => {
        const f = await fixture();

        try {
            const legacyStream = await f.sse(`c=${f.a}`);

            try {
                await until(
                    () => legacyStream.events.some((e) => e.event === "view"),
                    "legacy SSE view",
                );
                assert.equal(
                    legacyStream.events.find((e) => e.event === "view")!.data.conversation.id,
                    f.a,
                );
                assert.ok(!legacyStream.events.some((e) => e.event === "subscription"));
            } finally {
                await legacyStream.close();
            }

            const initial = await (await f.get(`poll?c=${f.a}`)).json();
            const connection = initial.events.find((e: any) => e.event === "hello").data.connection;
            const view = initial.events.find((e: any) => e.event === "view").data;

            assert.equal(view.conversation.id, f.a);
            assert.equal(view.generation, undefined);
            assert.ok(!initial.events.some((e: any) => e.event === "subscription"));
            assert.equal(
                (await f.post({ connection, generation: 2, conversationId: f.b })).status,
                404,
            );
            await f.get(`poll?session=${initial.session}&close=1`);
            const fresh = await (await f.get(`poll?subscriptions=1&generation=1&c=${f.a}`)).json();
            const next = fresh.events.find((e: any) => e.event === "hello").data.connection;
            const guest = f.app.config.addUser("Guest", "viewer", [String(f.a)]);
            const guestCookie = await f.login(guest.token);

            assert.equal(
                (
                    await f.post(
                        { connection: next, generation: 2, conversationId: f.a },
                        guestCookie,
                    )
                ).status,
                404,
            );

            for (const body of [
                null,
                {},
                { connection: next, generation: -1, conversationId: f.b },
                { connection: next, generation: 1.5, conversationId: f.b },
                { connection: next, generation: 2, conversationId: "wrong" },
                { connection: next, generation: 2, conversationId: f.b, have: {} },
            ]) {
                assert.equal((await f.post(body)).status, 400);
            }

            const guestPoll = await (
                await f.get(`poll?subscriptions=1&generation=1&c=${f.a}`, guestCookie)
            ).json();
            const guestConnection = guestPoll.events.find((e: any) => e.event === "hello").data
                .connection;
            const lastSeq = guestPoll.events.at(-1).seq;

            assert.equal(
                (
                    await f.post(
                        { connection: guestConnection, generation: 2, conversationId: f.b },
                        guestCookie,
                    )
                ).status,
                200,
            );
            const denied = await (
                await f.get(`poll?session=${guestPoll.session}&ack=${lastSeq}`, guestCookie)
            ).json();

            assert.ok(
                denied.events.some((e: any) => e.event === "missing" && e.data.generation === 2),
            );
            assert.ok(!denied.events.some((e: any) => e.event === "view"));
            await f.get(`poll?session=${guestPoll.session}&close=1`, guestCookie);
            await f.get(`poll?session=${fresh.session}&close=1`);
        } finally {
            await f.close();
        }
    },
);

test(
    "pending room opens cannot rejoin after supersession, revocation or disconnect",
    { timeout: 30_000 },
    async () => {
        const f = await fixture();
        const guest = f.app.config.addUser("Guest", "viewer", [String(f.a), String(f.b)]);
        const cookie = await f.login(guest.token);
        const original = f.app.room.bind(f.app);

        try {
            for (const outcome of [
                "supersede",
                "return",
                "revoke",
                "access-refresh",
                "disconnect",
            ] as const) {
                f.app.setAccess(owner(f.app), guest.user.id, {
                    sessions: [String(f.a), String(f.b)],
                });
                const first = await (
                    await f.get(`poll?subscriptions=1&generation=1&c=${f.a}`, cookie)
                ).json();
                const connection = first.events.find((e: any) => e.event === "hello").data
                    .connection;
                const client = [...f.app.clients].find((c) => c.connection === connection)!;
                let entered = false;
                let release!: () => void;
                const gate = new Promise<void>((resolve) => {
                    release = resolve;
                });

                const pendingId = outcome === "return" ? f.a : f.b;

                f.app.room = async (id) => {
                    if (id === pendingId && !entered) {
                        entered = true;
                        await gate;
                    }

                    return original(id);
                };

                const pending = f.post(
                    { connection, generation: 2, conversationId: pendingId },
                    cookie,
                );

                await until(() => entered, "pending room open");

                if (outcome === "supersede") {
                    await f.post({ connection, generation: 3, conversationId: f.a }, cookie);
                } else if (outcome === "return") {
                    await f.post({ connection, generation: 3, conversationId: f.b }, cookie);
                    await f.post({ connection, generation: 4, conversationId: f.a }, cookie);
                } else if (outcome === "revoke") {
                    f.app.setAccess(owner(f.app), guest.user.id, { sessions: [String(f.a)] });
                } else if (outcome === "access-refresh") {
                    // Change the authoritative grant without an eviction notification: the post-await check is independent.
                    f.app.config.updateUser(guest.user.id, { sessions: [String(f.a)] });
                } else {
                    await f.get(`poll?session=${first.session}&close=1`, cookie);
                }

                release();
                await pending;
                f.app.room = original;
                assert.equal((await original(f.b)).clients.has(client), false, outcome);

                if (outcome !== "disconnect") {
                    const batch = await (
                        await f.get(`poll?session=${first.session}&ack=0`, cookie)
                    ).json();

                    assert.ok(
                        !batch.events.some(
                            (e: any) => e.event === "view" && e.data.generation === 2,
                        ),
                        outcome,
                    );
                    assert.equal(
                        (await original(f.a)).clients.has(client),
                        outcome === "supersede" || outcome === "return",
                    );

                    if (outcome === "supersede" || outcome === "return") {
                        assert.ok(
                            !batch.events.some(
                                (e: any) => e.event === "subscription" && e.data.generation === 2,
                            ),
                            "even a return to the same room cannot complete the older generation",
                        );
                    }

                    if (outcome === "revoke" || outcome === "access-refresh") {
                        assert.ok(
                            batch.events.some(
                                (e: any) => e.event === "subscription" && e.data.generation === 2,
                            ),
                        );
                        assert.ok(
                            batch.events.some(
                                (e: any) => e.event === "missing" && e.data.generation === 2,
                            ),
                        );
                    }

                    await f.get(`poll?session=${first.session}&close=1`, cookie);
                }
            }
        } finally {
            f.app.room = original;
            await f.close();
        }
    },
);
