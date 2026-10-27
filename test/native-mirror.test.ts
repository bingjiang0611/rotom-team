import { context, owner, root, work, scriptedModel, cleanUp } from "./helpers.ts";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { AuthorsDoc } from "../src/server/docs.ts";
import { NATIVE_ENTRY } from "../src/server/entry-format.ts";
import { PocketApp } from "../src/server/app.ts";
import { NativeMirrorDoc } from "../src/server/team-kernel.ts";
import type { KernelBinding, KernelEntry } from "../src/server/rotom-journal.ts";
import { sendPhaseChannel, sendTraceTag, type SendPhaseSignal } from "../src/server/send-trace.ts";

test.after(cleanUp);

type NativeRecord = { id: number; data: { entry?: { id?: string }; requestId?: string } };
type ChildResult = {
    mirror: { count: number };
    authors: { entries: Record<string, string> };
    native: NativeRecord[];
    branch: boolean;
    state: unknown;
    info: unknown;
};

function nativeProvider(model: ReturnType<typeof scriptedModel>["provider"]) {
    return {
        ...model,
        id: "openai",
        getModels: () =>
            model.getModels().map((each) => ({
                ...each,
                provider: "openai",
                api: "openai-completions" as const,
            })),
    };
}

function messageEntry(id: string, binding: KernelBinding, role: "user" | "assistant"): KernelEntry {
    return {
        type: "message",
        id,
        message: {
            role,
            ...(role === "assistant"
                ? { provider: binding.provider, model: binding.model, stopReason: "stop" }
                : {}),
        },
    };
}

function childMirror(
    dataDir: string,
    cwd: string,
    id: number,
    storageWorker: boolean,
): Promise<ChildResult> {
    return new Promise((resolve, reject) => {
        const child = fork(
            new URL("./fixtures/native-mirror.ts", import.meta.url),
            [JSON.stringify({ dataDir, cwd, id, storageWorker })],
            {
                stdio: ["ignore", "ignore", "pipe", "ipc"],
                execArgv: [
                    "--import",
                    new URL("./fixtures/native-mirror-guard.ts", import.meta.url).href,
                ],
            },
        );
        let result: ChildResult | undefined;
        let stderr = "";

        child.stderr?.on("data", (chunk) => {
            stderr += String(chunk);
        });
        child.on("message", (message: ChildResult | { error: string }) => {
            if ("error" in message) {
                reject(new Error(message.error));
            } else {
                result = message;
            }
        });
        child.once("error", reject);
        child.once("exit", (code) => {
            if (code !== 0) {
                reject(new Error(`native mirror fixture exited ${code}: ${stderr}`));
            } else if (result) {
                resolve(result);
            } else {
                reject(new Error("native mirror fixture returned no result"));
            }
        });
    });
}

function recordSummary(records: NativeRecord[]) {
    return records.map((record) => ({
        id: record.data.entry?.id,
        requestId: record.data.requestId,
    }));
}

