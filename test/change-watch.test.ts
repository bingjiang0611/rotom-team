// Changes told, not polled: a session's repository is watched while a tab has it open, and tabs that may read Changes
// hear that something moved (never what), then ask with their own permissions.
import { cleanUp, fakeTab, newSession, openApp, owner, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { ChangeWatches } from "../src/server/change-watch.ts";

const supported = process.platform === "darwin" || process.platform === "win32";
const settle = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Wait until `check` holds, at most `ms`. */
async function until(check: () => boolean, ms = 4000): Promise<void> {
    const end = Date.now() + ms;

    while (!check()) {
        if (Date.now() > end) {
            throw new Error("timed out");
        }

        await settle(25);
    }
}

function repository(name: string): string {
    const folder = join(root, name);

    mkdirSync(join(folder, "src"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: folder });
    writeFileSync(join(folder, "src", "a.txt"), "a\n");

    return folder;
}

after(cleanUp);

test(
    "a watched repository tells once per burst, skips git's objects and logs, and stops when closed",
    {
        skip: !supported && "recursive watching is not cheap on this platform",
    },
    async () => {
        const folder = repository("watched");
        const watches = new ChangeWatches();
        const told: boolean[] = [];
        const watch = watches.watch(join(folder, "src"), (watching) => told.push(watching));
        const second = watches.watch(folder, () => {});

        assert.equal(watch.watching, true);
        assert.equal(watches.size, 1, "one watch for the repository, whichever folder of it");
        await settle(300);
        told.length = 0;

        for (let index = 0; index < 20; index++) {
            writeFileSync(join(folder, "src", `burst-${index}.txt`), `${index}\n`);
        }

        await until(() => told.length > 0);
        await settle(700);
        assert.deepEqual(told, [true], "a burst of writes is told once");

        told.length = 0;
        mkdirSync(join(folder, ".git", "objects", "cd"), { recursive: true });
        writeFileSync(join(folder, ".git", "objects", "cd", "ef01"), "object");
        writeFileSync(join(folder, ".git", "index.lock"), "");
        rmSync(join(folder, ".git", "index.lock"));
        await settle(1000);
        assert.deepEqual(
            told,
            [],
            "a new git object or a lock alone changes nothing Changes shows",
        );

        writeFileSync(join(folder, "yarn.lock"), "a person's lock file\n");
        await until(() => told.length > 0);

        watch.close();
        assert.equal(watches.size, 1, "still watched for the other listener");
        second.close();
        assert.equal(watches.size, 0);
        told.length = 0;
        writeFileSync(join(folder, "src", "after-close.txt"), "x\n");
        await settle(800);
        assert.deepEqual(told, [], "nothing told after close");
    },
);

test("without cheap recursive watching, or outside a repository, nothing is watched", () => {
    const folder = repository("unwatched");
    const plain = mkdtempSync(join(root, "plain-"));
    const watches = new ChangeWatches(false);
    const watch = watches.watch(folder, () => assert.fail("never told"));

    assert.equal(watch.watching, false, "tabs keep reading after entries");
    watch.close();
    assert.equal(watches.size, 0);
    assert.equal(new ChangeWatches().watch(plain, () => {}).watching, true);
    assert.equal(new ChangeWatches().size, 0);
});

test(
    "tabs that may read Changes hear when the session's repository moves; viewers do not",
    {
        skip: !supported && "recursive watching is not cheap on this platform",
    },
    async () => {
        const folder = repository("session-repo");
        const app = await openApp(scriptedModel(), join(root, "watch-data"));

        try {
            const id = await newSession(app, folder);
            const tab = fakeTab(id, owner(app));
            const viewer = fakeTab(id, app.config.addUser("Vee", "viewer").user);

            await app.attach(tab.client);
            await app.attach(viewer.client);
            assert.deepEqual(tab.last("changes"), {
                conversationId: id,
                watching: true,
                moved: false,
            });
            assert.equal(app.changeWatches.size, 1);
            await settle(300);
            writeFileSync(join(folder, "src", "a.txt"), "changed by a person\n");
            await until(() =>
                tab.events.some((each) => each.event === "changes" && each.data.moved),
            );
            assert.deepEqual(tab.last("changes"), {
                conversationId: id,
                watching: true,
                moved: true,
            });
            assert.equal(
                viewer.events.some((each) => each.event === "changes"),
                false,
                "a viewer never reads Changes",
            );
            // What moved is not in the event: the tab asks, with its own permissions.
            assert.ok(
                (await app.workspace.changes(id, owner(app))).files.some(
                    (file) => file.path === "src/a.txt",
                ),
            );

            app.detach(tab.client);
            app.detach(viewer.client);
        } finally {
            await app.close();
        }

        assert.equal(app.changeWatches.size, 0, "closing the app stops every watch");
    },
);
