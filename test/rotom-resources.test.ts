import assert from "node:assert/strict";
import {
    existsSync,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
    rmSync,
    symlinkSync,
    linkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    assertTeamChildArguments,
    teamSubagentEnvironment,
} from "../src/server/rotom-resource-policy.ts";
import { test } from "node:test";
import {
    prepareTeamResources,
    memberConfigurationSnapshot,
    memberConfigurationChanges,
    sharedConfigFiles,
    teamComputerUseEnvironment,
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

test("shared computer-use values override every plugin-specific project setting", () => {
    const { shared } = fixture();

    assert.deepEqual(teamComputerUseEnvironment(shared), {
        PI_COMPUTER_USE_BROWSER_USE: "true",
        PI_COMPUTER_USE_HEADLESS: "false",
        PI_COMPUTER_USE_CURSOR_OVERLAY: "true",
        PI_COMPUTER_USE_MANAGED_BROWSER: "chrome",
    });
    mkdirSync(join(shared, "extensions"));
    writeFileSync(
        join(shared, "extensions/pi-computer-use.json"),
        '{"browser_use":false,"headless":true,"cursor_overlay":false,"managed_browser":"helium"}',
    );
    assert.equal(teamComputerUseEnvironment(shared).PI_COMPUTER_USE_MANAGED_BROWSER, "helium");
});

test("project subagent settings, definitions and package readers fail closed without blocking ordinary packages or skills", async () => {
    const { home, shared, project } = fixture();

    const put = (name: string, value: string) => {
        const file = join(project, name);

        mkdirSync(join(file, ".."), { recursive: true });
        writeFileSync(file, value);
    };

    for (const name of [".pi/agents/role.md", ".agents/role.md", ".pi/chains/task.chain.json"]) {
        put(name, "---\nname: evil\nextensions: ./evil.ts\n---\nevil");
        await assert.rejects(
            prepareTeamResources(home, shared, project),
            /Project agent definitions/,
        );
        rmSync(join(project, name));
    }

    put(".agents/skills/good/SKILL.md", "---\nname: good\ndescription: project skill\n---\ngood");
    put(
        ".pi/settings.json",
        JSON.stringify({
            subagents: { agentOverrides: { worker: { extensions: ["./evil.ts"] } } },
        }),
    );
    await assert.rejects(prepareTeamResources(home, shared, project), /Project subagent settings/);
    put(".pi/settings.json", "{}");

    for (const name of ["package.json", ".pi/npm/node_modules/@scope/evil/package.json"]) {
        put(name, JSON.stringify({ "pi-subagents": { agents: ["roles"] } }));
        await assert.rejects(prepareTeamResources(home, shared, project), /Agent package sources/);
        put(name, '{"name":"ordinary-project-package"}');
    }

    put(".pi/local/package.json", JSON.stringify({ pi: { subagents: { chains: ["chains"] } } }));
    put(".pi/settings.json", JSON.stringify({ packages: ["file:./local"] }));
    await assert.rejects(prepareTeamResources(home, shared, project), /Agent package sources/);
    put(".pi/local/package.json", '{"name":"ordinary-package"}');
    await prepareTeamResources(home, shared, project);
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

test("child CLI checks actual extension/trust aliases and canonical paths", async () => {
    const { home, shared, project } = fixture();
    const good = join(shared, "good.ts"),
        bad = join(project, "bad.ts");

    writeFileSync(good, "export default () => {};");
    writeFileSync(bad, "throw new Error('must not load');");
    await prepareTeamResources(home, shared, project);

    for (const flag of ["-e", "--extension"]) {
        await assertTeamChildArguments([flag, good], home, shared, project);
        await assert.rejects(
            assertTeamChildArguments([flag, bad], home, shared, project),
            /Child extension is not shared/,
        );
    }

    for (const flag of ["-a", "--approve"]) {
        await assert.rejects(
            assertTeamChildArguments([flag], home, shared, project),
            /Child --approve/,
        );
    }

    symlinkSync(bad, join(shared, "escape.ts"));
    await assert.rejects(
        assertTeamChildArguments(["-e", join(shared, "escape.ts")], home, shared, project),
        /Child extension is not shared/,
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
            assertTeamChildArguments([], home, shared, project),
            /Member resource settings changed/,
        );
        writeFileSync(path, original);
    }

    writeFileSync(join(home, ".pi/agent/AGENTS.md"), "LATE_PRIVATE_INSTRUCTIONS");
    await assert.rejects(
        assertTeamChildArguments([], home, shared, project),
        /Member configuration changed/,
    );
    assert.equal(
        readFileSync(join(home, ".pi/agent/AGENTS.md"), "utf8"),
        "LATE_PRIVATE_INSTRUCTIONS",
    );
});
