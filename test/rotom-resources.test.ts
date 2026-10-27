import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import {
    existsSync,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
    rmSync,
    symlinkSync,
    linkSync,
    statSync,
    chmodSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    assertTeamResourceSources,
    teamSubagentEnvironment,
} from "../src/server/rotom-resource-policy.ts";
import { test } from "node:test";
import {
    prepareTeamResources,
    memberConfigurationSnapshot,
    memberConfigurationChanges,
    sharedConfigFiles,
    teamResourceRevision,
} from "../src/server/rotom-resources.ts";

function fixture() {
    const root = mkdtempSync(join(tmpdir(), "rotom-shared-resources-"));
    const home = join(root, "home"),
        shared = join(root, "team-agent"),
        project = join(root, "project");

    for (const dir of [join(home, ".pi/agent"), shared, join(project, ".pi/extensions")]) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    return { root, home, shared, project };
}

test("resource revision reuses unchanged large file hashes but observes edits, replacement and deletion", (t) => {
    const f = fixture();
    const file = join(f.shared, "npm/package-lock.json");

    mkdirSync(join(f.shared, "npm"));
    writeFileSync(file, "a".repeat(2 * 1024 * 1024));
    const original = fs.readFileSync;
    let reads = 0;
    const mocked = t.mock.method(fs, "readFileSync", (...args: Parameters<typeof readFileSync>) => {
        if (String(args[0]) === file) {
            reads++;
        }

        return Reflect.apply(original, fs, args);
    });

    syncBuiltinESMExports();

    try {
        const before = teamResourceRevision(f.shared, f.project);

        assert.equal(reads, 1);
        assert.equal(teamResourceRevision(f.shared, f.project), before);
        assert.equal(reads, 1, "unchanged large files are not read again");
        writeFileSync(file, "b".repeat(2 * 1024 * 1024));
        const changed = teamResourceRevision(f.shared, f.project);

        assert.notEqual(changed, before);
        assert.equal(reads, 2);
        writeFileSync(`${file}.new`, "c".repeat(2 * 1024 * 1024));
        fs.renameSync(`${file}.new`, file);
        assert.notEqual(teamResourceRevision(f.shared, f.project), changed);
        assert.equal(reads, 3);
        rmSync(file);
        const removed = teamResourceRevision(f.shared, f.project);

        assert.notEqual(removed, changed);
        assert.equal(reads, 3);
        writeFileSync(file, "");
        assert.notEqual(teamResourceRevision(f.shared, f.project), removed);
    } finally {
        mocked.mock.restore();
        syncBuiltinESMExports();
        rmSync(f.root, { recursive: true, force: true });
    }
});

test("shared resources replace member settings without reading project packages or changing private state", async () => {
    const { home, shared, project } = fixture();

    writeFileSync(join(home, ".pi/agent/auth.json"), "PRIVATE_SENTINEL");
    writeFileSync(join(home, ".pi/agent/unknown-plugin-state.json"), "UNKNOWN_STATE");
    writeFileSync(
        join(home, ".pi/agent/settings.json"),
        JSON.stringify({ steeringMode: "all", packages: ["npm:must-not-install"] }),
    );
    writeFileSync(
        join(project, ".pi/settings.json"),
        JSON.stringify({
            packages: ["npm:project-must-not-install"],
            extensions: ["./extensions/evil.ts"],
        }),
    );
    writeFileSync(join(shared, "settings.json"), JSON.stringify({ steeringMode: "one-at-a-time" }));
    writeFileSync(join(shared, "AGENTS.md"), "SHARED_CONTEXT");
    await prepareTeamResources(home, shared, project);
    const settings = JSON.parse(readFileSync(join(home, ".pi/agent/settings.json"), "utf8"));

    assert.equal(settings.steeringMode, "one-at-a-time");
    assert.deepEqual(settings.packages, []);
    assert.equal(readFileSync(join(home, ".pi/agent/auth.json"), "utf8"), "PRIVATE_SENTINEL");
    assert.equal(
        readFileSync(join(home, ".pi/agent/unknown-plugin-state.json"), "utf8"),
        "UNKNOWN_STATE",
    );
    assert.equal(
        settings.extensions.some((file: string) => file.includes("evil")),
        false,
    );
    // A runtime cannot persist a private override of supported native resource settings.
    writeFileSync(join(home, ".pi/agent/settings.json"), JSON.stringify({ steeringMode: "all" }));
    await prepareTeamResources(home, shared, project);
    assert.equal(
        JSON.parse(readFileSync(join(home, ".pi/agent/settings.json"), "utf8")).steeringMode,
        "one-at-a-time",
    );
});

