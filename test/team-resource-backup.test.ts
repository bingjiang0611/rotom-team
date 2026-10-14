/** A real locked local npm install, backup and restore. No registry, scripts, model account or production data. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
    existsSync,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { backup, restore } from "../scripts/data.mjs";
import { prepareTeamResources } from "../src/server/rotom-resources.ts";

test("shared npm bin links are rebuildable cache; exact locks/config/state survive backup and restore", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "team-resource-backup-")));
    const data = join(root, "data"),
        shared = join(data, "team-agent"),
        npm = join(shared, "npm"),
        home = join(data, "kernel-homes/member"),
        workspace = join(root, "project"),
        archive = join(root, "backup");

    for (const dir of [npm, home, workspace, join(shared, "fixture-package")]) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    writeFileSync(
        join(shared, "fixture-package/package.json"),
        JSON.stringify({
            name: "backup-fixture",
            version: "1.0.0",
            bin: { fixture: "bin.js" },
            pi: { extensions: ["index.ts"] },
        }),
    );
    writeFileSync(join(shared, "fixture-package/bin.js"), "#!/usr/bin/env node\n");
    writeFileSync(join(shared, "fixture-package/index.ts"), "export default () => {};\n");
    writeFileSync(
        join(npm, "package.json"),
        JSON.stringify({
            private: true,
            dependencies: { "backup-fixture": "file:../fixture-package" },
        }),
    );
    writeFileSync(join(shared, "settings.json"), '{"packages":["npm:backup-fixture@1.0.0"]}');
    writeFileSync(join(shared, "AGENTS.md"), "OWNER_BASE");
    writeFileSync(join(home, "unknown-runtime.json"), "PRIVATE_STATE");
    const env = {
        PATH: process.env.PATH,
        HOME: home,
        npm_config_cache: join(root, "npm-cache"),
        npm_config_userconfig: join(root, "empty-user.npmrc"),
        npm_config_globalconfig: join(root, "empty-global.npmrc"),
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_update_notifier: "false",
    };
    const install = () =>
        execFileSync("npm", ["ci", "--offline", "--ignore-scripts"], {
            cwd: npm,
            env,
            stdio: "pipe",
        });

    execFileSync("npm", ["install", "--package-lock-only", "--offline", "--ignore-scripts"], {
        cwd: npm,
        env,
        stdio: "pipe",
    });
    install();
    assert.ok(existsSync(join(npm, "node_modules/.bin/fixture")));
    await prepareTeamResources(home, shared, workspace);
    const lock = readFileSync(join(npm, "package-lock.json"), "utf8");

    backup(data, archive);
    const manifest = JSON.parse(readFileSync(join(archive, "manifest.json"), "utf8"));

    assert.deepEqual(manifest.excludedCaches, ["team-agent/npm/node_modules"]);
    assert.ok(
        !manifest.files.some((file: { path: string }) =>
            file.path.startsWith("team-agent/npm/node_modules/"),
        ),
    );
    rmSync(data, { recursive: true });
    restore(archive, data);
    assert.equal(readFileSync(join(npm, "package-lock.json"), "utf8"), lock);
    assert.equal(readFileSync(join(shared, "AGENTS.md"), "utf8"), "OWNER_BASE");
    assert.equal(readFileSync(join(home, "unknown-runtime.json"), "utf8"), "PRIVATE_STATE");
    await assert.rejects(prepareTeamResources(home, shared, workspace));
    assert.equal(
        existsSync(join(npm, "node_modules")),
        false,
        "native preparation must not reinstall implicitly",
    );
    install();
    await prepareTeamResources(home, shared, workspace);
    writeFileSync(
        join(shared, "team.json"),
        '{"configFiles":["npm/node_modules/backup-fixture/owner.json"]}',
    );
    assert.throws(() => backup(data, join(root, "blocked-config")), /Declared owner configuration/);
    rmSync(join(shared, "team.json"));
    rmSync(join(npm, "package-lock.json"));
    assert.throws(() => backup(data, join(root, "blocked-unlocked")), /unlocked installs/);
});
