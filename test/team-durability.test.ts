import { cleanUp, context, openApp, owner, root, scriptedModel, work, say } from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import { recordUsage } from "../node_modules/@earendil-works/pi-durable/dist/harness/usage.js";
import { serializeConversation } from "../node_modules/@earendil-works/pi-durable/dist/harness/compaction.js";
import { fauxAssistantMessage, fauxThinking, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { TeamRunDoc } from "../src/server/team-execution.ts";
import { TeamUsageDoc } from "../src/server/team-usage.ts";
after(cleanUp);

test("public compaction serialization strips thinking before it becomes untyped user text", () => {
    const message = fauxAssistantMessage([
        fauxThinking("PRIVATE_ACCOUNT_REASONING"),
        fauxText("Public handoff note"),
    ]);

    message.content[0] = {
        ...message.content[0],
        thinkingSignature: "PRIVATE_SIGNATURE",
    } as (typeof message.content)[0];
    const text = serializeConversation([message]);

    assert.match(text, /Public handoff note/);
    assert.doesNotMatch(text, /PRIVATE_ACCOUNT_REASONING|PRIVATE_SIGNATURE|Assistant thinking/);
});

test("atomic usage attribution survives a handoff and restart before the delayed spend count", async () => {
    const data = join(root, "atomic-attribution");
    let app = await openApp(scriptedModel(), data);

    try {
        const a = owner(app),
            b = app.config.addUser("Bob", "guest").user;
        const { id } = await app.commands.createSession(a, { title: "atomic" });

        await app.harness.commit(async (tx) => {
            await recordUsage(tx, id, "models", `team:${a.id}:generation:openai/test`, {
                input: 1,
                output: 2,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 3,
                cost: { input: 0, output: 3, cacheRead: 0, cacheWrite: 0, total: 3 },
            });
            (await tx.doc(TeamRunDoc, id)).owner = b.id;
        }, context);
        assert.equal(
            (await app.harness.snapshot(TeamUsageDoc, id, context))!.people[a.id]!.models[
                `team:${a.id}:generation:openai/test`
            ]!.cost.total,
            3,
        );
        await app.close();
        app = await openApp(scriptedModel(), data);
        assert.equal(app.spend.personSpent(a.id), 3);
        assert.equal(app.spend.personSpent(b.id), 0);
        await app.close();
        app = await openApp(scriptedModel(), data);
        assert.equal(app.spend.personSpent(a.id), 3, "restart must not count the same usage twice");
    } finally {
        await app.close();
    }
});

test("project grants separate view, continue and fork; forks inherit scope and revocation is immediate", async () => {
    const app = await openApp(scriptedModel(), join(root, "project-grants"));

    try {
        const a = owner(app),
            b = app.config.addUser("Bob", "guest").user,
            c = app.config.addUser("Outside", "guest").user;
        let project = app.projects.save(
            a,
            {
                name: "Private project",
                cwd: work,
                members: { [b.id]: { view: true, continue: false, fork: true } },
            },
            (id) => app.config.userById(id) !== undefined,
        );
        const { id } = await app.commands.createSession(a, { title: "project" });

        await say(app, id, "shared note");
        assert.equal(app.canSee(c, id), false);
        assert.equal((await app.sessions(c)).length, 0);
        assert.equal(app.canSee(b, id), true);
        await assert.rejects(
            app.commands.submit(id, b, { text: "not allowed", requestId: "no-write" }),
            { status: 403 },
        );
        const page = await (await app.conversation(id)).entries({}, 100, undefined, context);
        const answer = page.items.find((entry) => entry.kind === "pi.assistant")!;
        const fork = await app.commands.fork(id, b, { entryId: Number(answer.id) });

        assert.equal(app.sessionMeta(fork.id)!.projectId, project.id);
        assert.equal(app.canSee(c, fork.id), false);
        project = app.projects.save(
            a,
            { ...project, members: { [b.id]: { view: true, continue: true, fork: false } } },
            (id) => app.config.userById(id) !== undefined,
        );
        await app.projectsChanged();
        await assert.rejects(app.commands.fork(id, b, { entryId: Number(answer.id) }), {
            status: 403,
        });
        await assert.rejects(app.commands.createSession(c, { title: "outsider" }), { status: 403 });
        app.projects.save(
            a,
            { ...project, members: {} },
            (member) => app.config.userById(member) !== undefined,
        );
        await app.projectsChanged();
        assert.equal(app.canSee(b, id), false);
        await assert.rejects(
            app.commands.submit(fork.id, b, { text: "revoked", requestId: "revoked" }),
            { status: 404 },
        );
    } finally {
        await app.close();
    }
});
