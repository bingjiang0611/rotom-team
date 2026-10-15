import assert from "node:assert/strict";
import { test } from "node:test";
import {
    mkdtempSync,
    realpathSync,
    writeFileSync,
    rmSync,
    existsSync,
    appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readNativeSnapshot, currentBranchGoalState } from "../src/server/rotom-executions.ts";
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
