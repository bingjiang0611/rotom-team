import assert from "node:assert/strict";
import { mkdirSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { ProviderDoc } from "@earendil-works/pi-durable";
import { TeamProfiles } from "../src/server/team-profiles.ts";
import { PocketApp } from "../src/server/app.ts";
import { cleanUp, context, owner, root, work, scriptedModel, say } from "./helpers.ts";
after(cleanUp);
test("snapshot restart accepts canonical ancestor aliases without changing its digest", async () => {
    const parent = join(root, "profile-canonical-parent"),
        alias = join(root, "profile-parent-alias"),
        skill = join(root, "canonical-skill");

    mkdirSync(parent);
    symlinkSync(parent, alias);
    mkdirSync(skill);
    writeFileSync(
        join(skill, "SKILL.md"),
        "---\nname: canonical\ndescription: Canonical restart\n---\nFrozen asset.",
    );
    const options = {
        defaultCwd: work,
        supervised: false,
        browser: null,
        log: () => {},
        configureUserModels: (models: import("../src/server/team-accounts.ts").Runtime) =>
            models.registerNativeProvider(scriptedModel().provider),
    };
    const app = await PocketApp.open({ ...options, dataDir: join(alias, "data") });
    const member = owner(app);

    app.profiles.save(member, { name: "Canonical", instructions: "", skillDirectories: [skill] });
    const { id } = await app.commands.createSession(member, { title: "Canonical restart" });
    const snapshot = app.profiles.snapshot(id)!;
    const canonical = realpathSync(join(alias, "data"));

    await app.close();
    const restarted = await PocketApp.open({ ...options, dataDir: canonical });

    try {
        assert.equal(restarted.profiles.snapshot(id)!.digest, snapshot.digest);
        new TeamProfiles(canonical).verify(snapshot);
    } finally {
        await restarted.close();
    }
});
test("a changed snapshot refuses dispatch; failed captures remove partial asset trees", async () => {
    const data = join(root, "integrity-data"),
        skill = join(root, "integrity-skill");

    mkdirSync(skill);
    writeFileSync(
        join(skill, "SKILL.md"),
        "---\nname: integrity\ndescription: Integrity regression\n---\nOriginal skill.",
    );
    const app = await PocketApp.open({
        dataDir: data,
        defaultCwd: work,
        supervised: false,
        log: () => {},
        browser: null,
        configureUserModels: (models) => models.registerNativeProvider(scriptedModel().provider),
    });

    try {
        const member = owner(app);

        app.profiles.save(member, {
            name: "Integrity",
            instructions: "",
            skillDirectories: [skill],
        });
        const { id } = await app.commands.createSession(member, { title: "Integrity" });

        await say(app, id, "initial turn");
        const captured = app.profiles.snapshot(id)!;
        const model = (await app.agentState(id))!.model!;
        const provider = (await app.harness.snapshot(ProviderDoc, id, context))!;

        writeFileSync(captured.skills[0]!.path, "Changed after capture.");
        assert.throws(() => app.profiles.snapshot(id), /snapshot content changed/);
        await assert.rejects(
            app.execution.authorize(model.provider, provider.sessionId),
            /snapshot content changed/,
        );
        const before = readdirSync(join(data, "configuration-snapshots"));

        symlinkSync(join(skill, "SKILL.md"), join(skill, "unsafe-link"));
        await assert.rejects(
            app.commands.createSession(member, { title: "Refused capture" }),
            /contains a symlink/,
        );
        assert.deepEqual(readdirSync(join(data, "configuration-snapshots")), before);
    } finally {
        await app.close();
    }
});