test("rotom auxiliary inference defaults to the admitted payer model", async () => {
    const { home, shared, project } = fixture();

    await prepareTeamResources(home, shared, project, {
        provider: "personal-provider",
        model: "personal-model",
    });
    const generated = JSON.parse(readFileSync(join(home, ".pi/agent/sol-pi.json"), "utf8"));

    assert.equal(generated.evidencePreservingReducer, true);
    assert.equal(generated.evidencePreservingReducerProvider, "personal-provider");
    assert.equal(generated.evidencePreservingReducerModel, "personal-model");
    assert.equal(generated.onlineContextCompact, false);
    assert.ok(
        JSON.parse(
            readFileSync(join(home, ".pi/agent/team-resource-view.json"), "utf8"),
        ).files.includes("sol-pi.json"),
    );

    writeFileSync(
        join(shared, "sol-pi.json"),
        JSON.stringify({
            version: 1,
            evidencePreservingReducer: false,
            evidencePreservingReducerProvider: "owner-provider",
            evidencePreservingReducerModel: "owner-model",
        }),
    );
    await prepareTeamResources(home, shared, project, {
        provider: "personal-provider",
        model: "personal-model",
    });
    assert.equal(
        JSON.parse(readFileSync(join(home, ".pi/agent/sol-pi.json"), "utf8"))
            .evidencePreservingReducerProvider,
        "owner-provider",
    );
});

test("declared plugin configuration is shared; credentials cannot be declared as configuration", async () => {
    const { home, shared, project } = fixture();

    writeFileSync(join(shared, "team.json"), JSON.stringify({ configFiles: ["plugin.json"] }));
    writeFileSync(join(shared, "plugin.json"), '{"enabled":true}');
    await prepareTeamResources(home, shared, project);
    assert.equal(readFileSync(join(home, ".pi/agent/plugin.json"), "utf8"), '{"enabled":true}');
    const revision = teamResourceRevision(shared);

    writeFileSync(join(shared, "plugin.json"), '{"enabled":false}');
    assert.notEqual(teamResourceRevision(shared), revision);

    for (const file of [
        "auth.json",
        "../outside",
        "/absolute",
        "sessions/one.jsonl",
        "models.json",
    ]) {
        writeFileSync(join(shared, "team.json"), JSON.stringify({ configFiles: [file] }));
        assert.throws(() => sharedConfigFiles(shared), /never credentials/);
    }
});

test("commands cannot silently persist declared member configuration, while unknown runtime state is preserved", async () => {
    const { home, shared, project } = fixture();

    writeFileSync(join(shared, "team.json"), JSON.stringify({ configFiles: ["plugin.json"] }));
    writeFileSync(join(shared, "plugin.json"), '{"enabled":true}');
    await prepareTeamResources(home, shared, project);
    const before = memberConfigurationSnapshot(home, shared);

    writeFileSync(join(home, ".pi/agent/unknown-state.json"), "private runtime state");
    assert.deepEqual(memberConfigurationChanges(home, shared, before), []);
    writeFileSync(join(home, ".pi/agent/plugin.json"), '{"enabled":false}');
    assert.deepEqual(memberConfigurationChanges(home, shared, before), ["plugin.json"]);
    assert.equal(readFileSync(join(shared, "plugin.json"), "utf8"), '{"enabled":true}');
    await prepareTeamResources(home, shared, project);
    assert.equal(readFileSync(join(home, ".pi/agent/plugin.json"), "utf8"), '{"enabled":true}');
    assert.equal(
        readFileSync(join(home, ".pi/agent/unknown-state.json"), "utf8"),
        "private runtime state",
    );
});

