// A tab that asks for the newest entries gets those, the whole order, and the rest a page at a time, as any view sends
// them; people who may not see the session read none of it.
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
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { createHandler } from "../src/server/http.ts";
import type { Client } from "../src/server/room.ts";

after(cleanUp);

type App = Awaited<ReturnType<typeof openApp>>;

async function append(app: App, id: ConversationId, text: string) {
    return app.harness.commit(
        (tx) =>
            tx.appendEntry(id, {
                kind: "pi.user",
                model: [{ role: "user", content: text, timestamp: 1 }],
            }),
        context,
    );
}

type Entry = { id: number };
type View = { entries: Entry[]; order?: number[]; start?: number; kept?: unknown };

test("a tail view sends the newest entries and the whole order; updates stay deltas", async () => {
    const app = await openApp(scriptedModel(), join(root, "tail-room"));

    try {
        const id = await newSession(app);

        for (let index = 1; index <= 12; index++) {
            await append(app, id, `message ${index}`);
        }

        const room = await app.room(id);

        const tab = (tail?: number) => {
            const each = fakeTab(id, owner(app));

            Object.assign(each.client, tail === undefined ? {} : { viewTail: tail });
            room.push(each.client as Client, true);

            return each;
        };

        const whole = tab().last("view") as unknown as View;
        const tailed = tab(5);
        const view = tailed.last("view") as unknown as View;

        assert.deepEqual(view.order, whole.order, "the whole order");
        assert.deepEqual(view.entries, whole.entries.slice(-5), "only the newest five");
        assert.equal(view.start, whole.order!.length - 5);
        assert.ok(!("start" in whole), "a tab that asked for everything gets everything");
        assert.deepEqual(
            room.earlier(view.entries[0]!.id, 3),
            whole.entries.slice(-8, -5),
            "the page before, exactly as a view sends it",
        );
        assert.deepEqual(
            room.earlier(whole.order![1]!, 200),
            whole.entries.slice(0, 1),
            "the first page stops at the start",
        );
        assert.deepEqual(room.earlier(whole.order![0]!, 200), [], "nothing before the first");
        assert.deepEqual(room.earlier(999_999, 200), [], "an id not in the order");

        await append(app, id, "thirteen");
        room.push(tailed.client as Client, false);
        const added = tailed.last("view") as unknown as View;

        assert.equal(
            added.entries.length,
            1,
            "a new entry is a delta, nothing older comes with it",
        );
        assert.ok(!("start" in added));
        assert.ok(JSON.stringify(added.entries).includes("thirteen"), "the delta is the new entry");
    } finally {
        await app.close();
    }
});

test("pages of earlier entries over HTTP: checked parameters, and only for people who may see the session", async () => {
    const app = await openApp(scriptedModel(), join(root, "tail-http"));
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const get = (token: string, path: string) =>
        fetch(`${base}/api/${path}`, { headers: { authorization: `Bearer ${token}` } });
    const ownerToken = app.config.ownerToken;
    const id = await newSession(app);
    const other = await newSession(app);
    const elsewhere = app.config.addUser("Elsewhere", "guest", [String(other)]);

    try {
        for (let index = 1; index <= 6; index++) {
            await append(app, id, `message ${index}`);
        }

        const room = await app.room(id);
        const reference = fakeTab(id, owner(app));

        room.push(reference.client, true);
        const whole = reference.last("view") as unknown as View;
        const last = whole.order!.at(-1)!;

        app.releaseRoom(room);
        const page = await get(ownerToken, `c/${id}/entries?before=${last}&limit=2`);

        assert.equal(page.status, 200);
        assert.deepEqual(
            ((await page.json()) as { entries: Entry[] }).entries,
            whole.entries.slice(-3, -1),
        );

        for (const query of [
            "",
            "?before=0",
            "?before=x",
            `?before=${last}&limit=0`,
            `?before=${last}&limit=201`,
        ]) {
            assert.equal((await get(ownerToken, `c/${id}/entries${query}`)).status, 400, query);
        }

        const refused = await get(elsewhere.token, `c/${id}/entries?before=${last}`);

        assert.ok([403, 404].includes(refused.status), `refused: ${refused.status}`);
        assert.doesNotMatch(
            await refused.text(),
            /message \d/,
            "no entry text for someone who may not see it",
        );
        assert.equal((await get(elsewhere.token, `c/${other}/entries?before=1`)).status, 200);
    } finally {
        app.config.removeUser(elsewhere.user.id);
        server.closeAllConnections();
        server.close();
        await app.close();
    }
});
