/** Opt-in independent Qoder refresh + cross-provider tool read. Never import another runtime's grant or replay unknown calls. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
    existsSync,
    readFileSync,
    realpathSync,
    readdirSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
const argument = process.argv[2];

if (!argument || process.argv[4] !== "--force-isolated-expiry") {
    throw new Error(
        "Usage: node test/real-qoder.ts /independent/data /original/auth.json --force-isolated-expiry. Uses real quota; forces only this fixture's local expiry.",
    );
}

process.umask(0o077);
const data = realpathSync(argument),
    original = resolve(process.argv[3]!);
const reportFile = join(data, "qoder-real-report.json");
const resume = process.argv[5] === "--resume-undispatched-refresh";
const previous = resume ? JSON.parse(readFileSync(reportFile, "utf8")) : undefined;

if (resume) {
    assert.equal(previous.status, "not-verified");
    assert.equal(previous.receipt, undefined);
} else {
    assert.equal(
        existsSync(reportFile),
        false,
        "Existing intent/receipt must be reconciled, not replayed.",
    );
}

process.env.PI_CODING_AGENT_DIR = join(data, "agent");
process.env.PI_POCKET_GUARD = "off";
const hash = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const originalBefore = hash(readFileSync(original));
const config = JSON.parse(readFileSync(join(data, "config.json"), "utf8"));
const bob = config.users.find((user: { name: string }) => user.name === "Bob · independent Qoder");

assert.ok(bob);
const folder = join(data, "people", bob.id),
    authFile = join(folder, "auth.json");

assert.notEqual(realpathSync(authFile), realpathSync(original));

if (resume) {
    const attempts = join(folder, "qoder-refresh-attempts");

    assert.equal(
        existsSync(attempts) ? readdirSync(attempts).length : 0,
        0,
        "An attempted refresh cannot be resumed as undispatched.",
    );
    assert.deepEqual(previous.refresh, {
        futureExpiry: false,
        accessChanged: false,
        refreshRotated: false,
        bindingPreserved: true,
    });
}

const auth = JSON.parse(readFileSync(authFile, "utf8")),
    initial = auth.qoder;

if (resume) {
    assert.equal(initial.expires, 0);
}

assert.equal(initial.type, "oauth");
assert.equal(initial.rotomTeamReadOnlyImport, undefined);

if (!resume) {
    assert.ok(initial.expires > Date.now());
}

const report: Record<string, unknown> = {
    status: "refresh-intent",
    forcedLocalExpiry: true,
    naturalExpiryNotTested: true,
    ...(previous ? { priorUndispatchedRefresh: previous } : {}),
    memberId: bob.id,
    requestId: randomUUID(),
    metering: [],
};
const save = () => writeFileSync(reportFile, JSON.stringify(report, null, 2), { mode: 0o600 });

writeFileSync(reportFile, JSON.stringify(report), { mode: 0o600, flag: resume ? "w" : "wx" });
const { takeLock } = await import("../src/server/lock.ts");
const lock = join(data, "harness.lock");

takeLock(lock);

try {
    // Only local expiry of a newly issued independent grant changes. Do not restore old tokens after an unknown refresh.
    auth.qoder = { ...initial, expires: 0 };
    const temporary = `${authFile}.${randomUUID()}.tmp`;

    writeFileSync(temporary, JSON.stringify(auth), { mode: 0o600, flag: "wx" });
    renameSync(temporary, authFile);
} finally {
    rmSync(lock);
}

const ai = await import("@earendil-works/pi-ai");
const { clampMaxTokensToContext } = await import("@earendil-works/pi-ai/api/simple-options");
const { createQoderProvider } = await import("../vendor/qoder/provider.mjs");
const { createRefreshGuard } = await import("../vendor/qoder/refresh-guard.mjs");
let runtime!: import("../src/server/team-accounts.ts").Runtime;
const provider = await createQoderProvider({
    piAI: ai,
    clampMaxTokens: clampMaxTokensToContext,
    authMode: "browser",
    oauthOptions: { claimRefresh: createRefreshGuard(folder) },
    refreshCatalog: ({ signal }: { signal: AbortSignal }) =>
        runtime.refresh({ providers: ["qoder"], signal }),
    captureMetering:
        () =>
        (value: { status: string; outcome: string; credits?: number; billable?: boolean }) => {
            (report.metering as unknown[]).push({
                status: value.status,
                outcome: value.outcome,
                credits: value.credits,
                billable: value.billable,
            });
            save();
        },
});
const { PocketApp } = await import("../src/server/app.ts");
const context = BACKGROUND_CONTEXT;
const app = await PocketApp.open({
    dataDir: data,
    defaultCwd: join(data, "workspace"),
    supervised: false,
    browser: null,
    log: () => {},
    configureUserModels(models, user) {
        if (user.id === bob.id) {
            runtime = models;
            models.registerNativeProvider(provider);
        }
    },
});

try {
    const user = app.config.userById(bob.id)!;

    await app.hello(user);
    // Catalog/auth configuration checks do not necessarily resolve a token. Trigger the guarded resolution explicitly.
    await runtime.getAuth("qoder");
    const refreshed = JSON.parse(readFileSync(authFile, "utf8")).qoder;

    report.refresh = {
        futureExpiry: refreshed.expires > Date.now(),
        accessChanged: refreshed.access !== initial.access,
        refreshRotated: refreshed.refresh !== initial.refresh,
        bindingPreserved: refreshed.fingerprint === initial.fingerprint,
    };
    save();
    assert.ok(refreshed.expires > Date.now());
    assert.notEqual(refreshed.refresh, initial.refresh);
    assert.equal(refreshed.fingerprint, initial.fingerprint);
    const selected = app.accounts
        .available(user)
        .find((model) => model.provider.endsWith(":qoder") && model.id === "performance");

    assert.ok(selected);
    app.accounts.choose(user, {
        provider: selected.provider,
        modelId: selected.id,
        thinkingLevel: "medium",
    });

    const quota = async () => {
        const resolved = await runtime.getAuth("qoder");
        const api = provider as typeof provider & {
            getQuotaUsage(options: {
                apiKey?: string;
                expectedFingerprint: string;
                signal: AbortSignal;
            }): Promise<unknown>;
        };

        try {
            return {
                status: "reported",
                snapshot: await api.getQuotaUsage({
                    apiKey: resolved?.auth.apiKey,
                    expectedFingerprint: refreshed.fingerprint,
                    signal: AbortSignal.timeout(15_000),
                }),
            };
        } catch {
            return { status: "unknown" };
        }
    };

    report.quotaBefore = await quota();
    save();
    const source = JSON.parse(readFileSync(join(data, "direct-report.json"), "utf8"));

    assert.equal(source.status, "passed");
    const id = Number(source.conversationId) as import("@earendil-works/pi-durable").ConversationId;

    report.conversationId = Number(id);
    report.status = "dispatch-intent";
    save();
    const receipt = await app.commands.submit(id, user, {
        requestId: String(report.requestId),
        text: "Use read to read direct-proof.txt in this workspace. If its contents are TEAM_OK, reply exactly INDEPENDENT_QODER_OK. Do not change files or access other paths.",
    });

    report.receipt = receipt;
    report.status = "admitted";
    save();
    const outcome = await (await app.harness.submission(receipt.submissionId, context))!.wait(
        context,
    );

    report.outcome = { status: outcome.status, entry: Number(outcome.entry) };
    save();
    assert.equal(outcome.status, "done");
    const page = await (await app.conversation(id)).entries({}, 100, undefined, context);
    const transcript = page.items
        .filter((entry) => Number(entry.id) > Number(outcome.entry))
        .flatMap((entry) => entry.model ?? []);
    const final = transcript.find(
        (message) => message.role === "assistant" && message.stopReason === "stop",
    );

    assert.ok(final?.role === "assistant");
    const toolVerified = transcript.some(
        (message) =>
            message.role === "toolResult" &&
            !message.isError &&
            message.content.some(
                (block) => block.type === "text" && block.text.includes("TEAM_OK"),
            ),
    );
    const markerVerified = final.content.some(
        (block) => block.type === "text" && block.text.includes("INDEPENDENT_QODER_OK"),
    );

    report.response = {
        provider: final.provider,
        model: final.model,
        stopReason: final.stopReason,
        tokens: final.usage.totalTokens,
        toolVerified,
        markerVerified,
    };
    save();
    assert.ok(toolVerified && markerVerified);
    assert.match(final.provider, new RegExp(`^team:${user.id}:.*:qoder$`));
    report.quotaAfter = await quota();
    report.status = "passed";
} catch (error) {
    report.status = "not-verified";
    report.errorType = error instanceof Error ? error.name : "unknown";
    process.exitCode = 1;
} finally {
    await app.close();
    report.originalAuthUnchanged = hash(readFileSync(original)) === originalBefore;
    save();
    console.log(
        JSON.stringify({
            status: report.status,
            refresh: report.refresh,
            response: report.response,
            metering: report.metering,
            originalAuthUnchanged: report.originalAuthUnchanged,
            evidence: reportFile,
        }),
    );
}

process.exit(process.exitCode ?? 0);