test("shared computer-use configuration is copied without environment overrides", async () => {
    const { home, shared, project } = fixture();

    mkdirSync(join(shared, "extensions"));
    const config =
        '{"browser_use":false,"headless":true,"cursor_overlay":false,"managed_browser":"helium"}';

    writeFileSync(join(shared, "extensions/pi-computer-use.json"), config);
    await prepareTeamResources(home, shared, project);
    assert.equal(
        readFileSync(join(home, ".pi/agent/extensions/pi-computer-use.json"), "utf8"),
        config,
    );
});

test("project roles, overrides and package declarations are left to native trusted discovery", async () => {
    const { home, shared, project } = fixture();

    for (const name of [".pi/agents/role.md", ".agents/role.md", ".pi/chains/task.chain.json"]) {
        const file = join(project, name);

        mkdirSync(join(file, ".."), { recursive: true });
        writeFileSync(file, "---\nname: project-role\n---\nProject role");
    }

    writeFileSync(
        join(project, ".pi/settings.json"),
        JSON.stringify({
            subagents: { agentOverrides: { worker: { extensions: ["./project.ts"] } } },
            packages: ["./project-package"],
        }),
    );
    writeFileSync(
        join(project, "package.json"),
        JSON.stringify({ "pi-subagents": { agents: ["roles"] } }),
    );
    await prepareTeamResources(home, shared, project);
    await assertTeamResourceSources(home, shared, project);
    assert.equal(
        JSON.parse(readFileSync(join(home, ".pi/agent/settings.json"), "utf8")).subagents,
        undefined,
        "project settings remain in their native scope, not the derived shared profile",
    );
});

test("private member role/config readers reject customization and preserve runtime state", async () => {
    const { home, shared, project } = fixture();

    writeFileSync(
        join(home, ".pi/agent/settings.json"),
        JSON.stringify({ subagents: { defaultExtensions: ["./evil.ts"] } }),
    );
    await assert.rejects(prepareTeamResources(home, shared, project), /Member subagent settings/);
    writeFileSync(join(home, ".pi/agent/settings.json"), "{}");

    for (const name of [
        ".pi/agent/agents/role.md",
        ".agents/role.md",
        ".pi/agent/npm/node_modules/evil/package.json",
    ]) {
        const file = join(home, name);

        mkdirSync(join(file, ".."), { recursive: true });
        writeFileSync(
            file,
            name.endsWith(".json")
                ? '{"pi":{"subagents":{"agents":["agents"]}}}'
                : "---\nname: evil\n---\nevil",
        );
        await assert.rejects(
            prepareTeamResources(home, shared, project),
            /Member agent definitions|Agent package sources/,
        );
        assert.ok(readFileSync(file, "utf8"));
        rmSync(file);
    }

    mkdirSync(join(shared, "agents"));
    writeFileSync(join(shared, "agents/shared.md"), "---\nname: shared-role\n---\nshared");
    writeFileSync(join(shared, "team.json"), JSON.stringify({ configFiles: ["agents/shared.md"] }));
    await prepareTeamResources(home, shared, project);
    await prepareTeamResources(home, shared, project);
    assert.ok(
        readFileSync(join(home, ".pi/agent/agents/shared.md"), "utf8").includes("shared-role"),
    );
    assert.equal(teamSubagentEnvironment(shared).npm_config_prefix, join(shared, "global-npm"));
});