for (const storageWorker of [false, true]) {
    test(
        `native mirror resumes exact metadata after a real PocketApp restart (storageWorker=${storageWorker})`,
        { timeout: 30_000 },
        async () => {
            const dataDir = join(realpathSync(root), `native-mirror-data-${storageWorker}`);

            mkdirSync(dataDir, { mode: 0o700 });
            const model = scriptedModel();
            const app = await PocketApp.open({
                dataDir: realpathSync(dataDir),
                defaultCwd: realpathSync(work),
                supervised: false,
                kernel: true,
                storageWorker,
                browser: null,
                log: () => {},
                configureUserModels: (models) =>
                    models.registerNativeProvider(nativeProvider(model.provider)),
            });
            let closed = false;
            const member = owner(app);
            const session = await app.commands.createSession(member, { backend: "rotom" });
            const id = Number(session.id);
            const journal = app.kernel!.executions.journal;
            const binding = (await journal.session(String(id))).binding;
            const phases: SendPhaseSignal[] = [];
            const onPhase = (signal: unknown) => phases.push(signal as SendPhaseSignal);

            sendPhaseChannel.subscribe(onPhase);

            const append = async (
                requestId: string,
                entries: KernelEntry[],
                operation: "prompt" | "fork" = "prompt",
            ) => {
                const attempt = await journal.reserve(
                    String(id),
                    operation === "prompt" ? `${member.id}:${requestId}` : requestId,
                    requestId,
                    operation,
                );
                const segment = await journal.segment(attempt.segmentId);

                await journal.attach(
                    attempt.id,
                    segment.sessionFile ?? join(dataDir, `${attempt.segmentId}.jsonl`),
                    segment.kernelSessionId ?? `fixture-${attempt.segmentId}`,
                );
                await journal.finish(attempt.id, "settled", entries);

                return attempt;
            };

            try {
                const prefix = [
                    { type: "custom", id: "branch-marker", customType: "team-kernel-branch" },
                    messageEntry("prefix-user", binding, "user"),
                    messageEntry("prefix-answer", binding, "assistant"),
                ];

                await append("resume-in-user-request", prefix);
                await app.kernel!.mirror(session.id);
                assert.deepEqual(
                    phases.map((phase) => phase.trace),
                    [sendTraceTag(String(id), `${member.id}:resume-in-user-request`)],
                );

                const prefixRoom = await app.room(session.id);
                const prefixNative = prefixRoom.value!.entries.filter(
                    (entry) => entry.kind === NATIVE_ENTRY,
                ) as NativeRecord[];
                const prefixDoc = await app.harness.snapshot(NativeMirrorDoc, session.id, context);

                assert.equal(prefixDoc?.count, prefix.length);
                assert.deepEqual(recordSummary(prefixNative), [
                    { id: "branch-marker", requestId: undefined },
                    { id: "prefix-user", requestId: "resume-in-user-request" },
                    { id: "prefix-answer", requestId: undefined },
                ]);
                const prefixAuthors = await app.harness.snapshot(AuthorsDoc, session.id, context);

                assert.equal(prefixAuthors?.entries[String(prefixNative[1]!.id)], member.id);

                const expectedHead = (await journal.session(String(id))).segmentId;
                const handoff = await journal.handoff(
                    String(id),
                    `${member.id}:handoff`,
                    expectedHead,
                    binding,
                );

                await journal.attach(handoff.id, join(dataDir, "handoff.jsonl"), "handoff-native");
                await journal.finish(handoff.id, "settled", [
                    { type: "custom", id: "copied-handoff-seed", customType: "handoff-seed" },
                ]);
                await append("after-handoff", [
                    messageEntry("after-handoff-user", binding, "user"),
                    messageEntry("after-handoff-answer", binding, "assistant"),
                ]);

                const originalCommit = app.harness.commit.bind(app.harness);
                let failCommit = true;
                const harness = app.harness as unknown as {
                    commit: (...args: never[]) => Promise<unknown>;
                };

                harness.commit = async (...args) => {
                    if (failCommit) {
                        failCommit = false;

                        throw new Error("fixture Durable commit failure");
                    }

                    return Reflect.apply(originalCommit, app.harness, args) as Promise<unknown>;
                };

                await assert.rejects(
                    app.kernel!.mirror(session.id),
                    /fixture Durable commit failure/,
                );
                assert.equal(phases.length, 1, "a failed mirror commit is not a measured delivery");
                const afterFailure = await app.harness.snapshot(
                    NativeMirrorDoc,
                    session.id,
                    context,
                );

                assert.equal(
                    afterFailure?.count,
                    prefix.length,
                    "a failed commit does not advance the cursor",
                );
                await app.kernel!.mirror(session.id);
                assert.equal(phases.length, 2);
                assert.equal(
                    phases[1]!.trace,
                    sendTraceTag(String(id), `${member.id}:after-handoff`),
                );
                assert.equal(phases[1]!.phase, "mirrored");
                await app.kernel!.mirror(session.id);
                assert.equal(phases.length, 2, "an unchanged prefix is not measured again");
                const afterRetry = await app.harness.snapshot(NativeMirrorDoc, session.id, context);

                assert.equal(afterRetry?.count, prefix.length + 2);
                await append("committed-suffix", [
                    messageEntry("committed-user", binding, "user"),
                    messageEntry("committed-answer", binding, "assistant"),
                ]);
                let loseCompletion = true;

                harness.commit = async (...args) => {
                    const result = await Reflect.apply(originalCommit, app.harness, args);

                    if (loseCompletion) {
                        loseCompletion = false;

                        throw new Error("fixture completion lost after Durable commit");
                    }

                    return result;
                };

                await assert.rejects(app.kernel!.mirror(session.id), /completion lost/);
                assert.equal(
                    (await app.harness.snapshot(NativeMirrorDoc, session.id, context))?.count,
                    prefix.length + 4,
                );
                await app.kernel!.mirror(session.id);
                assert.equal(
                    (await app.harness.snapshot(NativeMirrorDoc, session.id, context))?.count,
                    prefix.length + 4,
                    "committed suffix is not duplicated when the local cursor missed completion",
                );
                await append("last-suffix", [
                    messageEntry("last-suffix-user", binding, "user"),
                    messageEntry("last-suffix-answer", binding, "assistant"),
                ]);
                const expected = await journal.entries(String(id));
                const expectedIds = expected.map((row) => row.entry.id);

                await app.close();
                closed = true;
                const restarted = await childMirror(
                    realpathSync(dataDir),
                    realpathSync(work),
                    id,
                    storageWorker,
                );

                assert.equal(restarted.mirror.count, expected.length);
                assert.deepEqual(
                    restarted.native.map((record) => record.data.entry?.id),
                    expectedIds,
                    "restart preserves exact journal order without replaying handoff seeds",
                );
                assert.deepEqual(recordSummary(restarted.native), [
                    { id: "branch-marker", requestId: undefined },
                    { id: "prefix-user", requestId: "resume-in-user-request" },
                    { id: "prefix-answer", requestId: undefined },
                    { id: "after-handoff-user", requestId: "after-handoff" },
                    { id: "after-handoff-answer", requestId: undefined },
                    { id: "committed-user", requestId: "committed-suffix" },
                    { id: "committed-answer", requestId: undefined },
                    { id: "last-suffix-user", requestId: "last-suffix" },
                    { id: "last-suffix-answer", requestId: undefined },
                ]);

                for (const record of restarted.native.filter(
                    (each) => each.data.requestId !== undefined,
                )) {
                    assert.equal(restarted.authors.entries[String(record.id)], member.id);
                }

                assert.equal(restarted.branch, true);
                const switched = await childMirror(
                    realpathSync(dataDir),
                    realpathSync(work),
                    id,
                    !storageWorker,
                );

                assert.deepEqual(
                    switched,
                    restarted,
                    "switching database ownership preserves the same persisted mirror and room payloads",
                );
            } finally {
                sendPhaseChannel.unsubscribe(onPhase);

                if (!closed) {
                    await app.close();
                }

                rmSync(dataDir, { recursive: true, force: true });
            }
        },
    );
}
