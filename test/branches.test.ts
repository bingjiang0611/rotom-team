// A session's git branch: shown in its view as it changes, listed for the branch picker, and switched from the app.
import {
    type App,
    cleanUp,
    fakeTab,
    seedHistoricalSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { branchesIn, gitDirOf, headOf } from "../src/server/branches.ts";

let app: App;
const upstream = join(root, "upstream");
const repo = join(root, "clone");
const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", ...args], {
        cwd,
        encoding: "utf8",
    }).trim();

before(async () => {
    // A repository with a remote: main, a branch the clone follows, and one it has only as a remote branch.
    mkdirSync(upstream, { recursive: true });
    git(upstream, "init", "-q", "-b", "main");
    writeFileSync(join(upstream, "a.txt"), "a\n");
    git(upstream, "add", "-A");
    git(upstream, "commit", "-qm", "first");
    git(upstream, "branch", "fix/payments");
    git(root, "clone", "-q", upstream, repo);
    git(repo, "commit", "-q", "--allow-empty", "-m", "local work");
    git(repo, "branch", "old-idea");
    git(repo, "worktree", "add", "-q", join(root, "elsewhere"), "-b", "in-a-worktree");
    git(repo, "worktree", "add", "-q", join(root, "odd\nfolder"), "-b", "odd-worktree");
    app = await openApp(scriptedModel());
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("the branch is read from the repository's HEAD, a worktree's included", () => {
    assert.equal(gitDirOf(join(repo, "missing", "deeper")), join(repo, ".git"));
    assert.deepEqual(headOf(gitDirOf(repo)!), { branch: "main" });
    assert.deepEqual(headOf(gitDirOf(join(root, "elsewhere"))!), { branch: "in-a-worktree" });
    assert.equal(gitDirOf("/"), undefined);

    const detached = join(root, "detached");

    git(root, "clone", "-q", upstream, detached);
    git(detached, "checkout", "-q", "--detach", "HEAD");
    assert.deepEqual(headOf(gitDirOf(detached)!), {
        detached: git(detached, "rev-parse", "--short=7", "HEAD"),
    });

    const fresh = join(root, "fresh");

    mkdirSync(fresh);
    git(fresh, "init", "-q", "-b", "trunk");
    assert.deepEqual(headOf(gitDirOf(fresh)!), { branch: "trunk" }, "before its first commit too");

    // A folder that cannot be read is in no repository as far as a view can tell: it never throws.
    const looped = join(root, "looped");

    mkdirSync(looped);
    symlinkSync(join(looped, ".git"), join(looped, ".git"));
    assert.equal(gitDirOf(looped), undefined);
});

test("branches are listed with their remote branches, worktrees, and uncommitted changes", async () => {
    writeFileSync(join(repo, "a.txt"), "changed\n");

    try {
        const branches = await branchesIn(repo);
        const main = branches.local.find((branch) => branch.name === "main");

        assert.deepEqual(branches.head, { branch: "main" });
        assert.equal(main?.current, true);
        assert.deepEqual(main?.upstream, { name: "origin/main", ahead: 1, behind: 0, gone: false });
        assert.equal(main?.subject, "local work");
        assert.equal(
            branches.local.find((branch) => branch.name === "in-a-worktree")?.worktree,
            realpathSync(join(root, "elsewhere")),
        );
        assert.equal(
            branches.local.find((branch) => branch.name === "odd-worktree")?.worktree,
            realpathSync(join(root, "odd\nfolder")),
            "a newline in a worktree's folder is part of it",
        );
        assert.equal(branches.local.find((branch) => branch.name === "old-idea")?.current, false);
        assert.deepEqual(
            branches.remote.map((branch) => branch.name),
            ["origin/fix/payments"],
            "a remote branch a local one follows is that branch",
        );
        assert.equal(branches.changed, 1);
    } finally {
        git(repo, "checkout", "-q", "--", "a.txt");
    }

    const fresh = await branchesIn(join(root, "fresh"));

    assert.deepEqual(
        fresh.local,
        [{ name: "trunk", current: true }],
        "a branch with no commits yet",
    );
});

test("legacy branch switching is rejected while branch reads remain available", async () => {
    const id = await seedHistoricalSession(app, repo);
    const me = owner(app);
    const tab = fakeTab(id, me);

    await app.attach(tab.client);

    try {
        await until(() => tab.field("branch") !== undefined, "the first view");
        assert.deepEqual(tab.field("branch"), { branch: "main" });
        await assert.rejects(
            app.workspace.switchBranch(id, me, { name: "old-idea" }),
            /read-only archive/,
        );
        assert.equal(git(repo, "branch", "--show-current"), "main");
        assert.deepEqual(
            (await app.transcripts.allEntries(id, false)).filter((entry) => entry.kind === "note"),
            [],
        );
    } finally {
        app.detach(tab.client);
    }
});

test("legacy branch mutations reject before git validation while reads remain scoped", async () => {
    const id = await seedHistoricalSession(app, repo);
    const me = owner(app);
    const viewer = app.config.addUser("Vee", "viewer").user;

    await assert.rejects(
        app.workspace.switchBranch(id, me, { name: "a..b", create: true }),
        /read-only archive/,
    );
    await assert.rejects(
        app.workspace.switchBranch(id, viewer, { name: "old-idea" }),
        /view this session but not steer/,
    );
    assert.equal((await app.workspace.branches(id, me)).head !== undefined, true);
});
