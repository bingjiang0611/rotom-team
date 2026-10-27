import { cleanUp, openApp, owner, root, scriptedModel, seedHistoricalSession } from "./helpers.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test, after } from "node:test";
import { ConfigStore } from "../src/server/config.ts";
import { SessionsDoc } from "../src/server/docs.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

after(cleanUp);

test("finished marks coalesce, save fsyncs file before rename and directory after, and stale marks are pruned", (t) => {
    const config = new ConfigStore(join(root, "finished-config"));
    const member = config.addUser("member", "guest").user;
    const steps: string[] = [];
    const fsync = fs.fsyncSync;
    const rename = fs.renameSync;
    const synced = t.mock.method(fs, "fsyncSync", (fd: number) => {
        steps.push(fs.fstatSync(fd).isDirectory() ? "directory" : "file");
        fsync(fd);
    });
    const renamed = t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
        steps.push("rename");

        return rename(...args);
    });

    syncBuiltinESMExports();
    t.mock.timers.enable({ apis: ["setTimeout"] });

    try {
        for (let value = 1; value <= 10; value++) {
            config.markFinishedSeen(member.id, "kept", value);
        }

        assert.deepEqual(steps, []);
        t.mock.timers.tick(999);
        assert.deepEqual(steps, []);
        t.mock.timers.tick(1);
        assert.deepEqual(steps, ["file", "rename", "directory"]);
        assert.equal(
            new ConfigStore(join(root, "finished-config")).userById(member.id)?.finishedSeen?.kept,
            10,
        );
        config.markFinishedSeen(member.id, "deleted", 20);
        config.pruneFinishedSeen(["kept"]);
        const writes = steps.length;

        t.mock.timers.tick(1000);
        assert.equal(steps.length, writes, "immediate save also consumes the pending batch");
        assert.deepEqual(config.userById(member.id)?.finishedSeen, { kept: 10 });
        config.removeUser(member.id);
        assert.equal(new ConfigStore(join(root, "finished-config")).userById(member.id), undefined);
    } finally {
        synced.mock.restore();
        renamed.mock.restore();
        syncBuiltinESMExports();
    }
});

test("app close flushes pending markers and catalogue removal cleans all members", async () => {
    const data = join(root, "finished-app");
    const app = await openApp(scriptedModel(), data);
    const user = owner(app);
    const session = await seedHistoricalSession(app);
    const other = await seedHistoricalSession(app);

    try {
        app.config.markFinishedSeen(user.id, String(session), 1);
        app.config.markFinishedSeen(user.id, String(other), 2);
        await app.harness.commit(async (tx) => {
            delete (await tx.doc(SessionsDoc)).items[String(session)];
        }, BACKGROUND_CONTEXT);
        assert.equal(app.config.userById(user.id)?.finishedSeen?.[String(session)], undefined);
        app.config.markFinishedSeen(user.id, String(other), 3);
    } finally {
        await app.close();
    }

    assert.equal(new ConfigStore(data).userById(user.id)?.finishedSeen?.[String(other)], 3);
});
