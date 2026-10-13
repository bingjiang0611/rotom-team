import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureTeamSubagents } from "../src/server/rotom-kernel.ts";

test("team subagent defaults apply to every member and preserve unrelated settings", () => {
    const root = mkdtempSync(join(tmpdir(), "team-subagents-"));

    try {
        for (const member of ["alice", "bob"]) {
            const home = join(root, member);
            const file = join(home, ".pi/agent/settings.json");

            configureTeamSubagents(home);
            assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
                subagents: {
                    agentOverrides: {
                        delegate: { disabled: true },
                        oracle: { disabled: true },
                        researcher: { disabled: true },
                    },
                },
            });
            assert.equal(statSync(file).mode & 0o777, 0o600);
            writeFileSync(
                file,
                JSON.stringify({
                    retry: { enabled: false },
                    skills: ["./personal-skill"],
                    subagents: {
                        defaultExtensions: [],
                        agentOverrides: {
                            delegate: { disabled: false, model: "fixture/model" },
                            worker: { model: "fixture/worker" },
                        },
                    },
                }),
            );
            configureTeamSubagents(home);
            const settings = JSON.parse(readFileSync(file, "utf8"));

            assert.deepEqual(settings.retry, { enabled: false });
            assert.deepEqual(settings.skills, ["./personal-skill"]);
            assert.deepEqual(settings.subagents, {
                defaultExtensions: [],
                agentOverrides: {
                    delegate: { disabled: true, model: "fixture/model" },
                    worker: { model: "fixture/worker" },
                    oracle: { disabled: true },
                    researcher: { disabled: true },
                },
            });
            const before = statSync(file);

            configureTeamSubagents(home);
            assert.equal(statSync(file).ino, before.ino, "unchanged settings are not rewritten");
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