test("unchanged managed resources keep their inode, timestamp, and private mode", async () => {
    const { home, shared, project } = fixture();
    const file = join(home, ".pi/agent/settings.json");
    const view = join(home, ".pi/agent/team-resource-view.json");

    writeFileSync(join(shared, "AGENTS.md"), "stable");
    await prepareTeamResources(home, shared, project);
    const before = { file: statSync(file), view: statSync(view) };

    await prepareTeamResources(home, shared, project);
    const after = { file: statSync(file), view: statSync(view) };

    assert.equal(after.file.ino, before.file.ino);
    assert.equal(after.file.mtimeMs, before.file.mtimeMs);
    assert.equal(after.view.ino, before.view.ino);
    assert.equal(after.view.mtimeMs, before.view.mtimeMs);
    assert.equal(after.file.mode & 0o777, 0o600);
    assert.equal(after.view.mode & 0o777, 0o600);

    chmodSync(file, 0o644);
    await prepareTeamResources(home, shared, project);
    assert.equal(
        statSync(file).mode & 0o777,
        0o600,
        "matching bytes still repair public-mode legacy files",
    );
    assert.notEqual(
        statSync(file).ino,
        after.file.ino,
        "mode repair uses the existing atomic replacement",
    );
});

test("shared add/change/remove updates two members without deleting unknown state", async () => {
    const { root, home, shared, project } = fixture();
    const other = join(root, "other");

    mkdirSync(join(other, ".pi/agent"), { recursive: true });
    writeFileSync(join(shared, "AGENTS.md"), "base one");
    writeFileSync(join(shared, "plugin.json"), '{"version":1}');
    writeFileSync(join(shared, "team.json"), '{"configFiles":["plugin.json"]}');

    for (const member of [home, other]) {
        writeFileSync(join(member, ".pi/agent/auth.json"), "PRIVATE");
        writeFileSync(join(member, ".pi/agent/unknown.json"), "UNKNOWN");
        await prepareTeamResources(member, shared, project);
    }

    writeFileSync(join(shared, "AGENTS.md"), "base two");

    for (const member of [home, other]) {
        await prepareTeamResources(member, shared, project);
        assert.equal(readFileSync(join(member, ".pi/agent/AGENTS.md"), "utf8"), "base two");
    }

    rmSync(join(shared, "AGENTS.md"));
    writeFileSync(join(shared, "team.json"), '{"configFiles":[]}');

    for (const member of [home, other]) {
        await prepareTeamResources(member, shared, project);
        assert.equal(existsSync(join(member, ".pi/agent/AGENTS.md")), false);
        assert.equal(existsSync(join(member, ".pi/agent/plugin.json")), false);
        assert.equal(readFileSync(join(member, ".pi/agent/auth.json"), "utf8"), "PRIVATE");
        assert.equal(readFileSync(join(member, ".pi/agent/unknown.json"), "utf8"), "UNKNOWN");
    }
});

