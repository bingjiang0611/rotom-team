/** Opt-in real collaboration recording, using isolated browser-test instances, never the user's desktop. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
const input = process.argv[2];

if (!input) {
    throw new Error(
        "Explicit prepared real-account validation data directory required. This makes billable model requests.",
    );
}

const data = resolve(input);
const previous = JSON.parse(readFileSync(join(data, "report.json"), "utf8"));

assert.equal(previous.status, "passed", "Use a verified two-account fixture.");
const resume = process.argv[3] === "--resume";
const priorOutput = join(data, "collaboration-recording");
const prior = resume
    ? JSON.parse(readFileSync(join(priorOutput, "verification.json"), "utf8"))
    : undefined;
const output = join(
    data,
    process.argv[4] ?? (resume ? "collaboration-recording-resumed" : "collaboration-recording"),
);

assert.equal(
    existsSync(output),
    false,
    "Do not replay an existing recording run; inspect its receipts.",
);
mkdirSync(output, { mode: 0o700 });
process.env.PI_CODING_AGENT_DIR = join(data, "agent");
process.env.PI_POCKET_GUARD = "off";
const { PocketApp } = await import("../src/server/app.ts");
const { Browsers } = await import("../src/server/browser.ts");
const { VIEWPORTS } = await import("../src/server/browser/viewport.ts");
const { createHandler } = await import("../src/server/http.ts");
const app = await PocketApp.open({
    dataDir: data,
    defaultCwd: join(data, "workspace"),
    supervised: false,
    browser: null,
    log: () => {},
});
const context = BACKGROUND_CONTEXT;
const alice = app.config.users.find((user) => user.name === "Alice · ChatGPT")!;
const sourceBob = app.config.users.find((user) => user.name === "Bob · Qoder")!;
const bob = resume
    ? app.config.users.find((user) => user.name === "Bob · Qoder (recording)")!
    : app.config.addUser("Bob · Qoder (recording)", "guest").user;
const device = app.config.addDevice(bob.id);

if (!resume) {
    const accountFolder = join(data, "people", bob.id);

    mkdirSync(accountFolder, { recursive: true, mode: 0o700 });
    writeFileSync(
        join(accountFolder, "auth.json"),
        readFileSync(join(data, "people", sourceBob.id, "auth.json")),
        { mode: 0o600, flag: "wx" },
    );
}

await app.hello(bob);
const bobModel = app.accounts.available(bob).find((model) => model.id === "lite")!;

app.accounts.choose(bob, {
    provider: bobModel.provider,
    modelId: bobModel.id,
    thinkingLevel: "off",
});
const actors = [alice, bob];
const managers = actors.map(
    (_, index) =>
        new Browsers({
            dataDir: join(output, `browser-${index}`),
            load: async () => undefined,
            save: () => {},
        }),
);
const server = createServer(
    createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
);

await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const report: { status: string; events: object[]; video?: string; errorType?: string } = {
    status: "running",
    events: [],
};
const save = () =>
    writeFileSync(join(output, "verification.json"), JSON.stringify(report, null, 2), {
        mode: 0o600,
    });

save();
let recording = false;
let capture: Promise<void> | undefined;
let frames = 0;

try {
    const created = resume
        ? {
              id: prior.events.find((event: { conversationId?: number }) => event.conversationId)
                  ?.conversationId as import("@earendil-works/pi-durable").ConversationId,
          }
        : await app.commands.createSession(alice, {
              title: "ChatGPT + Qoder · live collaboration",
          });
    const pages = await Promise.all(managers.map((manager) => manager.open(1)));

    for (let index = 0; index < pages.length; index++) {
        const user = actors[index]!;
        const token = user.id === alice.id ? app.config.ownerToken : device.token;

        await pages[index]!.setViewport(VIEWPORTS.desktop!);
        await pages[index]!.navigate(`${base}/login?token=${encodeURIComponent(token)}`);
        await pages[index]!.navigate(`${base}/s/${created.id}`);
        await pages[index]!.waitFor({ selector: "textarea[placeholder^='Message Pi']" });
        // Only start recording after service authentication. Model credentials never enter browser DOM.
    }

    recording = true;
    capture = (async () => {
        while (recording) {
            for (let index = 0; index < pages.length; index++) {
                const shot = await pages[index]!.screenshot();

                writeFileSync(
                    join(output, `${index}-${String(frames).padStart(5, "0")}.jpg`),
                    Buffer.from(shot.data, "base64"),
                    { mode: 0o600 },
                );
            }

            frames++;
            await delay(500);
        }
    })();

    const send = async (index: number, text: string) => {
        const page = pages[index]!;
        const before = await (
            await app.conversation(created.id)
        ).entries({}, 100, undefined, context);
        const maxId = Math.max(0, ...before.items.map((entry) => Number(entry.id)));

        report.events.push({
            type: "input-intent",
            member: actors[index]!.name,
            conversationId: Number(created.id),
            text,
        });
        save();
        await page.type({ selector: "textarea[placeholder^='Message Pi']" }, text, {
            submit: true,
        });
        const deadline = Date.now() + 180_000;
        let answer;

        do {
            const entries = await (
                await app.conversation(created.id)
            ).entries({}, 100, undefined, context);

            answer = entries.items.find(
                (entry) =>
                    entry.kind === "pi.assistant" &&
                    Number(entry.id) > maxId &&
                    entry.model?.some(
                        (message) =>
                            message.role === "assistant" &&
                            message.stopReason !== "toolUse" &&
                            message.stopReason !== "pending",
                    ),
            );

            if (answer && !app.isBusy(created.id)) {
                break;
            }

            await delay(200);
        } while (Date.now() < deadline);

        assert.ok(
            answer,
            "No verified assistant response; inspect durable receipts, never blindly resubmit.",
        );
        const response = answer.model!.find((message) => message.role === "assistant")!;

        report.events.push({
            type: "response",
            member: actors[index]!.name,
            entryId: Number(answer.id),
            provider: response.provider,
            model: response.model,
            stopReason: response.stopReason,
            tokens: response.usage.totalTokens,
        });
        save();
        assert.equal(response.stopReason, "stop");
        assert.match(response.provider, index === 0 ? /:openai-codex$/ : /:qoder$/);
        await app.harness.waitForIdle(context);
        await delay(1000);

        return answer;
    };

    let answer;

    if (resume) {
        // Resume the same admitted execution, never retype the successful plan or unknown file write.
        const deadline = Date.now() + 180_000;

        while (app.isBusy(created.id) && Date.now() < deadline) {
            await delay(200);
        }

        assert.equal(app.isBusy(created.id), false, "Existing admitted run has not settled.");
        const page = await (
            await app.conversation(created.id)
        ).entries({}, 100, undefined, context);

        answer = page.items.find(
            (entry) =>
                entry.kind === "pi.assistant" &&
                entry.model?.some(
                    (message) =>
                        message.role === "assistant" &&
                        message.stopReason === "stop" &&
                        message.provider.endsWith(":qoder"),
                ),
        );
        assert.ok(answer, "Reconcile the original outcome; do not replay the tool write.");
        report.events.push({
            type: "read-only-recovery",
            conversationId: Number(created.id),
            originalEvents: prior.events,
            finalEntryId: Number(answer.id),
        });
        save();
    } else {
        await send(
            0,
            "We are testing collaboration only inside this workspace. Reply with a concise two-step plan to create collaboration-proof.txt containing TEAM_OK. Do not call tools yet.",
        );
        answer = await send(
            1,
            "Continue the teammate's plan. Use your file tool to write collaboration-proof.txt in this workspace containing exactly TEAM_OK followed by a newline. Do not access other paths. Finish by replying IMPLEMENTED.",
        );
    }

    const proof = readFileSync(join(data, "workspace", "collaboration-proof.txt"), "utf8");

    assert.match(proof, /^TEAM_OK\n?$/);
    report.events.push({
        type: "file-readback",
        markerVerified: true,
        requestedNewlinePresent: proof.endsWith("\n"),
    });
    save();

    if (resume) {
        answer = await send(
            1,
            "Read collaboration-proof.txt inside this workspace with your read tool. Verify it contains TEAM_OK. Do not modify any file. Briefly report the verified marker.",
        );
    }

    const fork = await app.commands.fork(created.id, alice, { entryId: Number(answer.id) });

    await pages[0]!.navigate(`${base}/s/${fork.id}`);
    report.events.push({
        type: "fork",
        member: alice.name,
        source: Number(created.id),
        fork: Number(fork.id),
        model: (await app.agentState(fork.id))?.model,
        configuration: app.profiles.snapshot(fork.id)?.digest,
    });
    save();
    assert.match((await app.agentState(fork.id))!.model!.provider, /:openai-codex$/);
    assert.equal(app.profiles.snapshot(fork.id)!.digest, app.profiles.snapshot(created.id)!.digest);
    await delay(2000);
    await pages[0]!.evaluate(
        `const { openSheet } = await import('/store.js'); openSheet({type:'profile'}); return 'opened';`,
    );
    await pages[0]!.waitFor({ text: "Configuration & skills" });
    await delay(2000);
    report.status = "passed";
} catch (error) {
    report.status = "not-verified";
    report.errorType = error instanceof Error ? error.name : "unknown";
    writeFileSync(
        join(output, "failure.txt"),
        error instanceof Error ? (error.stack ?? error.message) : String(error),
        { mode: 0o600 },
    );
    process.exitCode = 1;
} finally {
    recording = false;

    try {
        await capture;
    } catch {
        report.status = "not-verified";
        process.exitCode = 1;
    }

    for (const manager of managers) {
        await manager.closeAll({ final: true });
    }

    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await app.close();

    if (frames > 0) {
        try {
            const video = join(output, "collaboration.mp4");

            execFileSync(
                "/opt/homebrew/bin/ffmpeg",
                [
                    "-nostdin",
                    "-loglevel",
                    "error",
                    "-framerate",
                    "2",
                    "-i",
                    join(output, "0-%05d.jpg"),
                    "-framerate",
                    "2",
                    "-i",
                    join(output, "1-%05d.jpg"),
                    "-filter_complex",
                    "hstack=inputs=2",
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    "-movflags",
                    "+faststart",
                    video,
                ],
                { timeout: 120_000, stdio: "pipe" },
            );
            report.video = video;
        } catch {
            report.status = "not-verified";
            process.exitCode = 1;
        }
    }

    save();
    console.log(
        JSON.stringify({
            status: report.status,
            frames,
            evidence: join(output, "verification.json"),
            video: report.video,
        }),
    );
}

process.exit(process.exitCode ?? 0);
