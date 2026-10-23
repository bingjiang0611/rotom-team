import { spawnSync } from "node:child_process";
import {
    chmodSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

const checker = resolve("scripts/check-staged-file-size.mjs");
const installer = resolve("scripts/install-git-hooks.mjs");
let directory: string;
let cwd: string;
let env: NodeJS.ProcessEnv;

function run(command: string, args: string[]) {
    return spawnSync(command, args, { cwd, env, encoding: "utf8" });
}

function git(...args: string[]) {
    const result = run("git", args);

    assert.equal(result.status, 0, result.stderr);

    return result.stdout.trim();
}

function file(path: string, content: string) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
}

function stage(path: string, content: string) {
    file(path, content);
    git("add", "--", path);
}

function check() {
    return run(process.execPath, [checker]);
}

beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "rotom-team-file-budget-"));
    cwd = join(directory, "repository with spaces");
    mkdirSync(cwd);
    env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
    );
    env.GIT_CONFIG_NOSYSTEM = "1";
    env.GIT_CONFIG_GLOBAL = join(directory, "gitconfig");
    writeFileSync(env.GIT_CONFIG_GLOBAL, "");
    git("init", "--template=", "--initial-branch=main");
    git("config", "user.name", "Hook test");
    git("config", "user.email", "hook@example.invalid");
    git("config", "commit.gpgsign", "false");
    file(".githooks/pre-commit", readFileSync(resolve(".githooks/pre-commit"), "utf8"));
    chmodSync(join(cwd, ".githooks/pre-commit"), 0o755);
    mkdirSync(join(cwd, "scripts"));
    copyFileSync(checker, join(cwd, "scripts/check-staged-file-size.mjs"));
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe("staged file budget", () => {
    it("accepts an empty index and exactly 20,000 bytes, rejects one byte more", () => {
        assert.equal(check().status, 0);
        stage("boundary.ts", "a".repeat(20_000));
        assert.equal(check().status, 0);
        stage("boundary.ts", "a".repeat(20_001));
        const result = check();

        assert.equal(result.status, 1);
        assert.ok(result.stderr.includes("20001 bytes"));
        assert.ok(result.stderr.includes("Split by responsibility"));
        assert.ok(result.stderr.includes("Update imports and tests"));
    });

    it("checks index contents in both partial-staging directions, not unstaged files", () => {
        stage("partial.ts", "small");
        file("partial.ts", "x".repeat(20_001));
        file("untracked.ts", "x".repeat(20_001));
        assert.equal(check().status, 0);
        git("add", "partial.ts");
        file("partial.ts", "small");
        assert.equal(check().status, 1);
    });

    it("handles Unicode, spaces, newlines, leading dashes and byte rather than character counts", () => {
        const path = "-中文 space\nname.ts";

        stage(path, "中".repeat(6_667));
        const result = check();

        assert.equal(result.status, 1);
        assert.ok(result.stderr.includes(JSON.stringify(path)));
        assert.ok(result.stderr.includes("20001 bytes"));
    });

    it("exempts explicit lockfiles, generated outputs and binary assets, not arbitrary generated folders", () => {
        for (const path of [
            "package-lock.json",
            "nested/pnpm-lock.yaml",
            "ios/Package.resolved",
            "assets/resource.png",
            "assets/resource.woff2",
        ]) {
            stage(path, "x".repeat(20_001));
        }

        assert.equal(check().status, 0);
        stage("generated/handwritten.ts", "x".repeat(20_001));
        assert.equal(check().status, 1);
    });

    it("checks modified legacy files but ignores unchanged and deleted large files", () => {
        stage("legacy.ts", "x".repeat(20_001));
        git("-c", "core.hooksPath=/dev/null", "commit", "-m", "legacy baseline");
        assert.equal(check().status, 0);
        stage("legacy.ts", "x".repeat(20_002));
        assert.equal(check().status, 1);
        git("rm", "-f", "legacy.ts");
        assert.equal(check().status, 0);
    });

    it("checks renamed exempt files at their new path and ignores symlink targets", () => {
        stage("package-lock.json", "x".repeat(20_001));
        git("commit", "-m", "lockfile");
        git("mv", "package-lock.json", "source.ts");
        assert.equal(check().status, 1);
        git("reset", "--hard", "HEAD");
        symlinkSync("package-lock.json", join(cwd, "link.ts"));
        git("add", "link.ts");
        assert.equal(check().status, 0);
    });

    it("fails closed outside a Git repository", () => {
        cwd = directory;
        assert.notEqual(check().status, 0);
    });
});

describe("hook installation and real commits", () => {
    it("installs idempotently and blocks a real commit until the staged file is split", () => {
        assert.equal(run(process.execPath, [installer]).status, 0);
        assert.equal(run(process.execPath, [installer]).status, 0);
        stage("large.ts", "x".repeat(20_001));
        const blocked = run("git", ["commit", "-m", "must fail"]);

        assert.notEqual(blocked.status, 0);
        assert.ok(blocked.stderr.includes("Commit blocked"));
        assert.notEqual(run("git", ["rev-parse", "--verify", "HEAD"]).status, 0);
        stage("large.ts", "x".repeat(10_000));
        stage("extracted.ts", "x".repeat(10_001));
        git("commit", "-m", "split files");
        assert.equal(git("log", "-1", "--format=%s"), "split files");
    });

    it("preserves and executes existing global hooks without modifying global configuration", () => {
        const hooks = join(directory, "global hooks");

        mkdirSync(hooks);
        writeFileSync(join(hooks, "post-commit"), "#!/bin/sh\nprintf preserved > hook-ran\n");
        chmodSync(join(hooks, "post-commit"), 0o755);
        git("config", "--global", "core.hooksPath", hooks);
        const originalConfig = readFileSync(env.GIT_CONFIG_GLOBAL!, "utf8");

        assert.equal(run(process.execPath, [installer]).status, 0);
        const installed = git("config", "--local", "--get", "core.hooksPath");

        assert.equal(
            realpathSync(join(installed, "post-commit")),
            realpathSync(join(hooks, "post-commit")),
        );
        stage("small.ts", "small");
        git("commit", "-m", "run preserved hook");
        assert.equal(readFileSync(join(cwd, "hook-ran"), "utf8"), "preserved");
        assert.equal(readFileSync(env.GIT_CONFIG_GLOBAL!, "utf8"), originalConfig);
    });

    it("refuses to overwrite an existing pre-commit hook", () => {
        const previous = join(cwd, ".git/hooks/pre-commit");

        mkdirSync(dirname(previous), { recursive: true });
        writeFileSync(previous, "#!/bin/sh\nexit 0\n");
        const result = run(process.execPath, [installer]);

        assert.notEqual(result.status, 0);
        assert.ok(result.stderr.includes("Existing pre-commit hook"));
        assert.equal(readFileSync(previous, "utf8"), "#!/bin/sh\nexit 0\n");
        assert.equal(existsSync(join(cwd, ".git/rotom-team-hooks")), false);
        assert.equal(run("git", ["config", "--local", "--get", "core.hooksPath"]).status, 1);
    });
});
