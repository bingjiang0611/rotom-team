// Spend: what each session and person cost, counted once across restarts and crashes, and limits that refuse and
// stop work. The scripted model costs nothing, so tests record usage in `pi.usage` themselves, as a response does.
import {
    type App,
    cleanUp,
    context,
    lastText,
    openNativeApp,
    owner,
    recordCost,
    root,
    scriptedModel,
    seedHistoricalSession,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, type UsageState } from "@earendil-works/pi-durable";
import type { User } from "../src/server/config.ts";
import { AuthorsDoc, ChatDoc, SessionsDoc, SpendDoc } from "../src/server/docs.ts";
import { TeamRunDoc } from "../src/server/team-execution.ts";
import { usageCost } from "../src/server/projection.ts";

/** Usage worth `dollars`, split between a model and a tool. */
const costing = (dollars: number) =>
    ({
        models: { "faux/faux-1": { cost: { total: dollars - 0.25 } } },
        tools: { codemode: { cost: { total: 0.25 } } },
    }) as unknown as UsageState;

const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText("done")]);
    }

    if (text.endsWith("work slowly")) {
        return fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 5" })], {
            stopReason: "toolUse",
        });
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

const model = scriptedModel(route);

let app: App;
let alex: User;

before(async () => {
    const data = join(realpathSync(root), "spend-data");

    mkdirSync(data, { mode: 0o700 });
    chmodSync(data, 0o700);
    app = await openNativeApp(model, data);
    alex = app.config.addUser("Alex", "guest").user;
});

after(async () => {
    await app?.close();
    cleanUp();
});

async function historicalSession(user: User): Promise<ConversationId> {
    const id = await seedHistoricalSession(app);

    await app.harness.commit(async (tx) => {
        const sessions = await tx.doc(SessionsDoc);

        sessions.items[String(id)]!.createdBy = user.id;
        (await tx.doc(TeamRunDoc, id)).owner = user.id;
        const authors = await tx.doc(AuthorsDoc, id);
        const entry = await tx.appendEntry(id, {
            kind: "pi.user",
            model: [{ role: "user", content: "historical requester", timestamp: Date.now() }],
        });

        (authors.requesters ??= {})[String(entry.id)] = user.id;
    }, context);

    return id;
}

async function nativeSession(): Promise<ConversationId> {
    return (await app.commands.createSession(owner(app), { backend: "rotom" })).id;
}

async function recordRequester(user: User, id: ConversationId, text: string): Promise<void> {
    await app.commands.note(id, user, text);
}

test("a conversation's spend is everything its models and tools cost", () => {
    assert.equal(usageCost(costing(1.5)), 1.5);
    assert.equal(usageCost(undefined), 0);
});

