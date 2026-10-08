import { cleanUp, openApp, owner, root, scriptedModel, context, say } from "./helpers.ts";
import assert from "node:assert/strict";
import {
    existsSync,
    mkdirSync,
    readdirSync,
    renameSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { backup, restore } from "../scripts/data.mjs";
after(cleanUp);
test("offline backup refuses a live writer and restores sessions/configuration without reviving refresh credentials", async () => {
    const data = join(root, "deployment"),
        archive = join(root, "backup");
    let app = await openApp(scriptedModel(), data);
    const { id } = await app.commands.createSession(owner(app), { title: "restored history" });

    await say(app, id, "persist me");
    const digest = app.profiles.snapshot(id)!.digest;

    assert.throws(() => backup(data, archive), /already running/);
    await app.close();
    const alias = join(root, "backup-data-alias");

    symlinkSync(data, alias);
    const before = readdirSync(data);

    assert.throws(() => backup(data, join(alias, "inside")), /outside the data/);
    assert.deepEqual(
        readdirSync(data),
        before,
        "Reject before creating a recursive staging tree or writer lock",
    );
    const account = join(data, "people", owner(app).id);

    mkdirSync(account, { recursive: true });
    writeFileSync(
        join(account, "auth.json"),
        JSON.stringify({
            qoder: { type: "oauth", refresh: "fixture-only", access: "fixture-only", expires: 0 },
        }),
    );
    backup(data, archive);
    assert.throws(() => restore(archive, data), /already exists/);
    assert.throws(() => restore(archive, join(root, "relocated")), /original absolute/);
    renameSync(data, join(root, "retired"));
    restore(archive, data);
    assert.equal(existsSync(join(account, "auth.json")), false);
    app = await openApp(scriptedModel(), data);

    try {
        assert.equal(app.profiles.snapshot(id)!.digest, digest);
        const history = await (await app.conversation(id)).context(context);

        assert.match(JSON.stringify(history.messages), /persist me/);
        assert.equal(app.sessions().length, 1);
    } finally {
        await app.close();
    }
});
