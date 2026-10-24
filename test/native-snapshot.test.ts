import assert from "node:assert/strict";
import { test } from "node:test";
import {
    mkdtempSync,
    realpathSync,
    writeFileSync,
    rmSync,
    existsSync,
    appendFileSync,
    renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentBranchGoalState } from "../src/server/rotom-executions.ts";
import { readNativeSnapshot, NativeTail } from "../src/server/rotom-executions/native-tail.ts";
import { RotomRpc, RpcFailure } from "../src/server/rotom-rpc.ts";
import type { KernelEntry } from "../src/server/rotom-journal.ts";

function fixture() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "native-snapshot-")));
    const state = { sessionFile: join(root, "session.jsonl"), sessionId: "snapshot-session" };
    const header = {
        type: "session",
        version: 3,
        id: state.sessionId,
        cwd: root,
        timestamp: new Date().toISOString(),
    };
    const clients: RotomRpc[] = [];

    const client = (mode: string) => {
        const rpc = new RotomRpc(
            process.execPath,
            [join(import.meta.dirname, "fixtures/native-snapshot.mjs"), state.sessionFile, mode],
            {
                cwd: root,
                env: { PATH: process.env.PATH },
                timeoutMs: 30000,
                recordLimit: 64 * 1024 * 1024,
            },
        );

        clients.push(rpc);

        return rpc;
    };

    return {
        root,
        state,
        header,
        client,
        async close() {
            await Promise.all(clients.map((client) => client.close()));
            rmSync(root, { recursive: true, force: true });
        },
    };
}

test("image-heavy history over 64 MiB uses a native delta and preserves the selected branch", async (t) => {
    const f = fixture();

    t.after(() => f.close());
    writeFileSync(f.state.sessionFile, JSON.stringify(f.header) + "\n");
    const root: KernelEntry = {
        type: "custom",
        id: "root-goal",
        parentId: null,
        timestamp: new Date().toISOString(),
        customType: "goal-state",
        data: { goal: { status: "paused", objective: "selected branch" } },
    };

    appendFileSync(f.state.sessionFile, JSON.stringify(root) + "\n");
    let parentId = "root-goal";

    for (let i = 0; i < 5; i++) {
        const id = `image-${i}`;
        const entry = {
            type: "message",
            id,
            parentId,
            timestamp: new Date().toISOString(),
            message: {
                role: "user",
                content: [
                    { type: "image", mimeType: "image/png", data: "A".repeat(14 * 1024 * 1024) },
                ],
                timestamp: Date.now(),
            },
        };

        appendFileSync(f.state.sessionFile, JSON.stringify(entry) + "\n");
        parentId = id;
    }

    appendFileSync(
        f.state.sessionFile,
        JSON.stringify({
            ...root,
            id: "other-branch",
            parentId,
            data: { goal: { status: "active", objective: "not selected" } },
        }) + "\n",
    );
    // Control: the deployed full readback fails on exactly the same valid history.
    await assert.rejects(
        f.client("branch").request({ type: "get_entries" }),
        (error) =>
            error instanceof RpcFailure &&
            error.outcome === "unknown" &&
            error.message === "RPC record exceeds 64 MiB",
    );
    const result = await readNativeSnapshot(f.client("branch"), f.state, f.root);

    assert.equal(result.entries.length, 7);
    assert.equal(result.leafId, "root-goal");
    assert.deepEqual(currentBranchGoalState(result), {
        goal: { status: "paused", objective: "selected branch" },
    });
    assert.equal(
        (result.entries[1]!.message as { content: { data: string }[] }).content[0]!.data.length,
        14 * 1024 * 1024,
    );
});

test("native snapshot includes unflushed entries, even before a session file exists", async (t) => {
    const f = fixture();

    t.after(() => f.close());
    const result = await readNativeSnapshot(f.client("memory"), f.state, f.root);

    assert.equal(existsSync(f.state.sessionFile), false);
    assert.equal(result.entries.length, 1);
    assert.deepEqual(currentBranchGoalState(result), {
        goal: { status: "active", objective: "unflushed" },
    });
});

