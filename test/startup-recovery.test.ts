// Real app startup with synthetic journal entries; any automatic submit is intercepted before inference.
import { cleanUp, owner, root, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, mock, test } from "node:test";
import { PocketApp } from "../src/server/app.ts";
import { TeamKernel } from "../src/server/team-kernel.ts";

const open = () =>
    PocketApp.open({
        dataDir: join(realpathSync(root), "native-data"),
        defaultCwd: realpathSync(work),
        supervised: false,
        kernel: true,
        browser: null,
        log: () => {},
        configureUserModels: (models, user) =>
            models.registerNativeProvider({
                id: "openai",
                name: "Isolated startup fixture",
                auth: {
                    apiKey: {
                        name: "Synthetic",
                        resolve: async () => ({
                            auth: { apiKey: `synthetic:${user.id}` },
                            source: "test",
                        }),
                    },
                },
                getModels: () => [
                    {
                        id: "startup-fixture",
                        name: "startup-fixture",
                        provider: "openai",
                        api: "openai-completions",
                        baseUrl: "http://127.0.0.1:1/v1",
                        reasoning: false,
                        input: ["text"],
                        contextWindow: 32000,
                        maxTokens: 1024,
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    },
                ],
                stream: () => {
                    throw new Error("No model request permitted");
                },
                streamSimple: () => {
                    throw new Error("No model request permitted");
                },
            }),
    });

after(cleanUp);

test("startup leaves dead-PID unknowns and legacy pending continuations unchanged without dispatch", async () => {
    let submits = 0;
    const interception = mock.method(TeamKernel.prototype, "submit", async () => {
        submits++;

        throw new Error("Automatic submission must not happen in this test");
    });
    let app = await open();

    try {
        const member = owner(app);
        const entries: { session: string; attempt: string; status: string; plan: unknown }[] = [];

        for (const kind of ["unknown-no-plan", "unknown-planned", "legacy-interrupted"] as const) {
            const session = await app.commands.createSession(member, { backend: "rotom" });
            const journal = app.kernel!.executions.journal;
            const { binding } = journal.session(String(session.id));
            const directory = join(binding.home, "sessions");
            const file = join(directory, `${kind}.jsonl`);

            mkdirSync(directory, { recursive: true });
            writeFileSync(
                file,
                JSON.stringify({
                    type: "session",
                    version: 3,
                    id: kind,
                    timestamp: new Date().toISOString(),
                    cwd: binding.workspace,
                }) + "\n",
            );
            const attempt = journal.reserve(String(session.id), kind, "Do not repeat this task");

            journal.attach(attempt.id, file, kind, 999999999);
            journal.fail(attempt.id, "unknown");

            if (kind === "legacy-interrupted") {
                // Model the old release's unsafe classification, without rewriting it on startup.
                journal.interrupt(attempt.id, []);
            }

            if (kind !== "unknown-no-plan") {
                journal.planResume(attempt.id);
            }

            entries.push({
                session: String(session.id),
                attempt: attempt.id,
                status: journal.receipt(attempt.id).status,
                plan: journal.resume(attempt.id),
            });
        }

        for (let restart = 0; restart < 2; restart++) {
            await app.close();
            app = await open();
            // Await the startup continuation path explicitly as well as the fire-and-forget invocation.
            await app.kernel!.resumeInterrupted();
            const journal = app.kernel!.executions.journal;

            for (const entry of entries) {
                assert.equal(journal.receipt(entry.attempt).status, entry.status);
                assert.deepEqual(journal.resume(entry.attempt), entry.plan);
                assert.equal(journal.latest(entry.session)?.id, entry.attempt);

                if (entry.status === "unknown") {
                    assert.equal(journal.pendingConversation(entry.session)?.id, entry.attempt);
                    assert.throws(
                        () => journal.reserve(entry.session, "new-request", "try again"),
                        /unknown/,
                    );
                }
            }

            assert.equal(submits, 0, "no automatic continuation submitted");
        }
    } finally {
        await app.close();
        interception.mock.restore();
    }
});
