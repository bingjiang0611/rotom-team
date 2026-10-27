import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { since, snapshot } from "./counters.ts";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { KernelEntry } from "../../src/server/rotom-journal.ts";
import { WORKLOAD } from "./workload.ts";
import type { ScenarioContext } from "./scenario-context.ts";

/** Measure native process warming and the validator boundary without changing the real native path. */
export async function runNativeWarmScenarios(context: ScenarioContext): Promise<void> {
    const { app, base, scenario, submit, tab, token } = context;
    // A member focuses the message box of a new session of theirs: its native process may start before they send.
    const ready = (await context.call("sessions", "POST", { title: "Warm", backend: "rotom" }))
        .value.id as number;
    const readyTab = tab(ready);

    await readyTab.fullView;
    await scenario("native.warm", async () => {
        const response = await fetch(`${base}/api/c/${ready}/warm`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${token}`,
                "x-pocket": "1",
                "content-type": "application/json",
            },
            body: "{}",
        });
        const text = await response.text();

        // A server that does not warm refuses the route for a native session (409, no Durable fallback); a refusal is no
        // work. A warm start shows as one rotom process (`subprocess.rotom`).
        assert.ok([200, 409].includes(response.status), `warm: ${response.status} ${text}`);
    });
    await scenario("turn.prewarmed", async () => {
        assert.equal((await submit(ready, 1)).value.status, "settled");
    });
    await readyTab.close();

    // A subagent's start runs the team's validator (`rotom-child.ts`, through `rotom-child.sh`) as its own Node process
    // before Pi: in that member's HOME and workspace, with the shared profile, as the native process's environment has them.
    const { binding: readyBinding } = await app.kernel!.executions.journal.session(String(ready));

    await scenario("native.validate", async () => {
        const child = spawn(
            process.execPath,
            [new URL("../../src/server/rotom-child.ts", import.meta.url).pathname],
            {
                cwd: readyBinding.workspace,
                env: {
                    ...process.env,
                    HOME: readyBinding.home,
                    ROTOM_TEAM_AGENT_DIR: join(app.dataDir, "team-agent"),
                },
                stdio: ["ignore", "pipe", "pipe"],
            },
        );
        let errors = "";

        child.stderr.on("data", (chunk) => (errors += chunk));
        const [code] = await once(child, "exit");

        assert.equal(code, 0, `the validator accepts the member's prepared HOME: ${errors}`);
    });
}

/** Seed and measure repeated native roomInfo projections over a real long journal. */
export async function runNativeLongScenario(context: ScenarioContext): Promise<void> {
    const { app, call, scenario } = context;
    // A real app-created native session with a long journal, seeded directly without inference. Its roomInfo projections
    // are measured separately from the seed and the one reference read below.
    const nativeLong = (await call("sessions", "POST", { title: "Native long", backend: "rotom" }))
        .value.id as unknown as ConversationId;
    const nativeLongJournal = app.kernel!.executions.journal;
    const nativeLongBinding = (await nativeLongJournal.session(String(nativeLong))).binding;
    const nativeLongEntries: KernelEntry[] = [];
    let nativeLongParent: string | null = null;

    for (let index = 0; index < WORKLOAD.nativeLongEntries; index++) {
        const id = `native-long-${index}`;
        const entry: KernelEntry =
            index === 0
                ? {
                      id,
                      parentId: null,
                      type: "custom",
                      customType: "goal-state",
                      data: { goal: { id: "native-long", status: "active" } },
                  }
                : index === 1
                  ? {
                        id,
                        parentId: nativeLongParent,
                        type: "thinking_level_change",
                        thinkingLevel: "high",
                    }
                  : index === WORKLOAD.nativeLongEntries - 1
                    ? {
                          id,
                          parentId: nativeLongParent,
                          type: "message",
                          message: {
                              role: "assistant",
                              provider: nativeLongBinding.provider,
                              model: nativeLongBinding.model,
                              stopReason: "stop",
                              content: [
                                  {
                                      type: "text",
                                      text: "x".repeat(WORKLOAD.nativeLongEntryChars),
                                  },
                              ],
                          },
                      }
                    : {
                          id,
                          parentId: nativeLongParent,
                          type: "custom",
                          customType: "native-long-entry",
                          data: { text: "x".repeat(WORKLOAD.nativeLongEntryChars) },
                      };

        nativeLongEntries.push(entry);
        nativeLongParent = id;
    }

    const nativeLongAttempt = await nativeLongJournal.reserve(
        String(nativeLong),
        "native-long-seed",
        "native-long-seed",
    );

    await nativeLongJournal.attach(
        nativeLongAttempt.id,
        join(nativeLongBinding.home, "native-long.jsonl"),
        "native-long",
    );
    await nativeLongJournal.finish(nativeLongAttempt.id, "settled", nativeLongEntries);

    // Establish the expected values outside the measured window; this is an actual native roomInfo read, not a fixture.
    const nativeLongReference = await app.kernel!.roomInfo(nativeLong);

    assert.deepEqual(nativeLongReference.goal, {
        goal: { id: "native-long", status: "active" },
    });
    assert.equal(nativeLongReference.agent.thinkingLevel, "high");

    await scenario("session.open.native-long", async () => {
        const before = snapshot();

        for (let projection = 0; projection < 3; projection++) {
            const info = await app.kernel!.roomInfo(nativeLong);

            assert.deepEqual(info.goal, nativeLongReference.goal);
            assert.equal(info.agent.thinkingLevel, nativeLongReference.agent.thinkingLevel);
        }

        // This observer lives with each database, including the worker; a parent-only monkeypatch would report false zero.
        return {
            "roomInfo.segmentEntries.calls": since(before)["journal.segmentEntries.calls"] ?? 0,
        };
    });
}
