// Native creation and filesystem worktree primitives remain supported; legacy execution/removal does not.
import {
    type App,
    cleanUp,
    context,
    appendHistoricalTurn,
    modelTexts,
    seedHistoricalSession,
    openNativeApp,
    owner,
    root,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
    createWorktree,
    inWorktree,
    removeWorktree,
    sourceFolders,
} from "../src/server/worktrees.ts";

let app: App;
const repo = join(root, "repo");
const data = join(realpathSync(root), "worktree-data");
const gitIn = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

before(async () => {
    mkdirSync(join(repo, "app"), { recursive: true });
    gitIn(repo, "init", "-q");
    gitIn(repo, "config", "user.email", "t@example.com");
    gitIn(repo, "config", "user.name", "T");
    writeFileSync(join(repo, "app", "main.ts"), "export const answer = 1;\n");
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
    gitIn(repo, "add", "-A");
    gitIn(repo, "commit", "-qm", "init");
    writeFileSync(join(repo, "app", "main.ts"), "export const answer = 2;\n");
    writeFileSync(join(repo, "app", "notes.md"), "new notes\n");
    mkdirSync(join(repo, "node_modules"));
    writeFileSync(join(repo, "node_modules", "big.js"), "ignored\n");
    mkdirSync(data, { mode: 0o700 });
    app = await openNativeApp(scriptedModel(), data);
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("native worktree creation copies dirty and untracked files, not ignored files, into an isolated branch", async () => {
    const { id } = await app.commands.createSession(owner(app), {
        backend: "rotom",
        cwd: join(repo, "app"),
        title: "Try B",
        worktree: true,
    });
    const worktree = app.sessionMeta(id)!.worktree!;
    const cwd = app.cwdOf(id);

    assert.match(worktree.branch, /^pocket\/try-b-[0-9a-f]{6}$/);
    assert.equal(worktree.source, join(repo, "app"));
    assert.ok(worktree.path.startsWith(join(data, "worktrees")));
    assert.equal(cwd, join(worktree.path, "app"));
    assert.equal(readFileSync(join(cwd, "main.ts"), "utf8"), "export const answer = 2;\n");
    assert.equal(readFileSync(join(cwd, "notes.md"), "utf8"), "new notes\n");
    assert.equal(existsSync(join(worktree.path, "node_modules")), false);
    assert.equal(gitIn(cwd, "rev-parse", "--abbrev-ref", "HEAD"), worktree.branch);
    // Filesystem isolation, not a simulated tool invocation.
    writeFileSync(join(cwd, "plan.md"), "a separate checkout\n");
    assert.equal(existsSync(join(repo, "app", "plan.md")), false);
    assert.equal(readFileSync(join(repo, "app", "main.ts"), "utf8"), "export const answer = 2;\n");
});

test("standalone worktree removal requires force for dirty files and preserves its branch", async () => {
    // This checkout is owned by this helper test, not a live native session.
    const made = await createWorktree(join(repo, "app"), join(root, "helper-worktrees"), "Removal");

    await assert.rejects(removeWorktree(made.worktree, false), {
        status: 409,
        message: /uncommitted changes/,
    });
    assert.equal(existsSync(made.worktree.path), true);
    await removeWorktree(made.worktree, true);
    assert.equal(existsSync(made.worktree.path), false);
    assert.match(
        gitIn(repo, "branch", "--list", made.worktree.branch),
        new RegExp(made.worktree.branch),
    );
});

test("historical separate-worktree forks reject while nonrepository native creation makes no session", async () => {
    const id = await seedHistoricalSession(app, join(repo, "app"));

    await appendHistoricalTurn(app, id, "historical question", "historical answer");
    const conversation = await app.conversation(id);
    const page = await conversation.entries({}, 10, undefined, context);
    const answer = page.items.find((entry) => entry.kind === "pi.assistant")!;
    const history = await modelTexts(app, id);
    const before = (await app.sessions()).length;

    await assert.rejects(
        app.commands.fork(id, owner(app), { entryId: Number(answer.id), worktree: true }),
        /read-only archive/,
    );
    assert.deepEqual(await modelTexts(app, id), history);
    assert.equal((await app.sessions()).length, before);
    const plain = join(root, "plain");

    mkdirSync(plain);
    await assert.rejects(
        app.commands.createSession(owner(app), { backend: "rotom", cwd: plain, worktree: true }),
        { status: 400, message: /not in a git repository/ },
    );
    assert.equal((await app.sessions()).length, before);
});

test("a symbolic source folder maps to the matching native checkout and retains its original spelling", async () => {
    const link = join(root, "linked");

    symlinkSync(repo, link);
    const source = join(link, "app");
    const { id } = await app.commands.createSession(owner(app), {
        backend: "rotom",
        cwd: source,
        worktree: true,
    });
    const worktree = app.sessionMeta(id)!.worktree!;

    assert.equal(app.cwdOf(id), join(worktree.path, "app"));
    assert.equal(existsSync(join(app.cwdOf(id), "main.ts")), true);
    assert.equal(worktree.source, source);
    const original = await sourceFolders(worktree);

    assert.equal(original(app.cwdOf(id)), source);
    const onlyHere = join(worktree.path, "only-here");

    mkdirSync(onlyHere);
    assert.equal(original(onlyHere), source, "a worktree-only folder maps to the original source");
});

test("native session worktree removal is unsupported and changes neither metadata nor checkout", async () => {
    const { id } = await app.commands.createSession(owner(app), {
        backend: "rotom",
        cwd: join(repo, "app"),
        worktree: true,
    });
    const before = structuredClone(app.sessionMeta(id));
    const cwd = app.cwdOf(id);

    for (const force of [false, true]) {
        await assert.rejects(app.commands.removeWorktree(id, owner(app), force), {
            status: 409,
            message: /not supported.*execution backend/,
        });
        assert.deepEqual(app.sessionMeta(id), before);
        assert.equal(app.cwdOf(id), cwd);
        assert.equal(existsSync(join(cwd, "main.ts")), true);
    }
});

test("worktree membership recognizes symlink aliases, nested folders, and shared historical readers", async () => {
    const made = await createWorktree(join(repo, "app"), join(root, "shared-worktrees"), "Shared");
    const alias = join(root, "shared-alias");

    symlinkSync(made.worktree.path, alias);
    assert.equal(inWorktree(made.worktree, alias), true);
    assert.equal(inWorktree(made.worktree, join(alias, "app")), true);
    assert.equal(inWorktree(made.worktree, made.cwd), true);
    assert.equal(inWorktree(made.worktree, repo), false);
    assert.equal(inWorktree(made.worktree, `${made.worktree.path}-sibling`), false);
    const first = await seedHistoricalSession(app, made.cwd);
    const second = await seedHistoricalSession(app, join(alias, "app"));

    await appendHistoricalTurn(app, first, "first historical checkout", "retained first reply");
    await appendHistoricalTurn(app, second, "second historical checkout", "retained second reply");
    await assert.rejects(
        app.commands.configure(second, owner(app), { cwd: join(repo, "app") }),
        /read-only archive/,
    );
    assert.equal(app.cwdOf(first), made.cwd);
    assert.equal(app.cwdOf(second), join(alias, "app"));
    assert.equal(existsSync(join(app.cwdOf(second), "main.ts")), true);
    assert.match((await modelTexts(app, first)).join("\n"), /retained first reply/);
    assert.match((await modelTexts(app, second)).join("\n"), /retained second reply/);
});
