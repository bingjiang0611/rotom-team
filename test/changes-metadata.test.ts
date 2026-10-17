// Changes metadata batching must preserve Git state, paths, and fresh reads.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { changesIn, diffOf } from "../src/server/changes.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "changes-metadata-")));

after(() => rmSync(root, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function repository(name: string, commit = true): string {
    const cwd = join(root, name);

    mkdirSync(cwd, { recursive: true });
    git(cwd, "init", "-q", "-b", "main");
    git(cwd, "config", "user.name", "Test");
    git(cwd, "config", "user.email", "test@example.invalid");
    writeFileSync(join(cwd, "tracked.txt"), "original\n");

    if (commit) {
        git(cwd, "add", ".");
        git(cwd, "commit", "-qm", "seed");
    }

    return cwd;
}

test("fresh branch and HEAD metadata follow external checkout and commits", async () => {
    const cwd = repository("fresh");
    const first = git(cwd, "rev-parse", "HEAD");

    writeFileSync(join(cwd, "tracked.txt"), "changed\n");
    assert.deepEqual((await changesIn(cwd, [])).repo, { root: cwd, branch: "main", head: first });
    assert.match(await diffOf(cwd, "tracked.txt"), /^\+changed$/m);
    git(cwd, "switch", "-qc", "next");
    git(cwd, "commit", "-qam", "next");
    const second = git(cwd, "rev-parse", "HEAD");

    assert.notEqual(second, first);
    assert.deepEqual((await changesIn(cwd, [])).repo, { root: cwd, branch: "next", head: second });
    await assert.rejects(diffOf(cwd, "tracked.txt"), /no uncommitted changes/);
    git(cwd, "checkout", "--detach", "-q", first);
    writeFileSync(join(cwd, "tracked.txt"), "detached\n");
    assert.deepEqual((await changesIn(cwd, [])).repo, { root: cwd, branch: "HEAD", head: first });
    assert.match(await diffOf(cwd, "tracked.txt"), /^\+detached$/m);
});

test("an unborn branch retains absent branch/head and complete staged/untracked diffs", async () => {
    const cwd = repository("unborn", false);

    git(cwd, "add", "tracked.txt");
    writeFileSync(join(cwd, "new.txt"), "new\n");
    const changes = await changesIn(cwd, []);

    assert.deepEqual(changes.repo, { root: cwd });
    assert.deepEqual(
        changes.files.map(({ path, kind, added, removed }) => ({ path, kind, added, removed })),
        [
            { path: "tracked.txt", kind: "added", added: undefined, removed: undefined },
            { path: "new.txt", kind: "new", added: undefined, removed: undefined },
        ],
    );
    assert.match(await diffOf(cwd, "tracked.txt"), /^\+original$/m);
    assert.match(await diffOf(cwd, "new.txt"), /^\+new$/m);
});

test("subfolder scope and control characters in repository/file paths stay intact", async () => {
    const cwd = repository("root\nwith-newline");
    const folder = join(cwd, "public");
    const file = "public/line\nwith\ttab.txt";

    mkdirSync(folder);
    writeFileSync(join(cwd, file), "visible\n");
    writeFileSync(join(cwd, "private.txt"), "private\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "paths");
    writeFileSync(join(cwd, file), "visible changed\n");
    writeFileSync(join(cwd, "private.txt"), "secret changed\n");
    const changes = await changesIn(folder, [], true);

    assert.equal(changes.repo?.root, cwd);
    assert.deepEqual(
        changes.files.map((entry) => entry.path),
        [file],
    );
    assert.match(await diffOf(folder, file, true), /^\+visible changed$/m);
    await assert.rejects(diffOf(folder, "private.txt", true), /no uncommitted changes/);
});

test("linked worktrees use their own HEAD and errors outside Git remain errors", async () => {
    const cwd = repository("worktree");
    const linked = join(root, "linked");

    git(cwd, "worktree", "add", "-qb", "linked", linked);
    writeFileSync(join(linked, "tracked.txt"), "linked change\n");
    assert.deepEqual((await changesIn(linked, [])).repo, {
        root: linked,
        branch: "linked",
        head: git(linked, "rev-parse", "HEAD"),
    });
    assert.match(await diffOf(linked, "tracked.txt"), /^\+linked change$/m);
    assert.equal((await changesIn(root, [])).repo, undefined);
    await assert.rejects(diffOf(root, "tracked.txt"), /not a git repository/);
});
