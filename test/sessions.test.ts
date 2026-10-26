// Forks, sending a message again (edited, or to another model), new contexts, and instructions for Pi.
import {
    type App,
    cleanUp,
    context,
    fakeTab,
    seedHistoricalSession,
    appendHistoricalTurn,
    openApp,
    openNativeApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId, EntryRecord } from "@earendil-works/pi-durable";
import { SessionsDoc } from "../src/server/docs.ts";
import { ConfigStore } from "../src/server/config.ts";

let app: App;

before(async () => {
    app = await openApp(scriptedModel());
});

after(async () => {
    await app?.close();
    cleanUp();
});

async function entries(id: ConversationId): Promise<EntryRecord[]> {
    const page = await (await app.harness.conversation(id, context))!.entries(
        {},
        256,
        undefined,
        context,
    );

    return [...page.items].reverse();
}

/** A guest with steering rights, signed in as `name`. */
const guest = (name: string, sessions?: string[]) =>
    app.config.addUser(name, "guest", sessions).user;

test("legacy session titles remain readable while title mutation is rejected", async () => {
    const id = await seedHistoricalSession(app);

    assert.equal(app.sessionMeta(id)?.title, "Historical test session");
    await assert.rejects(
        app.commands.updateSession(id, owner(app), { title: "must not mutate" }),
        /read-only archive/,
    );
    assert.equal(app.sessionMeta(id)?.title, "Historical test session");
});

test("a finished run stays unread independently for every member", async () => {
    const id = await seedHistoricalSession(app);
    const bob = guest("Finished Bob");

    await app.recordRunFinished(id);
    const ownerSession = (await app.sessions(owner(app))).find(
        (session) => session.id === Number(id),
    )!;
    const bobSession = (await app.sessions(bob)).find((session) => session.id === Number(id))!;

    assert.equal(ownerSession.finishedUnread, true);
    assert.equal(bobSession.finishedUnread, true);
    const finishedAt = ownerSession.finishedAt;

    assert.ok(finishedAt);
    const ownerTab = fakeTab(undefined, owner(app));
    const bobTab = fakeTab(undefined, bob);

    await app.attach(ownerTab.client);
    await app.attach(bobTab.client);
    ownerTab.events.length = 0;
    bobTab.events.length = 0;
    await app.markRunSeen(id, owner(app), finishedAt);
    assert.equal(ownerTab.events.filter((event) => event.event === "sessions").length, 1);
    assert.equal(bobTab.events.filter((event) => event.event === "sessions").length, 0);
    app.detach(ownerTab.client);
    app.detach(bobTab.client);
    assert.equal(
        (await app.sessions(owner(app))).find((session) => session.id === Number(id))!
            .finishedUnread,
        undefined,
    );
    assert.equal(
        (await app.sessions(bob)).find((session) => session.id === Number(id))!.finishedUnread,
        true,
        "one member looking never marks another member's result viewed",
    );
    // This fixture reopens only ConfigStore; real app shutdown performs this flush itself.
    app.config.flush();
    const restartedConfig = new ConfigStore(app.dataDir);

    assert.equal(restartedConfig.userById(owner(app).id)?.finishedSeen?.[String(id)], finishedAt);
    assert.equal(restartedConfig.userById(bob.id)?.finishedSeen?.[String(id)], undefined);
    assert.equal(
        (await app.harness.snapshot(SessionsDoc, context))?.items[String(id)]?.finishedAt,
        finishedAt,
    );
    await assert.rejects(
        async () => await app.markRunSeen(id, bob, finishedAt + 1),
        /current finishedAt/,
    );
    await app.recordRunFinished(id);
    const newer = (await app.sessions(owner(app))).find((session) => session.id === Number(id))!;

    assert.ok(newer.finishedAt! > finishedAt);
    await app.markRunSeen(id, owner(app), finishedAt);
    assert.equal(
        (await app.sessions(owner(app))).find((session) => session.id === Number(id))!
            .finishedUnread,
        true,
        "a delayed acknowledgement of the old result cannot clear a newer result",
    );
});

