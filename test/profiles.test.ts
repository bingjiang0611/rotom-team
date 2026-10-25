import { cleanUp, context, openApp, owner, root, scriptedModel, work, say } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { ConfigurationDoc } from "../src/server/team-profiles.ts";

after(cleanUp);

test("personal profile and complete skills freeze per conversation, survive restart, and remain on fork", async () => {
    const data = join(root, "profiles-test");
    const skill = join(root, "personal", "handoff");

    mkdirSync(join(skill, "references"), { recursive: true });
    writeFileSync(
        join(skill, "SKILL.md"),
        "---\nname: handoff\ndescription: Shared handoff instructions\n---\nOriginal instructions\n",
    );
    writeFileSync(join(skill, "references", "check.md"), "original reference");
    writeFileSync(join(work, "AGENTS.md"), "project rules v1");
    let app = await openApp(scriptedModel(), data);

    try {
        const alice = owner(app);

        app.profiles.save(alice, {
            name: "Alice",
            instructions: "personal rules v1",
            skillDirectories: [skill],
        });
        const { id } = await app.commands.createSession(alice, { title: "snapshot" });
        const config = (await app.harness.snapshot(ConfigurationDoc, id, context))!.snapshot!;

        assert.match(config.context, /project rules v1/);
        assert.match(config.context, /personal rules v1/);
        assert.equal(config.skills.length, 1);
        writeFileSync(join(work, "AGENTS.md"), "project rules v2");
        writeFileSync(join(skill, "references", "check.md"), "edited reference");
        writeFileSync(
            join(skill, "SKILL.md"),
            "---\nname: handoff\ndescription: Shared handoff instructions\n---\nChanged instructions\n",
        );
        app.profiles.save(alice, {
            name: "Alice v2",
            instructions: "personal rules v2",
            skillDirectories: [skill],
        });
        assert.equal(
            readFileSync(join(config.skills[0]!.baseDir, "references", "check.md"), "utf8"),
            "original reference",
        );
        await say(app, id, "/skill:handoff summarize");
        const transcript = await (await app.harness.conversation(id, context))!.context(context);

        assert.match(JSON.stringify(transcript.messages), /Original instructions/);
        assert.doesNotMatch(
            JSON.stringify(transcript.messages),
            /Changed instructions|personal rules v2|project rules v2/,
        );
        const page = await (await app.harness.conversation(id, context))!.entries(
            {},
            100,
            undefined,
            context,
        );
        const answer = page.items.findLast((entry) => entry.kind === "pi.assistant")!;
        const fork = await app.commands.fork(id, alice, { entryId: Number(answer.id) });

        assert.equal(
            (await app.harness.snapshot(ConfigurationDoc, fork.id, context))!.snapshot!.digest,
            config.digest,
        );
        await app.close();
        app = await openApp(scriptedModel(), data);
        assert.equal(app.profiles.snapshot(id)!.digest, config.digest);
        assert.equal((await app.skillCommands(id))[0]!.path, config.skills[0]!.path);
        const newer = await app.commands.createSession(owner(app), { title: "new version" });

        assert.notEqual(app.profiles.snapshot(newer.id)!.digest, config.digest);
    } finally {
        await app.close();
    }
});

test("profile edits are personal; viewer, service-data imports, and colliding skill names are rejected", async () => {
    const app = await openApp(scriptedModel(), join(root, "profile-boundaries"));

    try {
        const alice = owner(app),
            bob = app.config.addUser("Bob", "guest").user;

        app.profiles.save(alice, {
            name: "Alice",
            instructions: "private until activated",
            skillDirectories: [],
        });
        assert.equal(app.profiles.get(bob).instructions, "");
        assert.throws(
            () =>
                app.profiles.save(app.config.addUser("Viewer", "viewer").user, {
                    name: "x",
                    instructions: "",
                    skillDirectories: [],
                }),
            { status: 403 },
        );
        assert.throws(
            () =>
                app.profiles.save(alice, {
                    name: "x",
                    instructions: "",
                    skillDirectories: [app.dataDir],
                }),
            { status: 400 },
        );
        const first = join(root, "collision-a"),
            second = join(root, "collision-b");

        for (const path of [first, second]) {
            mkdirSync(path);
            writeFileSync(
                join(path, "SKILL.md"),
                "---\nname: duplicate\ndescription: Duplicate test skill\n---\nTest\n",
            );
        }

        app.profiles.save(alice, {
            name: "collision",
            instructions: "",
            skillDirectories: [first, second],
        });
        await assert.rejects(app.commands.createSession(alice, { title: "no collision" }), {
            status: 400,
        });
        const linked = join(root, "linked-skill");

        symlinkSync(first, linked);
        assert.throws(
            () =>
                app.profiles.save(alice, {
                    name: "link",
                    instructions: "",
                    skillDirectories: [linked],
                }),
            { status: 400 },
        );
    } finally {
        await app.close();
    }
});
