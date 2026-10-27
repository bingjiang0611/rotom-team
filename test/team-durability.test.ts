import {
    cleanUp,
    context,
    openApp,
    openNativeApp,
    owner,
    root,
    scriptedModel,
    work,
    seedHistoricalSession,
} from "./helpers.ts";
import { mkdirSync, realpathSync } from "node:fs";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import { recordUsage } from "../node_modules/@earendil-works/pi-durable/dist/harness/usage.js";
import { serializeConversation } from "../node_modules/@earendil-works/pi-durable/dist/harness/compaction.js";
import { fauxAssistantMessage, fauxThinking, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { TeamRunDoc } from "../src/server/team-execution.ts";
import { TeamUsageDoc } from "../src/server/team-usage.ts";
import { SessionsDoc } from "../src/server/docs.ts";
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
        const id = await seedHistoricalSession(app);

        await app.harness.commit(async (tx) => {
            (await tx.doc(SessionsDoc)).items[String(id)]!.createdBy = a.id;
            (await tx.doc(TeamRunDoc, id)).owner = a.id;
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

test("native project grants separate view, continue and fork; revocation is immediate", async () => {
    const data = join(realpathSync(root), "project-grants");

    mkdirSync(data, { mode: 0o700 });
    const app = await openNativeApp(scriptedModel(), data);

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
        const { id } = await app.commands.createSession(a, { title: "project", backend: "rotom" });

        assert.equal(app.sessionMeta(id)?.projectId, project.id);
        assert.equal(app.canSee(c, id), false);
        assert.equal((await app.sessions(c)).length, 0);
        assert.equal(app.canSee(b, id), true);
        await assert.rejects(app.requireDriver(id, b, "rotom"), { status: 403 });
        assert.doesNotThrow(() => app.commands.requireForkable(id, b, "rotom"));
        // Actual native fork inheritance/continuation is exercised by team-kernel-proof.ts,
        // apiForkIdempotencyConfigurationAndPayer and forkAndContinuePermissionsIndependent.
        project = app.projects.save(
            a,
            { ...project, members: { [b.id]: { view: true, continue: true, fork: false } } },
            (id) => app.config.userById(id) !== undefined,
        );
        await app.projectsChanged();
        assert.throws(() => app.commands.requireForkable(id, b, "rotom"), { status: 403 });
        await app.requireDriver(id, b, "rotom");
        await assert.rejects(
            app.commands.createSession(c, { title: "outsider", backend: "rotom" }),
            { status: 403 },
        );
        app.projects.save(
            a,
            { ...project, members: {} },
            (member) => app.config.userById(member) !== undefined,
        );
        await app.projectsChanged();
        assert.equal(app.canSee(b, id), false);
        assert.throws(() => app.requireSee(b, id), { status: 404 });
        await assert.rejects(app.requireDriver(id, b, "rotom"), { status: 403 });
        assert.throws(() => app.commands.requireForkable(id, b, "rotom"), { status: 404 });
    } finally {
        await app.close();
    }
});
