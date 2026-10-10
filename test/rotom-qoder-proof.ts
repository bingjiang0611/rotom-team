/** Real pinned rotom / native Qoder transport / native tool proof, with synthetic auth and no provider network. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, readFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RotomExecutions, type QoderRequestAuth } from "../src/server/rotom-executions.ts";
import { verifyRotomKernel } from "../src/server/rotom-kernel.ts";
import { qoderRequestProvider } from "../src/server/rotom-qoder.mjs";

process.umask(0o077);
const { version } = verifyRotomKernel();
const modelId = process.argv[2] ?? "performance";

assert.ok(["performance", "qmodel"].includes(modelId));
const root = realpathSync(mkdtempSync(join(tmpdir(), "rotom-qoder-proof-")));
const home = join(root, "kernel-homes", "alice");
const workspace = join(root, "workspace");

mkdirSync(join(home, ".pi/agent/extensions"), { recursive: true, mode: 0o700 });
mkdirSync(workspace, { mode: 0o700 });
writeFileSync(
    join(home, ".pi/agent/settings.json"),
    JSON.stringify({ compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 1024 } }),
    { mode: 0o600 },
);
cpSync(
    new URL("./fixtures/qoder-native-fetch.mjs", import.meta.url),
    join(home, ".pi/agent/extensions/fixture.js"),
);
const auth: QoderRequestAuth = {
    credential: {
        accessToken: `synthetic-native-${randomUUID()}`,
        fingerprint: "a".repeat(64),
        expiresAt: Date.now() + 300_000,
        uid: "fixture",
        org: "",
        machineId: "00000000-0000-4000-8000-000000000001",
    },
    catalog: {
        scope: "a".repeat(64),
        checkedAt: Date.now(),
        metadata: {
            version: 1,
            assistant: [
                {
                    source: "system",
                    key: modelId,
                    display_name: modelId,
                    enable: true,
                    format: "openai",
                    max_input_tokens: 32000,
                    is_reasoning: modelId === "qmodel",
                },
            ],
        },
    },
};
const bobAuth: QoderRequestAuth = {
    credential: {
        ...auth.credential,
        accessToken: `synthetic-native-${randomUUID()}`,
        fingerprint: "b".repeat(64),
        uid: "fixture-bob",
    },
    catalog: { ...auth.catalog, scope: "b".repeat(64) },
};
const provider = await qoderRequestProvider(auth);
const model = provider.getModels()[0]!;
let inferenceChecks = 0;
let forbidFork = false;
const createExecutions = () =>
    new RotomExecutions(
        root,
        async (binding, operation) => {
            if (operation === "inference") {
                inferenceChecks++;

                return { qoder: binding.memberId === "bob" ? bobAuth : auth };
            }

            if (operation === "fork" && forbidFork) {
                throw new Error("Fork permission revoked");
            }

            if (operation === "refresh") {
                throw new Error("Native refresh is forbidden");
            }
        },
        () => ({
            modelDefinition: { ...model },
            context: "Use the native write tool, then finish.",
            skills: [],
        }),
    );
let executions = createExecutions();
const report: Record<string, unknown> = {
    status: "running",
    realProvider: false,
    version,
    modelId,
};

try {
    executions.journal.bind("qoder-conversation", {
        memberId: "alice",
        accountGeneration: "fixture-1",
        provider: "qoder",
        model: modelId,
        configurationDigest: "fixture",
        kernelVersion: version,
        home,
        workspace,
    });
    const receipt = await executions.run(
        "qoder-conversation",
        "native-qoder-once",
        "Write the fixture file and finish.",
    );

    assert.equal(receipt.status, "settled", JSON.stringify(receipt));
    assert.equal(readFileSync(join(workspace, "qoder-proof.txt"), "utf8"), "QODER_NATIVE_OK\n");
    assert.equal(inferenceChecks, 2);
    let session = executions.journal.session("qoder-conversation")!;
    const jsonl = readFileSync(session.sessionFile!, "utf8");

    assert.ok(!jsonl.includes(auth.credential.accessToken));
    assert.ok(
        jsonl.includes(auth.credential.fingerprint),
        "source really has private account binding to strip",
    );
    assert.deepEqual(JSON.parse(readFileSync(join(home, ".pi/agent/auth.json"), "utf8")), {});
    const entries = jsonl
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

    assert.equal(entries.filter((entry) => entry.customType === "fixture-qoder-network").length, 2);
    const credits = entries.filter((entry) => entry.customType === "qoder-credit-observation-v1");

    assert.equal(credits.length, 2);
    assert.equal(executions.journal.credits("qoder-conversation")[0]?.credits, 0.25);
    assert.equal(executions.journal.credits("qoder-conversation")[0]?.memberId, "alice");
    assert.ok(
        credits.every((entry) => entry.data.status === "reported" && entry.data.credits === 0.125),
    );
    assert.ok(
        entries.some(
            (entry) =>
                entry.message?.role === "assistant" &&
                entry.message.stopReason === "stop" &&
                JSON.stringify(entry.message.content).includes("NATIVE_QODER_FINISHED"),
        ),
    );
    assert.equal(executions.journal.usage("qoder-conversation").length, 2);
    const duplicate = await executions.run(
        "qoder-conversation",
        "native-qoder-once",
        "Write the fixture file and finish.",
    );

    assert.equal(duplicate.id, receipt.id);
    assert.equal(inferenceChecks, 2);
    const sourcePath = session.sessionFile!;
    const bobHome = join(root, "kernel-homes/bob");

    mkdirSync(join(bobHome, ".pi/agent/extensions"), { recursive: true, mode: 0o700 });
    cpSync(
        join(home, ".pi/agent/extensions/fixture.js"),
        join(bobHome, ".pi/agent/extensions/fixture.js"),
    );
    writeFileSync(
        join(bobHome, ".pi/agent/settings.json"),
        JSON.stringify({
            compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 1024 },
        }),
        { mode: 0o600 },
    );
    const bobBinding = {
        ...session.binding,
        memberId: "bob",
        accountGeneration: "fixture-bob",
        home: bobHome,
    };
    const handoff = await executions.handoff(
        "qoder-conversation",
        "handoff-once",
        session.segmentId,
        bobBinding,
    );

    assert.equal(handoff.status, "settled", JSON.stringify(handoff));
    const originalSegment = session.segmentId;

    session = executions.journal.session("qoder-conversation");
    assert.equal(session.binding.memberId, "bob");
    assert.notEqual(session.sessionFile, sourcePath);
    assert.equal(readFileSync(sourcePath, "utf8"), jsonl);
    const seeded = readFileSync(session.sessionFile!, "utf8");

    assert.ok(seeded.includes("team_tool_1"));
    assert.ok(!seeded.includes("qoder-account-v1"));
    assert.ok(!seeded.includes(auth.credential.fingerprint));
    assert.deepEqual(
        executions.journal.usage("qoder-conversation").map((row) => row.memberId),
        ["alice", "alice"],
    );
    assert.equal(
        (
            await executions.handoff(
                "qoder-conversation",
                "handoff-once",
                originalSegment,
                bobBinding,
            )
        ).id,
        handoff.id,
    );
    assert.equal(inferenceChecks, 2);
    const compact = await executions.compact(
        "qoder-conversation",
        "compact-once",
        "Preserve the file outcome.",
    );

    assert.equal(compact.status, "settled", JSON.stringify(compact));
    assert.equal(inferenceChecks, 3);
    const compacted = readFileSync(session.sessionFile!, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    const summary = compacted.find((entry) => entry.type === "compaction");

    assert.ok(summary?.summary.includes("NATIVE_QODER_SUMMARY"));
    assert.equal(executions.journal.usage("qoder-conversation").length, 3);
    assert.equal(executions.journal.usage("qoder-conversation").at(-1)?.attemptId, compact.id);
    assert.equal(
        (
            await executions.compact(
                "qoder-conversation",
                "compact-once",
                "Preserve the file outcome.",
            )
        ).id,
        compact.id,
    );
    assert.equal(inferenceChecks, 3);
    executions.close();
    executions = createExecutions();
    assert.equal(
        (
            await executions.compact(
                "qoder-conversation",
                "compact-once",
                "Preserve the file outcome.",
            )
        ).id,
        compact.id,
    );
    assert.equal(inferenceChecks, 3);
    const after = await executions.run(
        "qoder-conversation",
        "after-compact",
        "Use the summary and finish.",
    );

    assert.equal(after.status, "settled");
    assert.equal(inferenceChecks, 4);
    assert.deepEqual(
        executions.journal.usage("qoder-conversation").map((row) => row.memberId),
        ["alice", "alice", "bob", "bob"],
    );
    assert.equal(readFileSync(sourcePath, "utf8"), jsonl);
    const resumed = readFileSync(session.sessionFile!, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

    assert.ok(
        resumed.some(
            (entry) =>
                entry.customType === "fixture-qoder-network" &&
                entry.data.summarySeen &&
                !entry.data.compact,
        ),
    );
    const beforeFork = readFileSync(session.sessionFile!, "utf8");

    assert.ok(beforeFork.includes(bobAuth.credential.fingerprint));
    const aliceBinding = executions.journal.segment(originalSegment).binding;

    executions.journal.bind("qoder-fork", aliceBinding);
    const fork = await executions.fork(
        "qoder-conversation",
        "qoder-fork",
        "fork-once",
        session.segmentId,
    );

    assert.equal(fork.status, "settled", JSON.stringify(fork));
    assert.equal(executions.journal.usage("qoder-fork").length, 0);
    assert.deepEqual(executions.journal.credits("qoder-fork"), []);
    const forkSession = executions.journal.session("qoder-fork");

    assert.notEqual(forkSession.sessionFile, session.sessionFile);
    assert.ok(
        !readFileSync(forkSession.sessionFile!, "utf8").includes(bobAuth.credential.fingerprint),
    );
    assert.equal(
        (await executions.fork("qoder-conversation", "qoder-fork", "fork-once", session.segmentId))
            .id,
        fork.id,
    );
    assert.equal(inferenceChecks, 4);
    const forkReply = await executions.run(
        "qoder-fork",
        "fork-continue",
        "Use the inherited summary and finish.",
    );

    assert.equal(forkReply.status, "settled");
    assert.equal(inferenceChecks, 5);
    assert.deepEqual(
        executions.journal.usage("qoder-fork").map((row) => row.memberId),
        ["alice"],
    );
    assert.equal(readFileSync(session.sessionFile!, "utf8"), beforeFork);
    executions.journal.bind("fork-denied", aliceBinding);
    forbidFork = true;
    await assert.rejects(
        executions.fork("qoder-conversation", "fork-denied", "denied", session.segmentId),
        /permission revoked/,
    );
    assert.equal(executions.journal.receipts("fork-denied").length, 0);
    forbidFork = false;
    writeFileSync(join(workspace, ".fixture-compact-error"), "fixture", { mode: 0o600 });
    const failed = await executions.compact(
        "qoder-conversation",
        "compact-error",
        "Preserve outcomes.",
    );

    assert.equal(
        failed.status,
        "unknown",
        "a failed model-backed compact must not claim no external effects",
    );
    const callsAfterFailure = inferenceChecks;

    assert.ok(callsAfterFailure > 5);
    executions.close();
    executions = createExecutions();
    assert.equal(
        (await executions.compact("qoder-conversation", "compact-error", "Preserve outcomes.")).id,
        failed.id,
    );
    await assert.rejects(
        executions.run("qoder-conversation", "cannot-bypass", "new prompt"),
        /unknown attempt/,
    );
    await assert.rejects(
        executions.fork("qoder-conversation", "fork-denied", "unknown-source", session.segmentId),
        /active or unknown/,
    );
    assert.equal(executions.journal.receipts("fork-denied").length, 0);
    assert.equal(inferenceChecks, callsAfterFailure);
    const subtotals = executions.journal.credits("qoder-conversation");

    assert.equal(subtotals.find((row) => row.memberId === "alice")?.credits, 0.25);
    const bobSubtotal = subtotals.find((row) => row.memberId === "bob")!;

    assert.equal(bobSubtotal.credits, 0.25);
    assert.ok(bobSubtotal.unknown + bobSubtotal.unmeteredOperations > 0);
    assert.equal(executions.journal.credits("qoder-fork")[0]?.credits, 0.125);
    Object.assign(report, {
        status: "passed",
        compactedHistoryUsedAfterRestart: true,
        compactionFailureFencedAfterRestart: true,
        nativeHandoffSeeded: true,
        nativeForkSeededAndContinued: true,
        forkPayerAndSourcePreserved: true,
        forkPermissionAndUnknownDenials: true,
        inheritedUsageNotRebilled: true,
        sourceSessionUnchanged: true,
        nativeCompactionPersisted: true,
        compactionUsageAttributed: true,
        compactionDuplicateNoDispatch: true,
        nativeWrite: true,
        nativeQoderStream: true,
        duplicateNoDispatch: true,
        accessNotInSession: true,
        creditsPersisted: true,
        sharedCreditSubtotalsAndUnknown: true,
        inferenceChecks,
    });
} finally {
    executions.close();
    writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ ...report, evidence: join(root, "report.json") }));
}
