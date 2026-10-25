import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
    existsSync,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RotomExecutions } from "../src/server/rotom-executions.ts";
import { verifyRotomKernel, nativeSessionManager } from "../src/server/rotom-kernel.ts";
import {
    KernelRequestConflict,
    type KernelBinding,
    type KernelEntry,
} from "../src/server/rotom-journal.ts";
import { seedPhaseChannel, type SeedPhaseSignal } from "../src/server/perf-channels.ts";
import { prepareSeed, persistSeed } from "../src/server/rotom-executions/seed-files.ts";
import { publicNativeHistory } from "../src/server/rotom-history.ts";

async function fixture(
    t: TestContext,
    authorize: (call: number) => Promise<void> = async () => {},
    chars = 128,
    empty = false,
) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "seed-materialization-")));
    const workspace = join(root, "workspace");
    const data = join(root, "data");

    mkdirSync(workspace);
    mkdirSync(data, { mode: 0o700 });
    let calls = 0;
    const executions = new RotomExecutions(data, async () => authorize(++calls));
    const journal = executions.journal;

    t.after(async () => {
        await executions.close();
        rmSync(root, { recursive: true, force: true });
    });

    const member = (name: string): KernelBinding => {
        const home = join(data, "kernel-homes", name);

        mkdirSync(home, { recursive: true, mode: 0o700 });

        return {
            memberId: name,
            home,
            workspace,
            provider: name === "alice" ? "ALICE_PRIVATE_PROVIDER" : "fixture",
            model: "fixture",
            accountGeneration: name,
            configurationDigest: "fixture",
            kernelVersion: verifyRotomKernel().version,
        };
    };

    const alice = member("alice"),
        bob = member("bob");

    await journal.bind("shared", alice);
    const messages = [
        { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
        {
            role: "assistant",
            provider: "ALICE_PRIVATE_PROVIDER",
            model: "fixture",
            api: "openai-completions",
            content: [
                { type: "text", text: "x".repeat(chars) },
                {
                    type: "thinking",
                    thinking: "ALICE_PRIVATE_REASONING",
                    signature: "ALICE_PRIVATE_SIGNATURE",
                },
            ],
            stopReason: "stop",
            timestamp: 2,
            usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 2,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
        },
    ];
    const entries: KernelEntry[] = empty
        ? []
        : messages.map((message, index) => ({
              type: "message",
              id: `entry-${index}`,
              parentId: index ? "entry-0" : null,
              timestamp: new Date(index).toISOString(),
              message,
          }));

    if (!empty) {
        const source = await journal.reserve("shared", "source", "source", "command");

        await journal.attach(source.id, join(root, "source.jsonl"), "source");
        await journal.finish(source.id, "handled", entries);
    }

    return {
        root,
        data,
        executions,
        journal,
        alice,
        bob,
        messages,
        entries,
        calls: () => calls,
        handoff: (request = "handoff") => executions.handoff("shared", request, "shared", bob),
    };
}

function observe(t: TestContext, listener: (signal: SeedPhaseSignal) => void) {
    const callback = (value: unknown) => listener(value as SeedPhaseSignal);

    seedPhaseChannel.subscribe(callback);
    t.after(() => seedPhaseChannel.unsubscribe(callback));
}