test("a partial append uses the last complete native entry as its delta anchor", async (t) => {
    const f = fixture();
    const first = { type: "custom", id: "first", parentId: null };
    const second = { type: "custom", id: "second", parentId: "first" };

    t.after(() => f.close());
    writeFileSync(
        f.state.sessionFile,
        [JSON.stringify(f.header), JSON.stringify(first), JSON.stringify(second).slice(0, 15)].join(
            "\n",
        ),
    );
    const result = await readNativeSnapshot(
        {
            request: async (request) => {
                assert.deepEqual(request, { type: "get_entries", since: "first" });

                return { entries: [second], leafId: "second" };
            },
        },
        f.state,
        f.root,
    );

    assert.deepEqual(result.entries, [first, second]);
});

test("run-owned tail reuses parsed prefix without consuming journal delivery or losing partial/native suffix", async (t) => {
    const f = fixture();
    const first = { type: "custom", id: "first", parentId: null };
    const second = { type: "custom", id: "second", parentId: "first" };
    const third = {
        type: "custom",
        id: "third",
        parentId: "first",
        customType: "goal-state",
        data: { goal: { status: "paused" } },
    };

    t.after(() => f.close());
    writeFileSync(
        f.state.sessionFile,
        [JSON.stringify(f.header), JSON.stringify(first)].join("\n") + "\n",
    );
    const tail = new NativeTail(f.state.sessionFile, f.state.sessionId, f.root);
    const parse = JSON.parse;
    let calls = 0;

    const counted = <T>(read: () => T): T => {
        JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
            calls++;

            return parse(...args);
        }) as typeof JSON.parse;

        try {
            return read();
        } finally {
            JSON.parse = parse;
        }
    };

    assert.deepEqual(
        counted(() => tail.read()),
        [f.header, first],
    );
    assert.equal(calls, 2);
    const secondLine = JSON.stringify(second);

    appendFileSync(f.state.sessionFile, secondLine.slice(0, 15));
    assert.deepEqual(
        counted(() => tail.snapshot()),
        [f.header, first],
    );
    assert.equal(calls, 2, "prefix validation hashes bytes rather than decoding them twice");
    assert.equal(tail.complete, false);
    const snapshot = await readNativeSnapshot(
        {
            request: async (request) => {
                assert.deepEqual(request, { type: "get_entries", since: "first" });

                return { entries: [second, third], leafId: "third" };
            },
        },
        f.state,
        f.root,
        tail,
    );

    assert.deepEqual(snapshot.entries, [first, second, third]);
    assert.deepEqual(currentBranchGoalState(snapshot), { goal: { status: "paused" } });
    appendFileSync(f.state.sessionFile, secondLine.slice(15) + "\n");
    assert.deepEqual(
        counted(() => tail.snapshot()),
        [f.header, first, second],
    );
    assert.equal(calls, 3);
    assert.deepEqual(tail.read(), [second], "snapshot refresh must not swallow journal entries");
    assert.deepEqual(tail.read(), []);
    assert.equal(tail.complete, true);
    assert.throws(() => tail.snapshot(f.state.sessionFile, "foreign", f.root), /identity mismatch/);
});

