/** Opt-in real account smoke. Imports access-only copies; never refreshes or writes the original rotom login. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

const source = process.argv[2];

if (!source) {
    throw new Error(
        "Explicit source auth.json path required. This script makes real, billable provider requests.",
    );
}

const before = readFileSync(resolve(source));
const credentials = JSON.parse(before.toString("utf8"));
const chatProvider = credentials["openai-codex"] ? "openai-codex" : "openai";
const codex = credentials[chatProvider];
const qoder = credentials.qoder;

for (const credential of [codex, qoder]) {
    if (credential?.type !== "oauth" || credential.expires <= Date.now() + 5 * 60_000) {
        throw new Error(
            "Source access token is missing or too close to expiration. Sign in independently; do not refresh a copy.",
        );
    }
}

const directory = join(homedir(), "Library", "Application Support", "rotom-team-validation");

mkdirSync(directory, { recursive: true, mode: 0o700 });
const resume = process.argv[3];
const data = resume ? resolve(resume) : mkdtempSync(join(directory, "real-"));

process.env.PI_CODING_AGENT_DIR = join(data, "agent");
process.env.PI_POCKET_GUARD = "off";
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true, mode: 0o700 });
const { ConfigStore } = await import("../src/server/config.ts");
const config = new ConfigStore(data);
const alice = config.users.find((user) => user.role === "owner")!;

config.updateUser(alice.id, { name: "Alice · ChatGPT" });
const bob = resume
    ? config.users.find((user) => user.name === "Bob · Qoder")!
    : config.addUser("Bob · Qoder", "guest").user;

for (const [user, provider, credential] of (resume
    ? []
    : [
          [alice, chatProvider, codex],
          [bob, "qoder", qoder],
      ]) as [typeof alice, string, object][]) {
    const folder = join(data, "people", user.id);

    mkdirSync(folder, { recursive: true, mode: 0o700 });
    writeFileSync(
        join(folder, "auth.json"),
        JSON.stringify({ [provider]: { ...credential, rotomTeamReadOnlyImport: true } }),
        { mode: 0o600, flag: "wx" },
    );
}

const workspace = join(data, "workspace");

mkdirSync(workspace, { recursive: true, mode: 0o700 });
const { PocketApp } = await import("../src/server/app.ts");
const app = await PocketApp.open({
    dataDir: data,
    defaultCwd: workspace,
    supervised: false,
    browser: null,
    log: () => {},
});
const context = BACKGROUND_CONTEXT;
const report: {
    data: string;
    status: string;
    calls: Record<string, unknown>[];
    originalAuthUnchanged?: boolean;
} = resume
    ? JSON.parse(readFileSync(join(data, "report.json"), "utf8"))
    : { data, status: "running", calls: [] };
const reportFile = join(data, "report.json");
const save = () => writeFileSync(reportFile, JSON.stringify(report, null, 2), { mode: 0o600 });

save();

try {
    const a = app.config.userById(alice.id)!;
    const b = app.config.userById(bob.id)!;

    await app.hello(b);
    const availableA = app.accounts.available(a);
    const availableB = app.accounts.available(b);
    const modelA = availableA.find((model) => model.id === "gpt-6.1-sol");
    const modelB = availableB.find((model) => model.id === "lite");

    assert.ok(modelA && modelB, "Both personal model catalogs must be available.");

    for (const [user, model] of [
        [a, modelA],
        [b, modelB],
    ] as const) {
        app.accounts.choose(user, {
            provider: model.provider,
            modelId: model.id,
            thinkingLevel: "off",
        });
    }

    const id = resume
        ? (report.calls[0]!.conversationId as import("@earendil-works/pi-durable").ConversationId)
        : (await app.commands.createSession(a, { title: "Real cross-account collaboration smoke" }))
              .id;

    if (resume) {
        const page = await (await app.harness.conversation(id, context))!.entries(
            {},
            100,
            undefined,
            context,
        );

        for (const call of report.calls) {
            const outcome = call.outcome as { entry: number; status: string };

            if (outcome.status !== "done") {
                throw new Error(
                    "An earlier dispatch is not verified. Reconcile its receipt; do not redispatch.",
                );
            }

            const answer = page.items
                .filter(
                    (entry) =>
                        entry.kind === "pi.assistant" && Number(entry.id) > Number(outcome.entry),
                )
                .sort((x, y) => Number(x.id) - Number(y.id))[0];
            const message = answer?.model?.find((message) => message.role === "assistant");

            call.response = message && {
                provider: message.provider,
                model: message.model,
                stopReason: message.stopReason,
                text: message.content
                    .filter((part) => part.type === "text")
                    .map((part) => part.text)
                    .join(""),
                usage: message.usage,
            };
        }

        save();
    }

    for (const [user, prompt] of [
        [a, "Reply exactly CHATGPT_READY. Do not invoke tools."],
        [
            b,
            "Another teammate previously established readiness. Reply exactly QODER_READY. Do not invoke tools.",
        ],
    ] as const) {
        if (
            resume &&
            report.calls.some(
                (call) =>
                    call.member === user.name &&
                    (call.response as { stopReason?: string } | undefined)?.stopReason === "stop",
            )
        ) {
            continue;
        }

        const requestId = crypto.randomUUID();
        const receipt = await app.commands.submit(id, user, { text: prompt, requestId });
        const outcome = await (await app.harness.submission(receipt.submissionId, context))!.wait(
            context,
        );
        const entries = await (await app.harness.conversation(id, context))!.entries(
            {},
            100,
            undefined,
            context,
        );
        const answer = entries.items
            .filter(
                (entry) =>
                    entry.kind === "pi.assistant" && Number(entry.id) > Number(outcome.entry),
            )
            .sort((x, y) => Number(x.id) - Number(y.id))[0];
        const message = answer?.model?.find((message) => message.role === "assistant");

        report.calls.push({
            member: user.name,
            conversationId: Number(id),
            requestId,
            receipt,
            outcome,
            response: message && {
                provider: message.provider,
                model: message.model,
                stopReason: message.stopReason,
                text: message.content
                    .filter((part) => part.type === "text")
                    .map((part) => part.text)
                    .join(""),
                usage: message.usage,
            },
        });
        save();
        assert.equal(
            outcome.status,
            "done",
            "Real provider did not complete; inspect report without retrying unknown dispatch.",
        );
        assert.equal(message?.stopReason, "stop");
        assert.match(
            message!.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join(""),
            user.id === a.id ? /CHATGPT_READY/ : /QODER_READY/,
        );
    }

    for (const call of report.calls) {
        const response = call.response as { provider: string; stopReason: string; text: string };

        assert.equal(response.stopReason, "stop");
        assert.match(
            response.provider,
            call.member === a.name ? /:openai-codex$|:openai$/ : /:qoder$/,
        );
        assert.match(response.text, call.member === a.name ? /CHATGPT_READY/ : /QODER_READY/);
    }

    report.status = "passed";
} catch (error) {
    report.status = "not-verified";
    console.error(
        "Real account smoke did not pass. Details are private in the report; no automatic redispatch.",
    );
    writeFileSync(
        join(data, "failure.txt"),
        error instanceof Error ? (error.stack ?? error.message) : String(error),
        { mode: 0o600 },
    );
    process.exitCode = 1;
} finally {
    await app.close();
    report.originalAuthUnchanged =
        createHash("sha256").update(before).digest("hex") ===
        createHash("sha256")
            .update(readFileSync(resolve(source)))
            .digest("hex");
    save();
    console.log(
        JSON.stringify({
            status: report.status,
            report: reportFile,
            originalAuthUnchanged: report.originalAuthUnchanged,
        }),
    );
}

// Providers may retain idle keep-alive sockets after all durable work has been closed.
process.exit(process.exitCode ?? 0);