for (const thread of ["main", "worker"] as const) {
    const chars = thread === "main" ? 128 : 8 * 1024 * 1024;

    test(`${thread}: handoff persists on the selected thread with attach before append`, async (t) => {
        const f = await fixture(t, undefined, chars);
        const phases: SeedPhaseSignal[] = [];
        let ticks = 0;
        const timer = setInterval(() => ticks++, 1);

        t.after(() => clearInterval(timer));
        observe(t, (signal) => {
            phases.push(signal);

            if (signal.phase === "authorize") {
                ticks = 0;
            }
        });
        const originalAttach = f.journal.attach.bind(f.journal);
        let attached = 0;

        f.journal.attach = async (id, path, sessionId, pid) => {
            assert.ok(
                !existsSync(path) || !readFileSync(path, "utf8").includes('"type":"message"'),
                "attach precedes the first append",
            );
            await originalAttach(id, path, sessionId, pid);
            attached++;
        };

        const before = await f.journal.usage("shared");
        const result = await f.handoff();

        assert.equal(result.status, "settled");

        if (thread === "worker") {
            assert.ok(ticks > 0, "large seeds must yield, not wrap synchronous work in a Promise");
        }

        const stages = phases.filter((p) =>
            ["prepare", "append", "persist", "readback", "compare"].includes(p.phase),
        );

        assert.deepEqual(
            stages.map((p) => p.phase),
            ["prepare", "append", "persist", "readback", "compare"],
        );
        assert.ok(
            stages.every((p) => p.thread === thread),
            "file and comparison CPU must run on the selected thread",
        );
        assert.equal(attached, 1);
        assert.equal(f.calls(), 3, "authorization is repeated after durable readback");
        const target = await f.journal.session("shared");
        const file = target.sessionFile!;

        assert.notEqual(target.segmentId, "shared");
        assert.ok(file.startsWith(f.bob.home));
        assert.equal(statSync(file).mode & 0o777, 0o600);
        assert.equal(
            statSync(join(f.bob.home, ".pi/agent/sessions/team-seeds")).mode & 0o777,
            0o700,
        );
        assert.ok(!readFileSync(file, "utf8").includes("ALICE_PRIVATE"));
        assert.deepEqual(await f.journal.usage("shared"), before);
        assert.equal((await f.journal.entries("shared")).length, 2, "seed is not mirrored again");
        assert.equal((await f.handoff()).id, result.id);
        assert.equal(attached, 1, "same request must not materialize again");
    });

    for (const outcome of ["release", "reject", "stop"] as const) {
        test(`${thread}: delayed attach ACK ${outcome} cannot be mistaken for permission to append`, async (t) => {
            const f = await fixture(t, undefined, chars);
            const entered = Promise.withResolvers<void>();
            const acknowledged = Promise.withResolvers<void>();
            const original = f.journal.attach.bind(f.journal);
            let file = "";

            f.journal.attach = async (...args) => {
                await original(...args);
                file = args[1];
                entered.resolve();
                await acknowledged.promise;

                if (outcome === "reject") {
                    throw new Error("Attach committed but ACK was lost");
                }
            };

            const pending = f.handoff();

            try {
                await entered.promise;
                assert.ok(
                    !existsSync(file) || !readFileSync(file, "utf8").includes('"type":"message"'),
                );
                assert.equal((await f.journal.session("shared")).segmentId, "shared");
                assert.throws(() => f.executions.close(), /still active/);

                if (outcome === "stop") {
                    await f.executions.abort("shared");
                }
            } finally {
                acknowledged.resolve();
            }

            const receipt = await pending;

            assert.equal(receipt.status, outcome === "release" ? "settled" : "unknown");

            if (outcome !== "release") {
                assert.ok(
                    !existsSync(file) || !readFileSync(file, "utf8").includes('"type":"message"'),
                );
                assert.equal((await f.journal.session("shared")).segmentId, "shared");
                assert.equal((await f.handoff()).id, receipt.id);
            }
        });
    }

    test(`${thread}: final authorization retains the writer lease and old head; duplicate intent does not replay`, async (t) => {
        const reached = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const f = await fixture(
            t,
            async (call) => {
                if (call === 3) {
                    reached.resolve();
                    await release.promise;
                }
            },
            chars,
        );
        const pending = f.handoff();

        await reached.promise;

        try {
            assert.throws(() => f.executions.close(), /still active/);
            assert.equal((await f.journal.session("shared")).segmentId, "shared");
            const duplicate = await f.handoff();

            assert.equal(duplicate.id, (await f.journal.request("shared", "handoff"))!.id);
            await assert.rejects(f.handoff("different"), KernelRequestConflict);
        } finally {
            release.resolve();
        }

        assert.equal((await pending).status, "settled");
    });

    for (const point of ["before-attach", "after-attach", "after-readback"] as const) {
        test(`${thread}: Stop ${point} keeps unknown and prevents commit`, async (t) => {
            const f = await fixture(t, undefined, chars);
            const stages: SeedPhaseSignal[] = [];
            let stopping: Promise<void> | undefined;
            const originalAttach = f.journal.attach.bind(f.journal);

            f.journal.attach = async (id, path, sessionId, pid) => {
                await originalAttach(id, path, sessionId, pid);

                if (point === "after-attach") {
                    stopping = f.executions.abort("shared");
                }
            };

            observe(t, (signal) => {
                stages.push(signal);

                if (
                    signal.thread === thread &&
                    signal.phase === (point === "before-attach" ? "prepare" : "compare") &&
                    point !== "after-attach"
                ) {
                    stopping = f.executions.abort("shared");
                }
            });
            const result = await f.handoff();

            await stopping;
            assert.ok(stopping);
            assert.equal(
                stages.some((s) => s.phase === "append"),
                point === "after-readback",
            );
            assert.equal(
                (await f.journal.segment(result.segmentId)).sessionFile !== undefined,
                point !== "before-attach",
            );
            assert.equal(result.status, "unknown");
            assert.equal((await f.journal.session("shared")).segmentId, "shared");
            assert.equal((await f.handoff()).id, result.id);
            await assert.rejects(f.handoff("different"), KernelRequestConflict);
            await f.executions.close();
        });
    }

    for (const fault of ["attach", "file-write", "private-directory"] as const) {
        test(`${thread}: ${fault} failure never commits or replays the seed`, async (t) => {
            const f = await fixture(t, undefined, chars);
            const originalAttach = f.journal.attach.bind(f.journal);

            if (fault === "private-directory") {
                const folder = join(f.bob.home, ".pi/agent/sessions/team-seeds");

                mkdirSync(folder, { recursive: true });
                chmodSync(folder, 0o755);
            }

            f.journal.attach = async (id, path, sessionId, pid) => {
                await originalAttach(id, path, sessionId, pid);

                if (fault === "attach") {
                    throw new Error("lost attach acknowledgement");
                }

                if (fault === "file-write") {
                    rmSync(path, { force: true });
                    mkdirSync(path);
                }
            };

            const result = await f.handoff();

            assert.equal(result.status, "unknown");
            assert.equal((await f.journal.session("shared")).segmentId, "shared");
            assert.equal((await f.handoff()).id, result.id);
            await assert.rejects(f.handoff("different"), KernelRequestConflict);
            await f.executions.close();
        });
    }

    for (const call of [2, 3]) {
        test(`${thread}: authorization rejection at seed stage ${call} preserves outcome classification`, async (t) => {
            const f = await fixture(
                t,
                async (current) => {
                    if (current === call) {
                        throw new Error("revoked");
                    }
                },
                chars,
            );
            const result = await f.handoff();

            assert.equal(result.status, call === 2 ? "rejected" : "unknown");
            assert.equal((await f.journal.session("shared")).segmentId, "shared");
            assert.equal(
                (await f.journal.segment(result.segmentId)).sessionFile !== undefined,
                call === 3,
            );
        });
    }
}