test("spend goes to whoever asked for the work, once, also when the server stopped before counting it", async () => {
    const id = await historicalSession(alex);

    await recordCost(app, id, 1.5);
    await until(() => app.spend.personSpent(alex.id) === 1.5, "Alex's spend to be counted");
    assert.equal(app.spend.sessionSpent(id), 1.5);
    await recordCost(app, id, 0.5);
    await until(() => app.spend.personSpent(alex.id) === 2, "the new spend to be added");
    assert.equal(app.spend.personSpent(owner(app).id), 0);

    // The server stops right after a response, before its spend is counted for anyone.
    await recordCost(app, id, 1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(app.spend.personSpent(alex.id), 2, "not counted yet");
    await app.close();
    app = await openNativeApp(model, join(realpathSync(root), "spend-data"));
    assert.equal(app.spend.personSpent(alex.id), 3, "counted on the next start, once");
    assert.equal(app.spend.sessionSpent(id), 3);
});

test("spend goes to whoever asked for the work, also when someone else writes before it is stored", async () => {
    const id = await nativeSession();
    const bea = app.config.addUser("Bea", "guest").user;

    await recordRequester(alex, id, "historical work requested");
    const before = app.spend.personSpent(alex.id);

    await recordCost(app, id, 2);
    await recordRequester(bea, id, "historical follow-up requested");
    await until(() => app.spend.personSpent(alex.id) === before + 2, "Alex's spend to be stored");
    assert.equal(app.spend.personSpent(bea.id), 0);
});

test("the first start that counts spend per person bills nobody for what was spent before", async () => {
    const id = await historicalSession(alex);

    // As before an upgrade: usage, and no per-person counting yet.
    await app.harness.commit((tx) => tx.retireDoc(SpendDoc), context);
    await recordCost(app, id, 4);
    await app.close();
    app = await openNativeApp(model, join(realpathSync(root), "spend-data"));
    assert.equal(app.spend.personSpent(alex.id), 0);
    assert.equal(app.spend.sessionSpent(id), 4, "the session still shows what it cost");
    await recordCost(app, id, 1);
    await until(() => app.spend.personSpent(alex.id) === 1, "new spend to be Alex's");
});

test("archived sessions reject budget and note mutations before writing", async () => {
    const id = await seedHistoricalSession(app);

    await assert.rejects(app.spend.setSessionBudget(owner(app), id, -1), { status: 400 });
    await assert.rejects(app.spend.setSessionBudget(owner(app), 999_999 as typeof id, 1), {
        status: 404,
    });
    const snapshot = async () =>
        structuredClone({
            metadata: app.sessionMeta(id),
            chat: await app.harness.snapshot(ChatDoc, id, context),
            records: await app.harness.commit(async (tx) => {
                const entries = await tx.scanEntries({ conversationId: id }, 100);
                const tasks = await tx.scanTasks({ conversationId: id }, 100);

                assert.equal(entries.next, undefined);
                assert.equal(tasks.next, undefined);

                return { entries: entries.items, tasks: tasks.items };
            }, context),
        });
    const before = await snapshot();
    const kernel = app.kernel!;
    const revoke = kernel.revoke;
    let revocations = 0;
    let submissionWrites = 0;
    const unsubscribe = app.harness.subscribeCommits((publication) => {
        submissionWrites += publication.changes.filter(
            (change) => change.type === "submission" && change.value.conversationId === id,
        ).length;
    });

    kernel.revoke = async () => {
        revocations++;
    };

    try {
        await assert.rejects(app.spend.setSessionBudget(owner(app), id, 1), {
            status: 409,
            message: /read-only archive/,
        });
        await assert.rejects(app.commands.note(id, owner(app), "should not write"), {
            status: 409,
            message: /read-only archive/,
        });
        assert.deepEqual(await snapshot(), before);
        assert.equal(revocations, 0);
        assert.equal(submissionWrites, 0);
    } finally {
        unsubscribe();
        kernel.revoke = revoke;
    }
});

test("limits refuse new messages, for a session and for a guest, but never for the owner's own spend", async () => {
    const id = await nativeSession();

    await recordCost(app, id, 3);
    await until(() => app.spend.sessionSpent(id) === 3, "the spend to be known");
    await assert.rejects(app.spend.setSessionBudget(alex, id, 1), { status: 403 });
    await assert.rejects(app.spend.setSessionBudget(owner(app), id, -1), { status: 400 });
    await app.spend.setSessionBudget(owner(app), id, 2.5);
    assert.throws(() => app.spend.check(owner(app), id), {
        status: 409,
        message: "This session reached its $2.50 spend limit. The owner can raise it.",
    });
    await app.spend.setSessionBudget(owner(app), id, null);
    app.spend.check(owner(app), id);

    app.spend.setPersonBudget(owner(app), alex.id, 1);
    assert.throws(() => app.spend.check(alex, id), {
        status: 409,
        message: "You reached your $1.00 spend limit. The owner can raise it.",
    });
    await assert.rejects(app.commands.submit(id, alex, { text: "more", requestId: "r" }), {
        status: 409,
    });
    assert.throws(() => app.spend.setPersonBudget(owner(app), owner(app).id, 1), { status: 400 });
    app.spend.setPersonBudget(owner(app), alex.id, null);
    app.spend.check(alex, id);

    const summary = await app.spend.summary(alex);

    assert.equal(summary.total, undefined, "only the owner sees the total");
    assert.deepEqual(
        summary.people.map((person) => person.name),
        ["Alex"],
    );
    assert.ok((await app.spend.summary(owner(app))).people.length >= 2);
});

test("the legacy compact command refuses a native backend, independent of budget admission", async () => {
    const id = await nativeSession();

    await recordCost(app, id, 2);
    await app.spend.setSessionBudget(owner(app), id, 1);
    await assert.rejects(app.commands.compact(id, owner(app), undefined), {
        status: 409,
        message: "This operation is not supported by this conversation's execution backend.",
    });
});

test("native sessions reject the legacy Durable submission path without dispatch", async () => {
    const id = await nativeSession();

    await app.spend.setSessionBudget(owner(app), id, 1);
    await assert.rejects(
        app.commands.submit(id, owner(app), { text: "work slowly", requestId: "slow" }),
        {
            status: 409,
            message: "This operation is not supported by this conversation's execution backend.",
        },
    );
});
