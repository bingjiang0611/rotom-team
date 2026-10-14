import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareTeamResources } from "../src/server/rotom-resources.ts";
import { nativeConfigurationApi } from "../src/server/rotom-kernel.ts";

test("shared settings preserve native retry, compaction and role defaults, retiring old derived overrides", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "team-native-defaults-"));
    const shared = join(root, "team-agent"),
        project = join(root, "project");

    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(shared);
    mkdirSync(project);
    const api = await nativeConfigurationApi();
    const native = api.SettingsManager.inMemory();

    for (const member of ["alice", "bob"]) {
        const home = join(root, member);
        const agentDir = join(home, ".pi/agent");
        const file = join(agentDir, "settings.json");

        mkdirSync(agentDir, { recursive: true, mode: 0o700 });
        await prepareTeamResources(home, shared, project);
        const settings = JSON.parse(readFileSync(file, "utf8"));
        const derived = api.SettingsManager.inMemory(settings);

        assert.deepEqual(derived.getRetrySettings(), native.getRetrySettings());
        assert.deepEqual(derived.getProviderRetrySettings(), native.getProviderRetrySettings());
        assert.deepEqual(derived.getCompactionSettings(), native.getCompactionSettings());
        assert.equal(settings.subagents, undefined, "native roles are not overridden");
        assert.equal(statSync(file).mode & 0o777, 0o600);

        const oldRoles = {
            agentOverrides: {
                delegate: { disabled: true },
                oracle: { disabled: true },
                researcher: { disabled: true },
            },
        };
        const viewFile = join(agentDir, "team-resource-view.json");
        const view = JSON.parse(readFileSync(viewFile, "utf8"));

        writeFileSync(
            file,
            JSON.stringify({
                ...settings,
                subagents: oldRoles,
                retry: { enabled: false },
                compaction: { enabled: false },
            }),
        );
        writeFileSync(viewFile, JSON.stringify({ ...view, subagents: oldRoles }));
        await prepareTeamResources(home, shared, project);
        assert.equal(JSON.parse(readFileSync(file, "utf8")).subagents, undefined);
        assert.equal(
            api.SettingsManager.create(project, agentDir, {
                projectTrusted: false,
            }).getRetryEnabled(),
            true,
        );
    }
});

test("owner retry, model compaction and role settings pass through without Team overrides", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "team-native-settings-"));
    const home = join(root, "home"),
        shared = join(root, "team-agent"),
        project = join(root, "project");

    t.after(() => rmSync(root, { recursive: true, force: true }));

    for (const dir of [join(home, ".pi/agent"), shared, project]) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    const base = {
        retry: { enabled: true, maxRetries: 2, baseDelayMs: 5, provider: { maxRetries: 2 } },
        compaction: {
            enabled: true,
            reserveTokens: 8192,
            keepRecentTokens: 10000,
            modelOverrides: { "fixture/model": { reserveTokens: 1024 } },
        },
        subagents: {
            agentOverrides: {
                delegate: { disabled: false },
                oracle: { thinking: "high" },
                researcher: { tools: "read,write" },
            },
        },
    };

    writeFileSync(join(shared, "settings.json"), JSON.stringify(base));
    await prepareTeamResources(home, shared, project);
    const settings = JSON.parse(readFileSync(join(home, ".pi/agent/settings.json"), "utf8"));

    for (const key of ["retry", "compaction", "subagents"] as const) {
        assert.deepEqual(settings[key], base[key]);
    }

    const api = await nativeConfigurationApi();
    const native = api.SettingsManager.inMemory(base);
    const derived = api.SettingsManager.inMemory(settings);

    assert.deepEqual(
        derived.getCompactionSettings({ provider: "fixture", id: "model" }),
        native.getCompactionSettings({ provider: "fixture", id: "model" }),
    );
});