test("empty handoff keeps the zero-file path and still authorizes before finish", async (t) => {
    const f = await fixture(t, undefined, 0, true);
    const phases: SeedPhaseSignal[] = [];

    observe(t, (s) => phases.push(s));
    assert.equal((await f.handoff()).status, "settled");
    assert.equal(f.calls(), 3);
    assert.equal((await f.journal.session("shared")).sessionFile, undefined);
    assert.ok(phases.every((s) => s.thread === "main"));
    assert.ok(!existsSync(join(f.bob.home, ".pi/agent/sessions/team-seeds")));
});

test("the shared persistence helper refuses a mismatched readback without weakening comparison", async (t) => {
    const f = await fixture(t);
    const native = await nativeSessionManager();
    const { session, folder } = prepareSeed(f.bob, native.SessionManager);
    const append = session.appendMessage.bind(session);

    session.appendMessage = (message: unknown) =>
        append({ ...(message as object), content: [{ type: "text", text: "tampered" }] });
    assert.throws(
        () => persistSeed(session, folder, f.bob.workspace, publicNativeHistory(f.messages)),
        /readback mismatch/,
    );
});

for (const thread of ["main", "worker"] as const) {
    const chars = thread === "main" ? 128 : 8 * 1024 * 1024;

    test(`${thread}: public fork and import preserve independent target authorization`, async (t) => {
        const f = await fixture(t, undefined, chars);

        await f.journal.bind("forked", f.bob);
        await f.journal.bind("imported", f.bob);
        const phases: SeedPhaseSignal[] = [];

        observe(t, (s) => phases.push(s));
        assert.equal(
            (await f.executions.fork("shared", "forked", "fork", "shared")).status,
            "settled",
        );
        assert.equal(
            (await f.executions.importHistory("imported", "import", "digest", f.entries)).status,
            "settled",
        );
        assert.equal((await f.journal.session("shared")).segmentId, "shared");
        assert.ok(phases.filter((s) => s.phase === "compare").every((s) => s.thread === thread));
        assert.equal(phases.filter((s) => s.phase === "compare").length, 2);
        assert.equal(
            f.calls(),
            9,
            "fork checks both source and target in each phase; import checks its target",
        );
    });

    test(`${thread}: Stop during final authorization cannot commit an already read-back seed`, async (t) => {
        const reached = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const f = await fixture(
            t,
            async (call) => {
                if (call === 3) {
                    reached.resolve();
                    await release.promise;
                }
            },
            chars,
        );
        const pending = f.handoff();

        await reached.promise;
        await f.executions.abort("shared");
        assert.throws(() => f.executions.close(), /still active/);
        release.resolve();
        assert.equal((await pending).status, "unknown");
        assert.equal((await f.journal.session("shared")).segmentId, "shared");
    });

    test(`${thread}: failed materialization remains fenced after journal reopen`, async (t) => {
        const f = await fixture(t, undefined, chars);
        const attach = f.journal.attach.bind(f.journal);

        f.journal.attach = async (...args) => {
            await attach(...args);

            throw new Error("lost attach acknowledgement");
        };

        const result = await f.handoff();

        assert.equal(result.status, "unknown");
        await f.executions.close();
        const reopened = new RotomExecutions(f.data, async () => {});

        try {
            assert.equal(
                (await reopened.handoff("shared", "handoff", "shared", f.bob)).status,
                "unknown",
            );
            await assert.rejects(
                reopened.handoff("shared", "different", "shared", f.bob),
                KernelRequestConflict,
            );
            assert.equal((await reopened.journal.session("shared")).segmentId, "shared");
        } finally {
            await reopened.close();
        }
    });
}

