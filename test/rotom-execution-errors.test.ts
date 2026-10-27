import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { executeRun, type RunContext } from "../src/server/rotom-executions/run.ts";
import type { PersistentKernel } from "../src/server/rotom-executions/contracts.ts";
import { createAsyncRotomJournal, RotomJournal } from "../src/server/rotom-journal.ts";
import { verifyRotomKernel } from "../src/server/rotom-kernel.ts";
import { teamResourceRevision } from "../src/server/rotom-resources.ts";
import type { RotomRpc, RpcRecord } from "../src/server/rotom-rpc.ts";

for (const phase of ["discover", "prompt", "goal"] as const) {
    test(`extension errors emitted during ${phase} keep the real journal receipt unknown`, async (t) => {
        const root = realpathSync(mkdtempSync(join(tmpdir(), "native-extension-error-")));
        const data = join(root, "data");
        const home = join(data, "kernel-homes", "member");
        const workspace = join(root, "workspace");

        for (const directory of [data, home, workspace]) {
            mkdirSync(directory, { recursive: true, mode: 0o700 });
        }

        const journal = createAsyncRotomJournal(new RotomJournal(data));

        t.after(async () => {
            await journal.close();
            rmSync(root, { recursive: true, force: true });
        });
        await journal.bind("session", {
            memberId: "member",
            kernelVersion: verifyRotomKernel().version,
            provider: "fixture",
            model: "fixture",
            accountGeneration: "synthetic",
            configurationDigest: "frozen",
            home,
            workspace,
        });

        const listeners = new Set<(event: RpcRecord) => void>();
        let closed = 0;
        let evicted = 0;
        let revision = 1;
        let snapshots = 0;
        const state = {
            sessionId: "native-session",
            sessionFile: join(root, "native.jsonl"),
            thinkingLevel: "off",
        };

        const fail = () => {
            for (const listener of listeners) {
                listener({ type: "extension_error", error: "Synthetic failure after dispatch" });
            }
        };

        // Only the native RPC boundary is synthetic. executeRun, its event listener and durable
        // receipt classification are production code; no real process, model or account is used.
        const rpc = {
            pid: process.pid,
            onEvent(listener: (event: RpcRecord) => void) {
                listeners.add(listener);

                return () => listeners.delete(listener);
            },
            async prompt() {
                await Promise.resolve();

                if (phase === "prompt") {
                    fail();
                }

                return "handled" as const;
            },
            async barrier() {
                await Promise.resolve();

                if (phase === "discover") {
                    fail();
                }
            },
            get activityRevision() {
                return revision;
            },
            async waitForActivity() {
                await Promise.resolve();
                revision++;
                fail();
            },
            async request(request: { type: string }) {
                switch (request.type) {
                    case "get_commands":
                        return { commands: [] };

                    case "get_entries": {
                        const status = snapshots++ === 0 ? "active" : "completed";

                        return phase === "goal"
                            ? {
                                  leafId: "goal",
                                  entries: [
                                      {
                                          id: "goal",
                                          customType: "goal-state",
                                          data: { goal: { status } },
                                      },
                                  ],
                              }
                            : { entries: [], leafId: null };
                    }

                    case "get_state":
                        return state;
                    default:
                        throw new Error(`Unexpected synthetic RPC: ${request.type}`);
                }
            },
            async close() {
                closed++;
            },
        };
        const persistent: PersistentKernel = {
            kernel: rpc as unknown as RotomRpc,
            gate: createServer(),
            gateFile: join(root, "gate"),
            gateState: {},
            revision: teamResourceRevision(join(data, "team-agent"), workspace),
            state,
        };
        const ctx: RunContext = {
            journal,
            data,
            authorize: async () => {},
            retire: async () => {},
            used: () => {},
            warming: () => undefined,
            kernel: () => persistent,
            setKernel: () => assert.fail("The retained synthetic process must be reused"),
            deleteKernel: () => {
                evicted++;
            },
            notStopped: () => {},
            launch: async () => {
                throw new Error("No process should launch in this check");
            },
        };
        const receipt = await executeRun(
            ctx,
            "session",
            "request",
            "Synthetic ordinary prompt",
            phase === "discover" ? "discover" : "prompt",
            { aborted: false },
        );

        assert.equal(receipt.status, "unknown");
        assert.equal((await journal.receipt(receipt.id)).status, "unknown");
        assert.equal(evicted, 1, "A process with an extension failure must not be retained");
        assert.equal(closed, 1, "The failed process is closed before returning its receipt");
    });
}