test("configuration copying refuses credential aliases and unmanaged collisions", async () => {
    const { home, shared, project } = fixture();
    const credential = join(home, ".pi/agent/auth.json");

    writeFileSync(credential, "SECRET");

    for (const name of [
        "AUTH.JSON",
        "Mcp-Auth.Json",
        "plugin/Models.JSON",
        "Sessions/file.json",
        "TEAM-RESOURCE-VIEW.JSON",
    ]) {
        writeFileSync(join(shared, "team.json"), JSON.stringify({ configFiles: [name] }));
        assert.throws(() => sharedConfigFiles(shared), /never credentials/);
    }

    writeFileSync(join(shared, "team.json"), '{"configFiles":["plugin.json"]}');
    symlinkSync(credential, join(shared, "plugin.json"));
    await assert.rejects(prepareTeamResources(home, shared, project), /Configuration links/);
    rmSync(join(shared, "plugin.json"));
    writeFileSync(join(shared, "plugin.json"), "shared");
    symlinkSync(credential, join(home, ".pi/agent/plugin.json"));
    await assert.rejects(prepareTeamResources(home, shared, project), /Configuration links/);
    rmSync(join(home, ".pi/agent/plugin.json"));
    writeFileSync(join(home, ".pi/agent/plugin.json"), "UNCLASSIFIED");
    await assert.rejects(prepareTeamResources(home, shared, project), /unmanaged member file/);
    rmSync(join(home, ".pi/agent/plugin.json"));
    rmSync(join(shared, "plugin.json"));
    linkSync(credential, join(shared, "plugin.json"));
    await assert.rejects(prepareTeamResources(home, shared, project), /Configuration links/);
    rmSync(join(shared, "plugin.json"));
    writeFileSync(join(shared, "plugin.json"), "shared");
    linkSync(credential, join(home, ".pi/agent/plugin.json"));
    await assert.rejects(prepareTeamResources(home, shared, project), /Configuration links/);
    rmSync(join(home, ".pi/agent/plugin.json"));
    writeFileSync(join(home, ".pi/agent/plugin.json"), "UNCLASSIFIED");
    assert.equal(readFileSync(credential, "utf8"), "SECRET");
    assert.equal(readFileSync(join(home, ".pi/agent/plugin.json"), "utf8"), "UNCLASSIFIED");
});

test("revision does not traverse linked packages or dependency graphs", async () => {
    const { root, home, shared, project } = fixture();
    const pkg = join(root, "linked-package");

    mkdirSync(pkg);
    writeFileSync(join(pkg, "package.json"), '{"name":"linked","pi":{"extensions":["index.ts"]}}');
    writeFileSync(join(pkg, "index.ts"), "export default () => {};");
    symlinkSync(pkg, join(shared, "linked-package"));
    writeFileSync(join(shared, "settings.json"), '{"packages":["./linked-package"]}');
    await prepareTeamResources(home, shared, project);
    mkdirSync(join(shared, "npm/node_modules"), { recursive: true });
    symlinkSync(shared, join(shared, "npm/node_modules/cycle"));
    const before = teamResourceRevision(shared);

    writeFileSync(
        join(pkg, "index.ts"),
        "export default () => { /* changed outside fingerprint: explicit refresh required */ };",
    );
    assert.equal(teamResourceRevision(shared), before);
    writeFileSync(
        join(shared, "settings.json"),
        '{"packages":["./linked-package"],"steeringMode":"all"}',
    );
    assert.notEqual(teamResourceRevision(shared), before);
});

test("binary configuration is exact and changed retiring files are never discarded", async () => {
    const { home, shared, project } = fixture();
    const content = Buffer.from([0, 255, 254, 216, 237]);

    writeFileSync(join(shared, "plugin.cfg"), content);
    writeFileSync(join(shared, "team.json"), '{"configFiles":["plugin.cfg"]}');
    await prepareTeamResources(home, shared, project);
    const target = join(home, ".pi/agent/plugin.cfg");

    assert.deepEqual(readFileSync(target), content);
    const before = memberConfigurationSnapshot(home, shared);

    writeFileSync(target, Buffer.from([0, 254, 255, 216, 237]));
    assert.deepEqual(memberConfigurationChanges(home, shared, before), ["plugin.cfg"]);
    writeFileSync(target, "UNCLASSIFIED_CHANGE");
    writeFileSync(join(shared, "team.json"), '{"configFiles":[]}');
    await assert.rejects(
        prepareTeamResources(home, shared, project),
        /changed member configuration/,
    );
    assert.equal(readFileSync(target, "utf8"), "UNCLASSIFIED_CHANGE");
});