for (const delta of [-1, 0, 1]) {
    test(`public JSON UTF-8 size at 8 MiB ${delta < 0 ? "minus 1" : delta === 0 ? "exactly" : "plus 1"} selects the boundary path`, async (t) => {
        const f = await fixture(t, undefined, 1);
        const wanted = 8 * 1024 * 1024 + delta;
        const overhead =
            Buffer.byteLength(JSON.stringify(publicNativeHistory(f.messages)), "utf8") - 1;
        const budget = wanted - overhead;
        const content = (
            f.entries[1]!.message as { content: Array<{ text?: string; thinking?: string }> }
        ).content;

        // Newline is escaped in JSON; é is two UTF-8 bytes but one JS character.
        content[0]!.text =
            "\n" + "é".repeat(Math.floor((budget - 2) / 2)) + ((budget - 2) % 2 ? "x" : "");

        if (delta === -1) {
            // Raw input exceeds the threshold, but private reasoning must not influence the public size.
            content[1]!.thinking = "private".repeat(1024 * 1024);
        }

        const json = JSON.stringify(publicNativeHistory(f.messages));

        assert.equal(Buffer.byteLength(json, "utf8"), wanted);
        assert.ok(json.length < 8 * 1024 * 1024);

        if (delta === -1) {
            assert.ok(Buffer.byteLength(JSON.stringify(f.messages), "utf8") > wanted + 1);
        }

        await f.journal.bind("boundary", f.bob);
        const phases: SeedPhaseSignal[] = [];

        observe(t, (s) => phases.push(s));
        assert.equal(
            (await f.executions.importHistory("boundary", "boundary", "digest", f.entries)).status,
            "settled",
        );
        assert.deepEqual(
            phases.filter((s) => s.phase === "prepare").map((s) => s.thread),
            [delta < 0 ? "main" : "worker"],
        );
    });
}
