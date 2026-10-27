/** Explicit real-account native acceptance. Each phase gets one persisted intent; never replay an uncertain phase. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";

const data = process.argv[2] && resolve(process.argv[2]);
const phase = process.argv[3];

assert.ok(
    data &&
        phase &&
        [
            "--prepare",
            "--alice-write",
            "--alice-write-proxy",
            "--bob-handoff",
            "--bob-read",
            "--bob-compact",
            "--bob-resume",
            "--alice-fork",
            "--alice-fork-read",
            "--alice-return",
        ].includes(phase),
    "Usage: node test/real-kernel.ts /independent/data --<explicit-phase> (real accounts; see the phase allowlist)",
);
assert.equal(realpathSync(data), data);
assert.equal(lstatSync(data).mode & 0o077, 0);
process.umask(0o077);
process.env.PI_CODING_AGENT_DIR = join(data, "agent");
process.env.PI_POCKET_GUARD = "off";

const present = (path: string) => Boolean(lstatSync(path, { throwIfNoEntry: false }));

for (const name of ["harness.lock", "kernel.lock"]) {
    assert.equal(
        present(join(data, name)),
        false,
        "Existing writer lease; reconcile without opening another writer",
    );
}

const database = join(data, "pocket.sqlite");

assert.equal(realpathSync(database), database);
const db = new DatabaseSync(database, { readOnly: true });

try {
    assert.equal(
        db
            .prepare(
                "SELECT count(*) n FROM tasks WHERE json_extract(record,'$.state.status') IS NOT 'terminal'",
            )
            .get()!.n,
        0,
        "Existing Durable work must be reconciled before native validation",
    );
} finally {
    db.close();
}

const { requireNoPendingKernel } = await import("../src/server/rotom-journal.ts");

requireNoPendingKernel(data);
const output = join(data, "native-acceptance");

mkdirSync(output, { recursive: true, mode: 0o700 });
assert.equal(realpathSync(output), output);
assert.equal(lstatSync(output).mode & 0o077, 0);
const reportPath = join(output, `${phase.slice(2)}.json`);

if (phase !== "--prepare") {
    const prepared = JSON.parse(readFileSync(join(output, "prepare.json"), "utf8"));

    assert.equal(prepared.status, "passed");
    assert.equal(prepared.closed, true);
}

assert.equal(
    present(reportPath),
    false,
    "This phase already has an intent/result. Inspect it read-only; do not replay",
);

if (
    [
        "--bob-handoff",
        "--bob-read",
        "--bob-compact",
        "--bob-resume",
        "--alice-fork",
        "--alice-fork-read",
        "--alice-return",
    ].includes(phase)
) {
    const prerequisite = {
        "--bob-handoff": "alice-write-proxy",
        "--bob-read": "bob-handoff",
        "--bob-compact": "bob-read",
        "--bob-resume": "bob-compact",
        "--alice-fork": "bob-resume",
        "--alice-fork-read": "alice-fork",
        "--alice-return": "alice-fork-read",
    }[phase]!;
    const previous = JSON.parse(readFileSync(join(output, `${prerequisite}.json`), "utf8"));

    assert.equal(previous.status, "passed");
    assert.equal(previous.closed, true);
}

const members = [
    {
        id: "de4c8f9a-0b68-41d7-8ddc-af392793b890",
        provider: "openai",
        model: "gpt-6.1-sol",
        guard: "oauth-refresh",
    },
    {
        id: "f17c2989-6e8e-4c76-9b7c-1118c7745af0",
        provider: "qoder",
        model: "performance",
        guard: "",
    },
];

function credential(member: (typeof members)[number]) {
    const path = join(data!, "people", member.id, "auth.json");
    const stat = lstatSync(path);

    assert.ok(stat.isFile() && !stat.isSymbolicLink() && !(stat.mode & 0o077));
    assert.equal(realpathSync(path), path);
    const value = JSON.parse(readFileSync(path, "utf8"))[member.provider];

    assert.equal(value.type, "oauth");
    assert.equal(value.rotomTeamReadOnlyImport, undefined);
    assert.equal(typeof value.refresh, "string");
    assert.equal(typeof value.access, "string");

    return value;
}

function attempted(member: (typeof members)[number], token: string) {
    return present(
        join(
            data!,
            "people",
            member.id,
            member.guard,
            "qoder-refresh-attempts",
            createHash("sha256").update(token).digest("hex"),
        ),
    );
}

const before = members.map((member) => credential(member));

for (const [index, member] of members.entries()) {
    assert.equal(
        attempted(member, before[index].refresh),
        false,
        "Current refresh already attempted; no replay",
    );
}

const report: Record<string, unknown> = {
    phase: phase.slice(2),
    status: "startup-intent",
    realProvider: true,
    inferenceDispatched: false,
    createdAt: new Date().toISOString(),
    before: members.map((member, index) => ({
        provider: member.provider,
        expires: before[index].expires,
        refreshDigest: createHash("sha256").update(before[index].refresh).digest("hex"),
        accessDigest: createHash("sha256").update(before[index].access).digest("hex"),
    })),
};

if (phase === "--alice-write-proxy") {
    const prior = JSON.parse(readFileSync(join(output, "alice-write.json"), "utf8"));
    const readback = JSON.parse(readFileSync(join(output, "alice-write-readback.json"), "utf8"));

    assert.equal(prior.status, "not-verified");
    assert.equal(readback.receiptId, prior.receipt.id);
    assert.equal(readback.nativeStatus, "settled");
    assert.equal(readback.assistantStopReason, "error");
    assert.equal(readback.toolCalls, 0);
    assert.equal(present(prior.artifact), false);
    report.priorUnknownCostReceipt = prior.receipt.id;
    report.authorization =
        "User explicitly approved one new validation after local proxy regression; old task is not replayed";
}

writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600, flag: "wx" });
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
const { PocketApp } = await import("../src/server/app.ts");
let app: Awaited<ReturnType<typeof PocketApp.open>> | undefined;

try {
    app = await PocketApp.open({
        dataDir: data,
        defaultCwd: join(data, "workspace"),
        kernel: true,
        supervised: false,
        browser: null,
        log: () => {},
    });
    const catalogs = [];

    for (const member of members) {
        const user = app.config.userById(member.id);

        assert.ok(user && user.role !== "viewer");
        await app.accounts.forUser(user);
        const available: readonly Model<Api>[] = app.accounts
            .available(user)
            .filter((model) => model.provider.endsWith(`:${member.provider}`));
        const selected = available.find((model) => model.id === member.model);

        assert.ok(selected, "Previously authorized model is unavailable; do not fall back");
        catalogs.push({
            memberId: member.id,
            provider: member.provider,
            selectedModel: selected.id,
            accountGeneration: selected.provider,
            modelIds: available.map((model) => model.id),
        });
    }

    report.catalogs = catalogs;

    let admissions = 0;

    if (phase !== "--prepare") {
        // A validation-only bound at the ordinary model/auth seams; the pinned runtime still owns every turn/tool.
        const kernelModel = app.accounts.kernelModel.bind(app.accounts);

        app.accounts.kernelModel = (actor, ref) => {
            const selected = kernelModel(actor, ref);

            return { ...selected, maxTokens: Math.min(selected.maxTokens, 4096) };
        };

        const kernelAuth = app.accounts.kernelAuth.bind(app.accounts);

        app.accounts.kernelAuth = async (...args) => {
            assert.ok(
                ++admissions <= 4,
                "Validation inference budget exhausted; do not dispatch another model call",
            );
            report.authAdmissions = admissions;
            save();

            return kernelAuth(...args);
        };
    }

    if (phase === "--alice-write" || phase === "--alice-write-proxy") {
        const user = app.config.userById(members[0]!.id)!;
        const model = catalogs[0]!;

        app.accounts.choose(user, {
            provider: model.accountGeneration,
            modelId: model.selectedModel,
            thinkingLevel: "low",
        });
        const { id } = await app.commands.createSession(user, {
            backend: "rotom",
            title: "Native real-account acceptance",
        });
        const nonce = randomUUID();
        const artifact = join(data, "workspace", `native-proof-${nonce}.txt`);

        assert.equal(present(artifact), false);
        const content = `NATIVE_TEAM_OK ${nonce}\n`;
        const requestId = randomUUID();

        report.conversationId = Number(id);
        report.requestId = requestId;
        report.artifact = artifact;
        report.expectedContent = content;
        report.status = "dispatch-intent";
        report.inferenceDispatched = "unknown-until-receipt";
        save();
        const receipt = await app.kernel!.submit(
            id,
            user,
            requestId,
            `Use the native write tool exactly once to create ${artifact} with exactly this content (including the final newline): ${JSON.stringify(content)}. Do not use bash, read credentials, or modify another path. Then briefly confirm completion.`,
        );

        report.receipt = receipt;
        report.authAdmissions = admissions;
        report.inferenceAdmitted = admissions > 0;
        report.inferenceDispatched = admissions > 0 ? "unknown-without-provider-evidence" : false;
        save();
        assert.equal(receipt.status, "settled");
        const journal = app.kernel!.executions.journal;
        const entries = (await journal.entries(String(id))).map((row) => row.entry);
        const messages = entries
            .filter((entry) => entry.type === "message")
            .map(
                (entry) =>
                    entry.message as {
                        role: string;
                        toolName?: string;
                        isError?: boolean;
                        stopReason?: string;
                    },
            );

        assert.ok(
            messages.some(
                (message) =>
                    message.role === "toolResult" &&
                    message.toolName === "write" &&
                    !message.isError,
            ),
        );
        assert.equal(
            messages.filter((message) => message.role === "assistant").at(-1)?.stopReason,
            "stop",
        );
        assert.equal(readFileSync(artifact, "utf8"), content);
        const sessionFile = (await journal.session(String(id))).sessionFile!;
        const serialized = readFileSync(sessionFile, "utf8");

        for (const value of [...before, ...members.map((member) => credential(member))]) {
            assert.equal(
                serialized.includes(value.access),
                false,
                "Access credential found in native transcript",
            );
            assert.equal(
                serialized.includes(value.refresh),
                false,
                "Refresh credential found in native transcript",
            );
        }

        assert.equal(
            readFileSync(
                join((await journal.session(String(id))).binding.home, ".pi/agent/auth.json"),
                "utf8",
            ).trim(),
            "{}",
        );
        report.nativeFile = sessionFile;

        if (phase === "--alice-write-proxy") {
            const prior = JSON.parse(readFileSync(join(output, "alice-write.json"), "utf8"));

            assert.notEqual(Number(id), prior.conversationId);
            assert.notEqual(artifact, prior.artifact);
            assert.equal(present(prior.artifact), false);
            report.previousTaskUntouched = true;
        }

        report.diskAndToolVerified = true;
        report.noCredentialInNativeTranscript = true;
        report.childAuthStoreEmpty = true;
        report.usage = await journal.usage(String(id));
        report.frozenConfigurationDigest = (await app.configuration(id))!.digest;
    }

    if (
        [
            "--bob-handoff",
            "--bob-read",
            "--bob-compact",
            "--bob-resume",
            "--alice-fork",
            "--alice-fork-read",
            "--alice-return",
        ].includes(phase)
    ) {
        const base = JSON.parse(readFileSync(join(output, "alice-write-proxy.json"), "utf8"));
        const forked =
            phase === "--alice-fork-read"
                ? JSON.parse(readFileSync(join(output, "alice-fork.json"), "utf8"))
                : undefined;
        const id = (forked ? forked.targetId : base.conversationId) as ConversationId;
        const actor = phase.startsWith("--alice-") ? 0 : 1;
        const user = app.config.userById(members[actor]!.id)!;
        const model = catalogs[actor]!;
        const { getSupportedThinkingLevels } = await import("@earendil-works/pi-ai");
        const selected = app.accounts
            .available(user)
            .find((m) => m.provider === model.accountGeneration && m.id === model.selectedModel)!;
        const levels = getSupportedThinkingLevels(selected);

        app.accounts.choose(user, {
            provider: model.accountGeneration,
            modelId: model.selectedModel,
            thinkingLevel: levels.includes("low") ? "low" : levels[0],
        });
        const journal = app.kernel!.executions.journal;
        const source = await journal.session(String(id));
        const requestId = randomUUID();
        const oldFileDigest = createHash("sha256")
            .update(readFileSync(source.sessionFile!))
            .digest("hex");

        report.conversationId = Number(id);
        report.requestId = requestId;
        report.expectedHead = source.segmentId;
        report.status = "dispatch-intent";
        save();

        if (phase === "--alice-fork") {
            const sourceUsage = await journal.usage(String(id));
            const target = await app.kernel!.fork(id, user, requestId, source.segmentId);

            report.targetId = Number(target.id);
            report.receipt = target.receipt;
            save();
            assert.equal(target.receipt?.status, "settled");
            assert.notEqual(target.id, id);
            const result = await journal.session(String(target.id));

            assert.equal(result.binding.memberId, user.id);
            assert.equal(result.binding.configurationDigest, base.frozenConfigurationDigest);
            assert.notEqual(result.kernelSessionId, source.kernelSessionId);
            assert.deepEqual(await journal.session(String(id)), source);
            assert.equal(
                createHash("sha256").update(readFileSync(source.sessionFile!)).digest("hex"),
                oldFileDigest,
            );
            assert.deepEqual(await journal.usage(String(id)), sourceUsage);
            assert.deepEqual(await journal.usage(String(target.id)), []);
            assert.doesNotMatch(
                JSON.stringify(await journal.segmentEntries(result.segmentId)),
                /"(?:textSignature|thinkingSignature|thoughtSignature|responseId)"\s*:/,
            );
            assert.equal(admissions, 0);
            report.crossProviderIndependentFork = true;
            report.sourceFile = source.sessionFile;
            report.sourceFileDigest = oldFileDigest;
            report.sourceUsageDigest = createHash("sha256")
                .update(JSON.stringify(sourceUsage))
                .digest("hex");
            report.nativeFile = result.sessionFile;
        } else if (phase === "--bob-handoff" || phase === "--alice-return") {
            const beforeUsage = await journal.usage(String(id));
            const receipt = await app.kernel!.handoff(id, user, requestId, source.segmentId);

            report.receipt = receipt;
            save();
            assert.equal(receipt?.status, "settled");
            const target = await journal.session(String(id));

            assert.notEqual(target.segmentId, source.segmentId);
            assert.equal(target.binding.memberId, user.id);
            assert.equal(target.binding.configurationDigest, base.frozenConfigurationDigest);
            assert.notEqual(target.kernelSessionId, source.kernelSessionId);
            assert.equal(
                createHash("sha256").update(readFileSync(source.sessionFile!)).digest("hex"),
                oldFileDigest,
            );
            const seed = await journal.segmentEntries(target.segmentId);
            const imported = seed
                .filter((e) => e.type === "message")
                .map(
                    (e) =>
                        e.message as {
                            role: string;
                            provider?: string;
                            content?: { type: string }[];
                        },
                );

            assert.ok(imported.some((m) => m.role === "toolResult"));

            for (const message of imported.filter((m) => m.role === "assistant")) {
                assert.equal(message.provider, "team-public-history");
                assert.ok(
                    message.content!.every((c) => c.type === "text" || c.type === "toolCall"),
                );
            }

            assert.doesNotMatch(
                JSON.stringify(seed),
                /"(?:textSignature|thinkingSignature|thoughtSignature|responseId)"\s*:/,
            );
            assert.deepEqual(await journal.usage(String(id)), beforeUsage);
            assert.equal(admissions, 0);
            report.publicSeedWithoutRebilling = true;
            report.sourceFileUnchanged = true;
            report.targetSegment = target.segmentId;
            report.nativeFile = target.sessionFile;
        } else if (phase === "--bob-compact") {
            assert.equal(source.binding.memberId, user.id);
            const settingsFile = join(source.binding.home, ".pi/agent/settings.json");
            const settings = present(settingsFile)
                ? JSON.parse(readFileSync(settingsFile, "utf8"))
                : {};

            report.priorCompactionSettings = settings.compaction ?? null;
            report.validationCompaction = {
                enabled: false,
                keepRecentTokens: 64,
                reserveTokens: 1024,
            };
            writeFileSync(
                settingsFile,
                JSON.stringify({ ...settings, compaction: report.validationCompaction }),
                { mode: 0o600 },
            );
            report.inferenceDispatched = "unknown-until-provider-evidence";
            save();
            const receipt = await app.kernel!.compact(
                id,
                user,
                requestId,
                "Preserve the exact file path and NATIVE_TEAM_OK marker, who wrote/read it, and that it must not be rewritten. Summarize briefly.",
            );

            report.receipt = receipt;
            report.authAdmissions = admissions;
            save();
            assert.equal(receipt.status, "settled");
            const summary = (await journal.entries(String(id)))
                .filter((row) => row.attemptId === receipt.id)
                .map((row) => row.entry)
                .find((entry) => entry.type === "compaction");

            assert.ok(summary && typeof summary.summary === "string");
            assert.ok(summary.summary.includes(base.expectedContent.trim()));
            assert.ok(summary.summary.includes(base.artifact));
            assert.ok(admissions > 0);
            assert.equal(readFileSync(base.artifact, "utf8"), base.expectedContent);
            const billed = (await journal.usage(String(id))).filter(
                (row) => row.attemptId === receipt.id,
            );

            assert.ok(billed.length > 0 && billed.every((row) => row.memberId === user.id));
            report.summaryEntryId = summary.id;
            report.nativeCompactionVerified = true;
            report.inferenceDispatched = true;
            report.usage = billed;
            report.credits = await journal.credits(String(id));
        } else if (phase === "--bob-resume") {
            assert.equal(source.binding.memberId, user.id);
            assert.ok(
                (await journal.segmentEntries(source.segmentId)).some(
                    (entry) => entry.type === "compaction",
                ),
            );
            report.inferenceDispatched = "unknown-until-provider-evidence";
            save();
            const receipt = await app.kernel!.submit(
                id,
                user,
                requestId,
                "Without using any tools, report the exact original validation marker and full file path recorded in the compacted history. Do not read or modify files.",
            );

            report.receipt = receipt;
            report.authAdmissions = admissions;
            save();
            assert.equal(receipt.status, "settled");
            const messages = (await journal.entries(String(id)))
                .filter((row) => row.attemptId === receipt.id && row.entry.type === "message")
                .map(
                    (row) =>
                        row.entry.message as {
                            role: string;
                            stopReason?: string;
                            content?: { type: string; text?: string }[];
                        },
                );

            assert.ok(
                messages.every(
                    (message) =>
                        message.role !== "toolResult" &&
                        (message.content ?? []).every((part) => part.type !== "toolCall"),
                ),
            );
            const answer = messages.filter((message) => message.role === "assistant").at(-1)!;

            assert.equal(answer.stopReason, "stop");
            const text = answer
                .content!.filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n");

            assert.ok(text.includes(base.expectedContent.trim()) && text.includes(base.artifact));
            assert.equal(readFileSync(base.artifact, "utf8"), base.expectedContent);
            report.postRestartCompactedContextVerified = true;
            report.inferenceDispatched = true;
            report.usage = await journal.usage(String(id));
            report.credits = await journal.credits(String(id));
        } else {
            assert.equal(source.binding.memberId, user.id);
            report.inferenceDispatched = "unknown-until-provider-evidence";
            save();
            const receipt = await app.kernel!.submit(
                id,
                user,
                requestId,
                "Use the file path and marker from the previous conversation turn. Call the native read tool to read that exact file. Do not use bash or other tools, read credentials, or modify files. Confirm its exact marker in one short sentence.",
            );

            report.receipt = receipt;
            report.authAdmissions = admissions;
            save();
            assert.equal(receipt.status, "settled");
            const entries = (await journal.entries(String(id)))
                .filter((row) => row.attemptId === receipt.id)
                .map((row) => row.entry);
            const messages = entries
                .filter((e) => e.type === "message")
                .map(
                    (e) =>
                        e.message as {
                            role: string;
                            toolName?: string;
                            isError?: boolean;
                            stopReason?: string;
                            content?: {
                                type: string;
                                text?: string;
                                name?: string;
                                arguments?: { path?: string };
                            }[];
                        },
                );
            const toolCalls = messages
                .flatMap((m) => m.content ?? [])
                .filter((c) => c.type === "toolCall");

            assert.ok(toolCalls.length > 0);

            for (const tool of toolCalls) {
                assert.equal(tool.name, "read");
                assert.equal(
                    resolve(source.binding.workspace, tool.arguments!.path!),
                    base.artifact,
                );
            }

            assert.ok(
                messages.some(
                    (m) => m.role === "toolResult" && m.toolName === "read" && !m.isError,
                ),
            );
            const answer = messages.filter((m) => m.role === "assistant").at(-1)!;

            assert.equal(answer.stopReason, "stop");
            assert.ok(
                answer.content!.some(
                    (c) => c.type === "text" && c.text!.includes(base.expectedContent.trim()),
                ),
            );
            assert.equal(readFileSync(base.artifact, "utf8"), base.expectedContent);
            const nativeFile = (await journal.session(String(id))).sessionFile!;
            const serialized = readFileSync(nativeFile, "utf8");

            for (const value of [...before, ...members.map((member) => credential(member))]) {
                assert.equal(serialized.includes(value.access), false);
                assert.equal(serialized.includes(value.refresh), false);
            }

            assert.equal(
                readFileSync(join(source.binding.home, ".pi/agent/auth.json"), "utf8").trim(),
                "{}",
            );
            report.inferenceDispatched = true;

            if (forked) {
                assert.equal(
                    createHash("sha256").update(readFileSync(forked.sourceFile)).digest("hex"),
                    forked.sourceFileDigest,
                );
                assert.equal(
                    createHash("sha256")
                        .update(JSON.stringify(await journal.usage(String(base.conversationId))))
                        .digest("hex"),
                    forked.sourceUsageDigest,
                );
                assert.ok(
                    (await journal.usage(String(id))).every(
                        (row) => row.memberId === user.id && row.attemptId === receipt.id,
                    ),
                );
                report.realChatGPTForkReadAndContext = true;
                report.sourceUnchangedAfterForkContinuation = true;
            } else {
                report.realQoderNativeReadAndContext = true;
            }

            report.sourceArtifactUnchanged = true;
            report.noCredentialInNativeTranscript = true;
            report.childAuthStoreEmpty = true;
            report.nativeFile = nativeFile;
            report.usage = await journal.usage(String(id));
            report.credits = await journal.credits(String(id));
        }
    }

    report.credentials = members.map((member, index) => {
        const after = credential(member);

        return {
            provider: member.provider,
            accessExpiredBefore: before[index].expires <= Date.now(),
            futureExpiry: after.expires > Date.now(),
            accessChanged: after.access !== before[index].access,
            refreshRotated: after.refresh !== before[index].refresh,
            oldRefreshAttemptRecorded: attempted(member, before[index].refresh),
            currentRefreshAttempted: attempted(member, after.refresh),
        };
    });
    const observations = report.credentials as {
        futureExpiry: boolean;
        currentRefreshAttempted: boolean;
    }[];

    assert.ok(observations.every((row) => row.futureExpiry && !row.currentRefreshAttempted));
    report.status = "passed";
    save();
} catch (error) {
    report.status = "not-verified";
    report.errorType = error instanceof Error ? error.name : "unknown";
    save();
    process.exitCode = 1;
} finally {
    await app?.close();
    report.closed =
        !existsSync(join(data, "harness.lock")) && !existsSync(join(data, "kernel.lock"));
    save();
}

console.log(
    JSON.stringify({
        status: report.status,
        report: reportPath,
        inferenceDispatched: report.inferenceDispatched,
    }),
);
