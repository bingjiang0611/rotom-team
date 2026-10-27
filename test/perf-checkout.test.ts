import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { copyWorkingTree } from "./perf/checkout.ts";

test("performance checkouts carry staged, unstaged, new, deleted and moved files without changing the source index", (t) => {
    const root = mkdtempSync(join(tmpdir(), "perf-checkout-fixture-"));
    const repo = join(root, "source");
    const target = join(root, "target");

    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(repo);
    const git = (...args: string[]) =>
        execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });

    git("init", "--quiet");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");

    for (const name of ["staged", "unstaged", "partial", "removed", "deleted", "before"]) {
        writeFileSync(join(repo, `${name}.txt`), "base");
    }

    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Fixture baseline");
    cpSync(repo, target, { recursive: true });
    writeFileSync(join(repo, "staged.txt"), "staged change");
    writeFileSync(join(repo, "partial.txt"), "staged portion");
    mkdirSync(join(repo, "new", "deep"), { recursive: true });
    writeFileSync(join(repo, "new", "deep", "staged.txt"), "staged addition");
    git("add", "staged.txt", "partial.txt", "new/deep/staged.txt");
    writeFileSync(join(repo, "partial.txt"), "complete on-disk change");
    writeFileSync(join(repo, "unstaged.txt"), "unstaged change");
    writeFileSync(join(repo, "new", "untracked.txt"), "untracked addition");
    git("rm", "--quiet", "removed.txt");
    rmSync(join(repo, "deleted.txt"));
    git("mv", "before.txt", "after.txt");
    const index = git("diff", "--cached", "--binary");
    const status = git("status", "--porcelain");

    copyWorkingTree(repo, target);

    for (const [name, value] of [
        ["staged.txt", "staged change"],
        ["partial.txt", "complete on-disk change"],
        ["unstaged.txt", "unstaged change"],
        ["new/deep/staged.txt", "staged addition"],
        ["new/untracked.txt", "untracked addition"],
        ["after.txt", "base"],
    ] as const) {
        assert.equal(readFileSync(join(target, name), "utf8"), value, name);
    }

    for (const name of ["removed.txt", "deleted.txt", "before.txt"]) {
        assert.equal(existsSync(join(target, name)), false, name);
    }

    assert.equal(git("diff", "--cached", "--binary"), index);
    assert.equal(git("status", "--porcelain"), status);
});