test("historical fork readers preserve fork points, inherited visibility, order, and scoped access", async () => {
    const root = await seedHistoricalSession(app);

    await appendHistoricalTurn(app, root, "root before fork", "root answer");
    const rootConversation = (await app.harness.conversation(root, context))!;
    const rootPage = await rootConversation.entries({}, 256, undefined, context);
    const forkPoint = rootPage.items.find((entry) => entry.kind === "pi.assistant")!;
    const child = await rootConversation.fork(
        forkPoint.id,
        { ownership: { kind: "ownerless" } },
        context,
    );

    await appendHistoricalTurn(app, child.id, "child after fork", "child answer");
    const childConversation = (await app.harness.conversation(child.id, context))!;
    const childPage = await childConversation.entries({}, 256, undefined, context);
    const childEntry = childPage.items.find((entry) => entry.kind === "pi.user")!;
    const grandchild = await childConversation.fork(
        childEntry.id,
        { ownership: { kind: "ownerless" } },
        context,
    );

    await appendHistoricalTurn(app, grandchild.id, "grandchild after fork", "grandchild answer");

    const rootEntries = await entries(root);
    const childEntries = await entries(child.id);
    const grandchildEntries = await entries(grandchild.id);

    assert.ok(rootEntries.some((entry) => JSON.stringify(entry).includes("root before fork")));
    assert.ok(!rootEntries.some((entry) => JSON.stringify(entry).includes("child after fork")));
    assert.ok(childEntries.some((entry) => JSON.stringify(entry).includes("root before fork")));
    assert.ok(childEntries.some((entry) => JSON.stringify(entry).includes("child after fork")));
    assert.ok(
        grandchildEntries.some((entry) => JSON.stringify(entry).includes("child after fork")),
    );
    assert.ok(
        grandchildEntries.some((entry) => JSON.stringify(entry).includes("grandchild after fork")),
    );

    for (const [conversationId, page] of [
        [root, rootEntries],
        [child.id, childEntries],
        [grandchild.id, grandchildEntries],
    ] as const) {
        for (const entry of page) {
            assert.ok(await app.transcripts.visibleEntry(conversationId, entry.id as never));
            assert.ok(await app.transcripts.fullEntry(conversationId, entry.id as never));
        }
    }

    const parentOnly = childEntries.find((entry) =>
        JSON.stringify(entry).includes("child after fork"),
    )!;

    assert.equal(await app.transcripts.visibleEntry(root, parentOnly.id as never), undefined);
    const exported = await app.transcripts.exportMarkdown(child.id, owner(app));

    assert.match(exported.filename, /^conversation-\d+\.md$/);
    assert.match(exported.markdown, /^# Conversation \d+$/m);
    assert.match(
        exported.markdown,
        /\*\*Someone\*\*[\s\S]*root before fork[\s\S]*\*\*Pi\*\*[\s\S]*root answer/,
    );
    const viewer = guest("Fork viewer", [String(child.id)]);

    assert.match(
        (await app.transcripts.exportMarkdown(child.id, viewer)).markdown,
        /child after fork/,
    );
    await assert.rejects(app.transcripts.exportMarkdown(root, viewer), { status: 404 });
});

test("legacy fork, resend, edit, context, and instruction mutations are rejected", async () => {
    const id = await seedHistoricalSession(app);

    await app.harness.commit(async (tx) => {
        await tx.appendEntry(id, {
            kind: "pi.user",
            model: [{ role: "user", content: "historical input", timestamp: Date.now() }],
        });
    }, context);
    const entry = (await entries(id)).find((item) => item.kind === "pi.user")!;

    await assert.rejects(
        app.commands.fork(id, owner(app), { entryId: Number(entry.id) }),
        /read-only archive/,
    );
    await assert.rejects(
        app.commands.resend(id, owner(app), { entryId: Number(entry.id) }),
        /read-only archive/,
    );
    await assert.rejects(app.commands.reset(id, owner(app), "edited"), /read-only archive/);
    await assert.rejects(app.commands.reset(id, owner(app), "new context"), /read-only archive/);
    await assert.rejects(
        app.commands.setInstructions(id, owner(app), "new instructions"),
        /read-only archive/,
    );
    assert.equal((await entries(id)).filter((item) => item.kind === "pi.user").length, 1);
});

test("a legacy session exports its unchanged historical Markdown to permitted readers", async () => {
    const id = await seedHistoricalSession(app);

    await app.harness.commit(async (tx) => {
        await tx.appendEntry(id, {
            kind: "pi.user",
            model: [{ role: "user", content: "the first word", timestamp: Date.now() }],
        });
    }, context);
    const { filename, markdown } = await app.transcripts.exportMarkdown(id, owner(app));

    assert.match(filename, /historical-test-session/);
    assert.match(markdown, /the first word/);
    const viewer = app.config.addUser("Scoped viewer", "viewer", [String(id)]).user;

    assert.equal((await app.transcripts.exportMarkdown(id, viewer)).markdown, markdown);
});

test("a native session budget reaches a live list view without inference", async () => {
    const data = join(realpathSync(root), "native-budget");

    mkdirSync(data, { mode: 0o700 });
    const native = await openNativeApp(scriptedModel(), data);

    try {
        const user = owner(native);
        const { id } = await native.commands.createSession(user, { backend: "rotom" });
        const tab = fakeTab(undefined, user);

        await native.attach(tab.client);
        await native.spend.setSessionBudget(user, id, 3);
        await until(
            () =>
                (tab.last("sessions") as { id: number; budget?: number }[] | undefined)?.some(
                    (session) => session.id === Number(id) && session.budget === 3,
                ) === true,
            "the budget list update",
        );
        assert.equal(native.sessionMeta(id)?.budget, 3);
        assert.equal(
            (await native.spend.summary(user)).sessions.find((row) => row.id === id)?.readOnly,
            false,
        );
        native.detach(tab.client);
    } finally {
        await native.close();
    }
});

test("legacy title and budget mutations reject while historical limits remain readable", async () => {
    const id = await seedHistoricalSession(app);

    await app.harness.commit(async (tx) => {
        (await tx.doc(SessionsDoc)).items[String(id)]!.budget = 3;
    }, context);
    await assert.rejects(
        app.commands.updateSession(id, owner(app), { title: "Renamed" }),
        /read-only archive/,
    );
    await assert.rejects(app.spend.setSessionBudget(owner(app), id, 4), /read-only archive/);
    assert.equal(app.sessionMeta(id)?.title, "Historical test session");
    assert.equal(app.sessionMeta(id)?.budget, 3);
    const summary = (await app.spend.summary(owner(app))).sessions.find((row) => row.id === id);

    assert.equal(summary?.budget, 3);
    assert.equal(summary?.readOnly, true);
});

test("the folder picker makes a new folder, nested ones too, for people who may browse folders", async () => {
    const { existsSync, statSync, symlinkSync } = await import("node:fs");
    const { root } = await import("./helpers.ts");
    const made = join(root, "picked", "new app");

    assert.equal(app.workspace.makeFolder(owner(app), made), made);
    assert.ok(statSync(made).isDirectory());
    assert.equal(
        app.workspace.makeFolder(owner(app), `${made}/`),
        made,
        "one already there is fine",
    );
    assert.equal(app.workspace.makeFolder(guest("Gus"), join(made, "src")), join(made, "src"));

    writeFileSync(join(root, "picked", "notes.txt"), "a file\n");
    assert.throws(() => app.workspace.makeFolder(owner(app), join(root, "picked", "notes.txt")), {
        status: 409,
    });
    symlinkSync(join(root, "picked", "gone"), join(root, "picked", "dangling"));
    assert.throws(() => app.workspace.makeFolder(owner(app), join(root, "picked", "dangling")), {
        status: 409,
        message: /broken link/,
    });
    assert.throws(() => app.workspace.makeFolder(owner(app), "relative/folder"), { status: 400 });
    assert.throws(() => app.workspace.makeFolder(owner(app), "  "), { status: 400 });
    assert.throws(
        () => app.workspace.makeFolder(app.config.addUser("Vic", "viewer").user, join(root, "v")),
        { status: 403 },
    );
    assert.throws(() => app.workspace.makeFolder(guest("Scoped Sam", ["1"]), join(root, "s")), {
        status: 403,
    });
    assert.ok(!existsSync(join(root, "v")) && !existsSync(join(root, "s")));

    // What the picker offers to make: a folder not there yet, never a file.
    assert.throws(() => app.workspace.checkDirectory(join(root, "picked", "later")), {
        status: 404,
        message: /isn't there/,
    });
    assert.throws(() => app.workspace.checkDirectory(join(root, "picked", "notes.txt")), {
        status: 400,
        message: /is a file, not a folder/,
    });
    assert.throws(() => app.workspace.checkDirectory(join(root, "picked", "notes.txt", "in")), {
        status: 400,
        message: /inside a file/,
    });
    assert.throws(() => app.workspace.checkDirectory(join(root, "picked", "dangling")), {
        status: 400,
        message: /link to nothing/,
    });
    symlinkSync(join(root, "picked", "loop-b"), join(root, "picked", "loop-a"));
    symlinkSync(join(root, "picked", "loop-a"), join(root, "picked", "loop-b"));
    assert.throws(() => app.workspace.checkDirectory(join(root, "picked", "loop-a")), {
        status: 400,
        message: /link to nothing/,
    });
});