test("live child validation rejects later member package/extension/config overrides", async () => {
    const { home, shared, project } = fixture();

    await prepareTeamResources(home, shared, project);
    const path = join(home, ".pi/agent/settings.json");
    const original = readFileSync(path, "utf8");

    for (const key of ["packages", "extensions"]) {
        writeFileSync(
            path,
            JSON.stringify({ ...JSON.parse(original), [key]: [join(project, "private-package")] }),
        );
        await assert.rejects(
            assertTeamResourceSources(home, shared, project),
            /Member resource settings changed/,
        );
        writeFileSync(path, original);
    }

    writeFileSync(join(home, ".pi/agent/AGENTS.md"), "LATE_PRIVATE_INSTRUCTIONS");
    await assert.rejects(
        assertTeamResourceSources(home, shared, project),
        /Member configuration changed/,
    );
    assert.equal(
        readFileSync(join(home, ".pi/agent/AGENTS.md"), "utf8"),
        "LATE_PRIVATE_INSTRUCTIONS",
    );
});

test("the subagent validator, as its own process, accepts a prepared HOME, rejects a member extension, and names the shared context", async () => {
    const { home, shared, project } = fixture();
    const validator = new URL("../src/server/rotom-child.ts", import.meta.url).pathname;
    const run = (environment: Record<string, string> = {}) =>
        new Promise<{ code: number | null; out: string; err: string }>((done) => {
            const child = spawn(process.execPath, [validator], {
                cwd: project,
                env: { ...process.env, HOME: home, ROTOM_TEAM_AGENT_DIR: shared, ...environment },
                stdio: ["ignore", "pipe", "pipe"],
            });
            let out = "",
                err = "";

            child.stdout.on("data", (chunk) => (out += chunk));
            child.stderr.on("data", (chunk) => (err += chunk));
            child.on("exit", (code) => done({ code, out, err }));
        });

    writeFileSync(join(shared, "AGENTS.md"), "SHARED_CONTEXT");
    await prepareTeamResources(home, shared, project);
    const accepted = await run();

    assert.equal(accepted.code, 0, accepted.err);
    assert.equal(accepted.out, "");
    assert.deepEqual(await run({ ROTOM_TEAM_FROZEN_CONTEXT: "frozen" }), {
        code: 0,
        out: join(shared, "AGENTS.md"),
        err: "",
    });

    // A member extension installed after preparation is refused before Pi would load it.
    mkdirSync(join(home, ".pi/agent/extensions"), { recursive: true });
    writeFileSync(join(home, ".pi/agent/extensions/private.ts"), "export default () => {};");
    const refused = await run();

    assert.notEqual(refused.code, 0);
    assert.match(refused.err, /Member extensions are not allowed/);
});

test("the subagent validator loads no native process client, model library or RPC", () => {
    const log = join(mkdtempSync(join(tmpdir(), "rotom-validator-imports-")), "imports.log");
    const hooks = join(log, "..", "hooks.mjs");

    writeFileSync(
        hooks,
        `import { registerHooks } from "node:module";
import { appendFileSync } from "node:fs";
registerHooks({ resolve(specifier, context, next) { const resolved = next(specifier, context); appendFileSync(${JSON.stringify(log)}, resolved.url + "\\n"); return resolved; } });`,
    );
    // Without a HOME to check it fails, after its imports.
    spawnSync(
        process.execPath,
        ["--import", hooks, new URL("../src/server/rotom-child.ts", import.meta.url).pathname],
        { env: { ...process.env, HOME: join(log, "..", "missing") }, stdio: "ignore" },
    );
    const loaded = readFileSync(log, "utf8").split("\n");

    assert.ok(loaded.some((url) => url.endsWith("/src/server/rotom-resource-policy.ts")));

    for (const heavy of ["rotom-kernel.ts", "rotom-rpc.ts", "rotom-resources.ts"]) {
        assert.ok(!loaded.some((url) => url.endsWith(`/src/server/${heavy}`)), heavy);
    }

    const teamModels = new URL("../node_modules/@earendil-works/pi-ai/", import.meta.url).href;

    assert.ok(!loaded.some((url) => url.startsWith(teamModels)), "the team's own model library");
});
