import assert from "node:assert/strict";
import { test } from "node:test";
import { fork, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { RotomJournal, type KernelBinding } from "../src/server/rotom-journal.ts";
import { inspectNative, backup } from "../scripts/data.mjs";

function fixture() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "native-recovery-")));
    const data = join(root, "data"),
        home = join(data, "kernel-homes", "alice"),
        workspace = join(root, "workspace");

    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(workspace, { mode: 0o700 });
    const binding: KernelBinding = {
        memberId: "alice",
        kernelVersion: "0.1.14",
        accountGeneration: "fixture-grant",
        provider: "fixture",
        model: "fixture-model",
        configurationDigest: "fixture-snapshot",
        home,
        workspace,
    };

    return { root, data, binding };
}

function exists(pid: number): boolean {
    try {
        process.kill(pid, 0);

        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
            return false;
        }

        throw error;
    }
}

test("native inspection does not release leases, migrate or resolve attempts, or disclose binding/prompt contents", () => {
    const f = fixture();
    const journal = new RotomJournal(f.data);

    try {
        journal.bind("conversation", f.binding);
        const receipt = journal.reserve(
            "conversation",
            "request",
            "private-prompt-never-output",
            "command",
        );
        const lease = readFileSync(join(f.data, "kernel.lock"));
        const result = inspectNative(f.data);

        assert.equal(result.leasePresent, true);
        assert.equal(result.leaseOwnerPid, process.pid);
        assert.equal(result.pendingTotal, 1);
        assert.equal(result.truncated, false);
        assert.equal(result.toolClosure, "unknown");
        assert.equal(result.replayPermitted, false);
        assert.equal(result.pending![0]!.attemptId, receipt.id);
        assert.equal(result.pending![0]!.recordedStatus, "dispatch-intent");
        assert.equal(result.pending![0]!.operation, "command");
        const cli = spawnSync(
            process.execPath,
            [
                fileURLToPath(new URL("../scripts/data.mjs", import.meta.url)),
                "inspect-native",
                f.data,
            ],
            { encoding: "utf8", timeout: 5000 },
        );

        assert.equal(cli.status, 0, cli.stderr);
        assert.deepEqual(JSON.parse(cli.stdout), result);
        assert.equal(journal.receipt(receipt.id).status, "dispatch-intent");
        assert.deepEqual(readFileSync(join(f.data, "kernel.lock")), lease);

        for (const value of [
            "private-prompt-never-output",
            f.binding.accountGeneration,
            f.binding.home,
            f.binding.workspace,
        ]) {
            assert.ok(!JSON.stringify(result).includes(value));
        }

        assert.throws(() => backup(f.data, join(f.root, "backup")), /Kernel writer lease/);
        journal.close();
        symlinkSync(join(f.data, "kernel.sqlite"), join(f.data, "kernel.lock"));
        assert.throws(() => inspectNative(f.data), /non-regular/);
        rmSync(join(f.data, "kernel.lock"));
        symlinkSync(join(f.root, "missing"), join(f.data, "kernel.lock"));
        assert.throws(() => inspectNative(f.data), /non-regular/);
    } finally {
        journal.close();
        rmSync(f.root, { recursive: true, force: true });
    }
});

test("native inspection is bounded and does not migrate historical schema or change unknown outcomes", () => {
    const f = fixture();
    const db = new DatabaseSync(join(f.data, "kernel.sqlite"));

    try {
        db.exec(
            "PRAGMA user_version=1; CREATE TABLE kernel_sessions(id TEXT PRIMARY KEY, session_file TEXT); CREATE TABLE kernel_attempts(id TEXT PRIMARY KEY, session_id TEXT, request_id TEXT, binding TEXT, status TEXT);",
        );
        const insertSession = db.prepare("INSERT INTO kernel_sessions VALUES (?,NULL)");
        const insert = db.prepare("INSERT INTO kernel_attempts VALUES (?,?,?,?,?)");

        for (let i = 0; i < 101; i++) {
            const memberId = `member-${i}`;

            insertSession.run(`legacy-${i}`);
            insert.run(
                String(i),
                `legacy-${i}`,
                `request-${i}`,
                JSON.stringify({
                    ...f.binding,
                    memberId,
                    home: join(f.data, "kernel-homes", memberId),
                }),
                "unknown",
            );
        }

        const before = readFileSync(join(f.data, "kernel.sqlite"));
        const result = inspectNative(f.data);

        assert.equal(result.version, 1);
        assert.equal(result.pendingTotal, 101);
        assert.equal(result.pending!.length, 100);
        assert.equal(result.truncated, true);
        assert.ok(
            result.pending!.every(
                (row) =>
                    row.recordedStatus === "unknown" &&
                    row.conversationId.startsWith("legacy-") &&
                    row.operation === "prompt",
            ),
        );
        assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 1);
        assert.deepEqual(readFileSync(join(f.data, "kernel.sqlite")), before);
    } finally {
        db.close();
        rmSync(f.root, { recursive: true, force: true });
    }
});

test(
    "real parent crash leaves a live descendant: inspection and backup never treat parent death as tool closure",
    { timeout: 20000 },
    async () => {
        const f = fixture();
        const parent = fork(
            new URL("./fixtures/kernel-crash.ts", import.meta.url),
            [JSON.stringify(f)],
            { stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: [] },
        );
        let toolPid: number | undefined;
        let parentExited = false;

        parent.once("exit", () => {
            parentExited = true;
        });
        let diagnostic = "";

        parent.stderr!.on("data", (chunk) => {
            diagnostic = (diagnostic + String(chunk)).slice(-4096);
        });

        try {
            const [message] = await Promise.race([
                once(parent, "message"),
                once(parent, "exit").then(() => {
                    throw new Error(`Fixture exited before ready: ${diagnostic}`);
                }),
            ]);

            toolPid = message.toolPid;
            assert.ok(toolPid && Number.isSafeInteger(toolPid));
            const exited = once(parent, "exit");

            assert.equal(parent.kill("SIGKILL"), true);
            await exited;
            assert.equal(exists(toolPid), true, "the controlled descendant must still be alive");
            const lease = readFileSync(join(f.data, "kernel.lock"));
            const result = inspectNative(f.data);

            assert.equal(result.leaseOwnerPid, parent.pid);
            assert.equal(result.toolClosure, "unknown");
            assert.equal(result.pending![0]!.attemptId, message.attemptId);
            assert.equal(result.pending![0]!.recordedStatus, "dispatch-intent");
            assert.equal(result.pending![0]!.operation, "prompt");
            assert.throws(() => new RotomJournal(f.data), /EEXIST/);
            assert.throws(() => backup(f.data, join(f.root, "backup")), /Kernel writer lease/);
            assert.deepEqual(readFileSync(join(f.data, "kernel.lock")), lease);
        } finally {
            if (!parentExited) {
                const exited = once(parent, "exit");

                parent.kill("SIGKILL");
                await exited;
            }

            // Only this controlled fixture's reported, deliberately live descendant is terminated. No production lease is cleared.
            if (toolPid && exists(toolPid)) {
                process.kill(toolPid, "SIGTERM");
                const deadline = Date.now() + 5000;

                while (exists(toolPid) && Date.now() < deadline) {
                    await delay(25);
                }

                assert.equal(
                    exists(toolPid),
                    false,
                    "fixture descendant cleanup must be confirmed",
                );
            }

            rmSync(f.root, { recursive: true, force: true });
        }
    },
);
