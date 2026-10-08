/** Explicit, paid SIWC verification using an independently authenticated private fixture. No automatic replay. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { DatabaseSync } from "node:sqlite";
const argument = process.argv[2];

if (!argument) {
    throw new Error(
        "Explicit independently authenticated data directory required; this invokes the real model.",
    );
}

const data = resolve(argument),
    reportPath = join(data, "direct-report.json");
const repair = process.argv[4] === "--repair-namespace-description";
let previous: Record<string, unknown> | undefined;

if (repair) {
    previous = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(previous!.status, "not-verified");
    const db = new DatabaseSync(join(data, "pocket.sqlite"), { readOnly: true });
    const task = db
        .prepare(
            "select record from tasks where conversation_id=? and kind=? order by id desc limit 1",
        )
        .get(Number(previous!.conversationId), JSON.stringify("pi.generation")) as {
        record: string;
    };

    db.close();
    const state = JSON.parse(task.record).state;

    assert.equal(state.status, "terminal");
    assert.equal(state.outcome.status, "failed");
    assert.match(
        state.outcome.error.message,
        /OpenAI API error \(400\).*Missing required parameter: 'tools\[0\]\.description'/,
    );
} else {
    assert.equal(
        existsSync(reportPath),
        false,
        "Inspect the existing receipt; never blindly repeat an admitted inference.",
    );
}

process.umask(0o077);
process.env.PI_CODING_AGENT_DIR = join(data, "agent");
process.env.PI_POCKET_GUARD = "off";
const original = process.argv[3] ? resolve(process.argv[3]) : undefined;
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const before = original ? digest(original) : undefined;
const { PocketApp } = await import("../src/server/app.ts");
const report: Record<string, unknown> = {
    status: "admission-pending",
    requestId: randomUUID(),
    ...(previous
        ? { priorRejectedAttempt: previous, repair: "namespace-description-after-verified-400" }
        : {}),
};
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });

writeFileSync(reportPath, JSON.stringify(report), { mode: 0o600, flag: repair ? "w" : "wx" });
const app = await PocketApp.open({
    dataDir: data,
    defaultCwd: join(data, "workspace"),
    supervised: false,
    browser: null,
    log: () => {},
});
const context = BACKGROUND_CONTEXT;

try {
    const user = app.config.users.find((user) => user.role === "owner")!;
    const auth = JSON.parse(
        readFileSync(join(data, "people", user.id, "auth.json"), "utf8"),
    ).openai;

    assert.equal(auth.type, "oauth");
    assert.equal(auth.rotomTeamReadOnlyImport, undefined);
    const available = app.accounts.available(user);
    const selected = available.find(
        (model) => model.provider.endsWith(":openai") && model.id === "gpt-6.1-sol",
    );

    assert.ok(
        selected,
        "The selected account-specific model must be available; no static catalog fallback.",
    );
    assert.ok(
        !available.some((model) => model.provider.endsWith(":openai") && model.id === "gpt-4"),
    );
    app.accounts.choose(user, {
        provider: selected.provider,
        modelId: selected.id,
        thinkingLevel: "low",
    });

    if (!repair) {
        writeFileSync(join(data, "workspace", "direct-proof.txt"), "TEAM_OK\n", {
            mode: 0o600,
            flag: "wx",
        });
    } else {
        assert.equal(
            readFileSync(join(data, "workspace", "direct-proof.txt"), "utf8"),
            "TEAM_OK\n",
        );
    }

    report.memberId = user.id;
    report.status = "dispatch-intent";
    save();
    let id: import("@earendil-works/pi-durable").ConversationId, after: number;

    if (repair) {
        // This explicit resend is allowed only after the exact pre-inference HTTP rejection above. Never repair an unknown write by redispatch.
        ({ id } = await app.commands.resend(Number(previous!.conversationId) as typeof id, user, {
            entryId: Number((previous!.outcome as { entry: number }).entry),
        }));
        after = Number((previous!.outcome as { entry: number }).entry);
        report.conversationId = Number(id);
        report.status = "resend-admitted";
        save();
        await app.harness.waitForIdle(context);
    } else {
        ({ id } = await app.commands.createSession(user, {
            title: "Official SIWC · real tool read verification",
        }));
        report.conversationId = Number(id);
        save();
        const receipt = await app.commands.submit(id, user, {
            requestId: String(report.requestId),
            text: "Use the read tool to read direct-proof.txt inside this workspace. If its contents are TEAM_OK, reply exactly FRESH_CHATGPT_OK. Do not modify files or access other paths.",
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
        after = Number(outcome.entry);
    }

    const page = await (await app.conversation(id)).entries({}, 100, undefined, context);
    const transcript = page.items
        .filter((entry) => Number(entry.id) > after)
        .flatMap((entry) => entry.model ?? []);
    const messages = transcript.filter((message) => message.role === "assistant");
    const toolReadVerified = transcript.some(
        (message) =>
            message.role === "toolResult" &&
            !message.isError &&
            message.content.some(
                (block) => block.type === "text" && block.text.includes("TEAM_OK"),
            ),
    );
    const final = messages.find((message) => message.stopReason === "stop");
    const tools = messages.flatMap((message) =>
        message.content.filter((block) => block.type === "toolCall"),
    );

    assert.ok(final);
    assert.ok(
        tools.length > 0,
        "Need an actual tool call, not an answer inferred from the prompt.",
    );
    const markerVerified = final.content.some(
        (block) => block.type === "text" && block.text.includes("FRESH_CHATGPT_OK"),
    );

    report.response = {
        provider: final.provider,
        model: final.model,
        stopReason: final.stopReason,
        markerVerified,
        toolReadVerified,
        tokens: final.usage.totalTokens,
        tools: tools.map((tool) => tool.name),
    };
    save();
    assert.equal(markerVerified, true);
    assert.equal(toolReadVerified, true);
    assert.equal(readFileSync(join(data, "workspace", "direct-proof.txt"), "utf8"), "TEAM_OK\n");
    report.status = "passed";
} catch (error) {
    report.status = "not-verified";
    report.errorType = error instanceof Error ? error.name : "unknown";
    process.exitCode = 1;
} finally {
    await app.close();

    if (original) {
        report.originalAuthUnchanged = digest(original) === before;
    }

    save();
    console.log(
        JSON.stringify({
            status: report.status,
            outcome: report.outcome,
            response: report.response,
            originalAuthUnchanged: report.originalAuthUnchanged,
            evidence: reportPath,
        }),
    );
}

process.exit(process.exitCode ?? 0);
