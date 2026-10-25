import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Worker } from "node:worker_threads";
import { mkdtempSync, realpathSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { StorageRejected, createSession, type ConversationId } from "@earendil-works/pi-durable";
import { createStorageConformance } from "@earendil-works/pi-durable/testing";
import { StorageWorker } from "../src/server/storage-worker.ts";
import {
    RotomJournal,
    KernelRequestConflict,
    type KernelBinding,
} from "../src/server/rotom-journal.ts";
import { RotomExecutions } from "../src/server/rotom-executions.ts";
import { takeLock } from "../src/server/lock.ts";
import { STORAGE_QUEUE_LENGTH, STORAGE_PAGE_BYTES } from "../src/server/storage-protocol.ts";

function directory() {
    return realpathSync(mkdtempSync(join(tmpdir(), "storage-worker-test-")));
}

function start(data: string, fault?: string, control?: SharedArrayBuffer, timeout = 5000) {
    const worker = new Worker(new URL("./fixtures/storage-fault-worker.ts", import.meta.url), {
        workerData: { data, fault, control, storageWorker: true },
    });
    const exited = new Promise<number>((resolve) => worker.once("exit", resolve));
    const owner = new StorageWorker(data, worker, timeout);

    return { owner, worker, exited };
}

async function setup(t: TestContext, fault?: string, control?: SharedArrayBuffer) {
    const data = directory();
    const fixture = start(data, fault, control);

    t.after(async () => {
        try {
            await fixture.owner.close();
        } catch (error) {
            if (!fault) {
                throw error;
            }
        } finally {
            // These fixtures own databases only, never native tools. Even a broken close test must not leak its thread.
            if (fixture.worker.threadId !== -1) {
                await fixture.worker.terminate();
            }

            await fixture.exited;
            rmSync(data, { recursive: true, force: true });
        }
    });
    await fixture.owner.ready();

    return { data, ...fixture };
}

function binding(data: string, memberId = "alice"): KernelBinding {
    const home = join(data, "kernel-homes", memberId);
    const workspace = join(data, "workspace");

    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(workspace, { recursive: true });

    return {
        memberId,
        home,
        workspace,
        kernelVersion: "fixture",
        provider: "fixture",
        model: "fixture",
        accountGeneration: "fixture",
        configurationDigest: "fixture",
    };
}

for (const check of createStorageConformance({
    assertions: {
        ok: assert.ok,
        strictEqual: assert.strictEqual,
        deepEqual: assert.deepStrictEqual,
        partialDeepEqual: assert.partialDeepStrictEqual,
        greaterThan: (a, b) => assert.ok(a > b),
        rejects: async (operation, message) => {
            await assert.rejects(operation, (error: Error) => error.message.includes(message));
        },
    },
    withStorage: async (use) => {
        const data = directory();
        const owner = new StorageWorker(data);

        await owner.ready();

        try {
            await use(owner.storage);
        } finally {
            await owner.close();
            rmSync(data, { recursive: true, force: true });
        }
    },
})) {
    test(`worker Storage conformance: ${check.name}`, check.run);
}

test("one worker holds both stores until final ACK and exit; double writers are refused", async (t) => {
    const { owner, data } = await setup(t);
    const j = owner.journal;

    await j.bind("source", binding(data));
    assert.throws(() => new RotomJournal(data), /EEXIST/);
    assert.throws(() => takeLock(join(data, "harness.lock")), /lease/);
    const second = start(data);

    await assert.rejects(second.owner.ready(), /EEXIST/);
    await second.exited;
    await j.close();
    assert.ok(existsSync(join(data, "kernel.lock")));
    assert.ok(await owner.storage.mintId());
    await assert.rejects(j.session("source"), /closed/);
    await owner.storage.close(context);
    assert.ok(existsSync(join(data, "kernel.lock")));
    await owner.close();
    assert.equal(existsSync(join(data, "kernel.lock")), false);
    assert.equal(owner.closed, true);
});

test("worker preserves atomic head/binding conflicts and pages multi-MiB history", async (t) => {
    const { owner, data, worker } = await setup(t);
    const receivedPages: number[] = [];

    worker.on("message", (packet) => {
        if (packet.type === "page") {
            receivedPages.push(packet.bytes.length);
        }
    });
    const j = owner.journal;
    const alice = binding(data);
    const bob = binding(data, "bob");

    await j.bind("source", alice);
    await j.bind("target", bob);
    const initial = await j.reserve("source", "first", "hello");
    const content = "x".repeat(3 * 1024 * 1024);

    await j.attach(initial.id, "source.jsonl", "native-source");
    await j.finish(initial.id, "settled", [
        { type: "message", id: "large", message: { role: "user", content } },
        {
            type: "message",
            id: "answer",
            parentId: "large",
            message: {
                role: "assistant",
                provider: "fixture",
                model: "fixture",
                stopReason: "stop",
                content: [{ type: "text", text: "done" }],
                usage: { totalTokens: 1 },
            },
        },
    ]);
    const capture = await j.forkSeed(
        "target",
        "fork",
        "identity",
        "target",
        { sessionId: "source", expectedHead: "source" },
        bob,
    );

    assert.equal((capture.seed!.entries[0]!.message as { content: string }).content, content);
    const handoff = await j.handoffSeed("source", "handoff", "source", bob);

    await j.finish(handoff.receipt.id, "settled", []);
    await assert.rejects(
        j.reserve("source", "stale", "work", "prompt", undefined, "source", alice),
        KernelRequestConflict,
    );
    assert.equal(await j.request("source", "stale"), undefined);
    assert.ok(receivedPages.filter((size) => size === STORAGE_PAGE_BYTES).length >= 3);
    assert.ok(receivedPages.every((size) => size <= STORAGE_PAGE_BYTES));
});

test("StorageRejected keeps its public identity and does not poison the parent Session", async (t) => {
    const { owner } = await setup(t, "reject-once");
    const session = createSession(owner.storage);

    await assert.rejects(
        session.commit(
            (tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
            context,
        ),
        StorageRejected,
    );
    const record = await session.commit(
        (tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
        context,
    );

    assert.ok(await owner.storage.conversation(record.id, context));
    await session.close(context);
});

test("commit-before-crash poisons Session, fences both stores, and never replays unknown native work", async (t) => {
    const { owner, data, exited } = await setup(t, "crash-after-commit");

    await owner.journal.bind("source", binding(data));
    const intent = await owner.journal.reserve("source", "once", "hello");
    const session = createSession(owner.storage);
    let id: ConversationId | undefined;

    await assert.rejects(
        session.commit(async (tx) => {
            id = (await tx.createConversation({ ownership: { kind: "ownerless" } })).id;
        }, context),
        (error) => !(error instanceof StorageRejected),
    );
    assert.equal(await exited, 41);
    let retried = false;

    await assert.rejects(
        session.commit(() => {
            retried = true;
        }, context),
    );
    assert.equal(retried, false);
    await assert.rejects(owner.journal.hasConversation("source"));
    assert.ok(existsSync(join(data, "kernel.lock")));
    assert.throws(() => takeLock(join(data, "harness.lock")), /lease/);
    await assert.rejects(owner.close());

    // Explicit fixture reconciliation, only after thread exit; this test never launched native processes.
    rmSync(join(data, "kernel.lock"));
    const reopened = new StorageWorker(data);

    await reopened.ready();

    try {
        assert.ok(await reopened.storage.conversation(id!, context));
        assert.equal((await reopened.journal.receipt(intent.id)).status, "unknown");
        const executions = new RotomExecutions(
            data,
            async () => {},
            () => assert.fail("unknown was replayed"),
            reopened.journal,
        );
        const result = await executions.run("source", "once", "hello");

        assert.equal(result.status, "unknown");
        assert.equal((await reopened.journal.receipts("source")).length, 1);
        await executions.close();
    } finally {
        await reopened.close();
    }
});

test("a real late ACK cannot revive a timed-out owner or release its lease", async (t) => {
    const data = directory();
    const worker = new Worker(new URL("./fixtures/storage-fault-worker.ts", import.meta.url), {
        workerData: { data },
    });
    const exited = new Promise<number>((resolve) => worker.once("exit", resolve));
    const on = worker.on.bind(worker);
    let hold = false;
    let release: (() => void) | undefined;
    const captured = Promise.withResolvers<void>();

    t.mock.method(worker, "on", (name: string, listener: (...args: any[]) => void) =>
        on(
            name,
            name !== "message"
                ? listener
                : (packet) => {
                      if (hold && packet.type === "page" && packet.id > 0) {
                          hold = false;
                          release = () => listener(packet);
                          captured.resolve();
                      } else {
                          listener(packet);
                      }
                  },
        ),
    );
    const owner = new StorageWorker(data, worker, 5000);

    try {
        await owner.ready();
        await owner.journal.bind("source", binding(data));
        hold = true;
        const pending = owner.journal.reserve("source", "once", "hello");
        const failed = assert.rejects(pending, /deadline.*unknown/);

        await captured.promise;
        await failed;
        release!();
        await assert.rejects(owner.journal.session("source"), /deadline/);
        await assert.rejects(owner.close(), /deadline/);
        assert.equal(owner.closed, false);
        assert.ok(existsSync(join(data, "kernel.lock")));
    } finally {
        await owner.close().catch(() => {});
        await exited;
        rmSync(data, { recursive: true, force: true });
    }
});

test("blocked worker leaves parent responsive; queued cancellation does not dispatch a write", async (t) => {
    const shared = new SharedArrayBuffer(8);
    const control = new Int32Array(shared);
    const { owner } = await setup(t, undefined, shared);
    const id = (await owner.storage.mintId()) as ConversationId;
    const entered = Atomics.waitAsync(control, 0, 0).value;
    const blocked = owner.journal.hasConversation("hold-worker");

    try {
        await entered;
        await new Promise<void>((resolve) => setImmediate(resolve));
        const controller = new AbortController();
        const queued = owner.storage.commit([{ type: "conversation", value: { id } }], {
            abortSignal: controller.signal,
            value: () => undefined,
            toString: () => "non-cloneable caller context",
        });

        controller.abort();
        await assert.rejects(queued, { name: "AbortError" });
    } finally {
        Atomics.store(control, 1, 1);
        Atomics.notify(control, 1);
        await blocked;
    }

    assert.equal(await owner.storage.conversation(id, context), undefined);
});

test("cancellation after dispatch still waits for the durable commit ACK", async (t) => {
    const shared = new SharedArrayBuffer(8);
    const control = new Int32Array(shared);
    const { owner } = await setup(t, "hold-commit", shared);
    const id = (await owner.storage.mintId()) as ConversationId;
    const controller = new AbortController();
    const entered = Atomics.waitAsync(control, 0, 0).value;
    const committed = owner.storage.commit([{ type: "conversation", value: { id } }], {
        abortSignal: controller.signal,
        value: () => undefined,
        toString: () => "parent-only context",
    });

    try {
        await entered;
        controller.abort();
    } finally {
        Atomics.store(control, 1, 1);
        Atomics.notify(control, 1);
    }

    await committed;
    assert.ok(await owner.storage.conversation(id, context));
});

test("a saturated ordinary queue still admits all three drain/close operations", async (t) => {
    const shared = new SharedArrayBuffer(8);
    const control = new Int32Array(shared);
    const { owner, data } = await setup(t, undefined, shared);
    const entered = Atomics.waitAsync(control, 0, 0).value;
    const blocked = owner.journal.hasConversation("hold-worker");

    await entered;
    const pending = Array.from({ length: STORAGE_QUEUE_LENGTH - 1 }, () =>
        owner.journal.hasConversation("empty"),
    );

    try {
        await assert.rejects(owner.journal.hasConversation("overflow"), /capacity/);
        await assert.rejects(owner.storage.commit([], context), StorageRejected);
        const journalClose = owner.journal.close();
        const storageClose = owner.storage.close(context);
        const closed = owner.close();

        assert.ok(existsSync(join(data, "kernel.lock")));
        Atomics.store(control, 1, 1);
        Atomics.notify(control, 1);
        await Promise.all([blocked, ...pending, journalClose, storageClose, closed]);
        assert.equal(owner.closed, true);
        assert.equal(existsSync(join(data, "kernel.lock")), false);
    } finally {
        Atomics.store(control, 1, 1);
        Atomics.notify(control, 1);
    }
});

test("an acknowledged plain Storage error is not disguised as a proven rollback", async (t) => {
    const { owner } = await setup(t, "error-after-commit");
    const session = createSession(owner.storage);
    let id: ConversationId | undefined;

    await assert.rejects(
        session.commit(async (tx) => {
            id = (await tx.createConversation({ ownership: { kind: "ownerless" } })).id;
        }, context),
        (error) => error instanceof Error && !(error instanceof StorageRejected),
    );
    let retried = false;

    await assert.rejects(
        session.commit(() => {
            retried = true;
        }, context),
    );
    assert.equal(retried, false);
    // The public backend still allows reconciliation reads. Do not upgrade its error to StorageRejected.
    assert.ok(await owner.storage.conversation(id!, context));
    await session.close(context);
});

test("permission revocation while a worker read is outstanding prevents admission", async (t) => {
    const { owner, data } = await setup(t);
    const journal = owner.journal;

    await journal.bind("source", binding(data));
    let allowed = true;
    const session = journal.session.bind(journal);

    t.mock.method(journal, "session", (...args: Parameters<typeof session>) => {
        const pending = session(...args);

        allowed = false;

        return pending;
    });
    const executions = new RotomExecutions(
        data,
        async () => {
            assert.ok(allowed, "membership revoked");
        },
        () => assert.fail("revoked member reached native launch"),
        journal,
    );

    try {
        await assert.rejects(executions.run("source", "denied", "hello"), /membership revoked/);
        assert.equal(await journal.request("source", "denied"), undefined);
    } finally {
        await executions.close();
    }
});

test("a failed database close keeps the writer lease and cannot be retried into success", async (t) => {
    const { owner, data } = await setup(t, "close-error");

    await owner.journal.close();
    await assert.rejects(owner.storage.close(context), /fixture storage close failure/);
    await assert.rejects(owner.close());
    await assert.rejects(owner.close());
    assert.ok(existsSync(join(data, "kernel.lock")));
    assert.equal(owner.closed, false);
});