test("reused tail falls back to full parsing for rewritten/truncated prefixes, preserving fresh errors", async (t) => {
    const f = fixture();
    const entry = { type: "custom", id: "entry", parentId: null };
    const body = [JSON.stringify(f.header), JSON.stringify(entry)].join("\n") + "\n";

    t.after(() => f.close());
    writeFileSync(f.state.sessionFile, body);
    const changed = new NativeTail(f.state.sessionFile, f.state.sessionId, f.root);

    changed.read();
    writeFileSync(f.state.sessionFile, body.replace('"custom"', '"broken"'));
    assert.deepEqual(
        changed.snapshot(),
        [f.header, { ...entry, type: "broken" }],
        "equal size and valid JSON must not reuse the old body",
    );
    writeFileSync(f.state.sessionFile, body.replace('{"type":"custom"', '!"type":"custom"'));
    assert.throws(
        () => changed.snapshot(),
        SyntaxError,
        "malformed cached prefix keeps the fresh parse error",
    );
    writeFileSync(f.state.sessionFile, body);
    const replaced = new NativeTail(f.state.sessionFile, f.state.sessionId, f.root);

    replaced.read();
    writeFileSync(join(f.root, "replacement"), body);
    renameSync(join(f.root, "replacement"), f.state.sessionFile);
    assert.deepEqual(replaced.snapshot(), [f.header, entry]);
    const malformed = new NativeTail(f.state.sessionFile, f.state.sessionId, f.root);

    malformed.read();
    appendFileSync(f.state.sessionFile, "malformed-json\n");
    assert.throws(() => malformed.snapshot(), SyntaxError);
    writeFileSync(f.state.sessionFile, body);
    const truncated = new NativeTail(f.state.sessionFile, f.state.sessionId, f.root);

    truncated.read();
    writeFileSync(f.state.sessionFile, "");
    assert.deepEqual(truncated.snapshot(), []);
    assert.throws(() => truncated.read(), /replaced or truncated/);
});

test("run-owned tail stops retaining bodies above its bounded cache without losing snapshot or delivery", async (t) => {
    const f = fixture();
    const root = { type: "custom", id: "root", parentId: null, data: "A".repeat(600 * 1024) };
    const second = { type: "custom", id: "second", parentId: "root", data: "B".repeat(600 * 1024) };

    t.after(() => f.close());
    writeFileSync(
        f.state.sessionFile,
        [JSON.stringify(f.header), JSON.stringify(root), JSON.stringify(second)].join("\n") + "\n",
    );
    const tail = new NativeTail(f.state.sessionFile, f.state.sessionId, f.root);
    const parse = JSON.parse;
    let calls = 0;

    JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
        calls++;

        return parse(...args);
    }) as typeof JSON.parse;

    try {
        assert.deepEqual(
            tail.read().map((entry) => entry.id),
            [f.state.sessionId, "root", "second"],
        );
        assert.equal(calls, 3);
        const snapshot = tail.snapshot();

        assert.deepEqual(
            snapshot.map((entry) => entry.id),
            [f.state.sessionId, "root", "second"],
        );
        assert.equal(
            calls,
            6,
            "oversized prefix must use a fresh full parse instead of retained bodies",
        );
        appendFileSync(
            f.state.sessionFile,
            JSON.stringify({ type: "custom", id: "last", parentId: "root" }) + "\n",
        );
        assert.deepEqual(
            tail.read().map((entry) => entry.id),
            ["last"],
        );
        assert.deepEqual(tail.read(), []);
        assert.deepEqual(
            tail.snapshot().map((entry) => entry.id),
            [f.state.sessionId, "root", "second", "last"],
        );
        assert.equal(calls, 11);
    } finally {
        JSON.parse = parse;
    }
});

test("a single oversized persisted entry is refused instead of bypassing the import bound", async (t) => {
    const f = fixture();

    t.after(() => f.close());
    writeFileSync(f.state.sessionFile, JSON.stringify(f.header) + "\n");
    appendFileSync(
        f.state.sessionFile,
        JSON.stringify({
            type: "custom",
            id: "huge",
            parentId: null,
            data: "A".repeat(64 * 1024 * 1024),
        }) + "\n",
    );
    await assert.rejects(
        readNativeSnapshot(
            { request: async () => assert.fail("must not dispatch") },
            f.state,
            f.root,
        ),
        /line exceeds the import bound/,
    );
});

test("native snapshot rejects a foreign session header before RPC", async (t) => {
    const f = fixture();

    t.after(() => f.close());
    writeFileSync(f.state.sessionFile, JSON.stringify({ ...f.header, id: "foreign" }) + "\n");
    await assert.rejects(
        readNativeSnapshot(
            { request: async () => assert.fail("must not dispatch") },
            f.state,
            f.root,
        ),
        /header mismatch/,
    );
});
