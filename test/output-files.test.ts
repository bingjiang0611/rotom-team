/** Outputs are explicit successful tool records, never a directory scan or guessed shell/script paths. */
import assert from "node:assert/strict";
import { test } from "node:test";

const WEB: string = "../web/calls.js";
const { writtenFiles } = await import(WEB);
const call = (id: string, name: string, args: Record<string, unknown>, clipped?: unknown) => ({
    type: "toolCall",
    id,
    name,
    args,
    ...(clipped ? { clipped } : {}),
});
const assistant = (id: number, ...blocks: unknown[]) => ({ id, kind: "assistant", blocks });
const result = (id: number, callId: string, isError = false, details?: unknown) => ({
    id,
    kind: "toolResult",
    callId,
    isError,
    details,
});

test("Outputs includes successful native/legacy writes and the most recent edit once", () => {
    const entries = [
        assistant(1, call("w1", "write", { path: "hello.html" })),
        result(2, "w1"),
        assistant(3, call("w2", "Write", { file_path: "中文 空格.md" })),
        result(4, "w2"),
        assistant(5, call("e1", "edit", { path: "hello.html" })),
        result(6, "e1"),
    ];
    const before = JSON.stringify(entries);

    assert.deepEqual(writtenFiles(entries), [
        { path: "hello.html", action: "edit", entryId: 6 },
        { path: "中文 空格.md", action: "write", entryId: 4 },
    ]);
    assert.equal(JSON.stringify(entries), before, "history remains immutable");
});

test("Outputs never treats pending, failed, clipped, unpaired or read calls as successful writes", () => {
    assert.deepEqual(
        writtenFiles([
            assistant(1, call("pending", "write", { path: "pending.md" })),
            assistant(2, call("failed", "write", { path: "failed.md" })),
            result(3, "failed", true),
            assistant(4, call("read", "read", { path: "private.txt" })),
            result(5, "read"),
            assistant(6, call("clipped", "write", { path: "part…path" }, { path: 2000 })),
            result(7, "clipped"),
            result(8, "missing-caller"),
            assistant(9, call("shell", "bash", { command: "echo secret > guessed.txt" })),
            result(10, "shell"),
            { id: 11, kind: "user", text: "[secret](private.txt)" },
        ]),
        [],
    );
});

test("codemode uses reported successful child paths even if its later script failed, never parses code", () => {
    assert.deepEqual(
        writtenFiles([
            assistant(
                1,
                call("script", "codemode", {
                    code: "await tools.write({path:'guessed.txt'}); throw Error()",
                }),
            ),
            result(2, "script", true, {
                calls: [
                    { name: "write", status: "ok", path: "actual.md" },
                    { name: "edit", status: "error", path: "failed.md" },
                    { name: "read", status: "ok", path: "not-output.md" },
                    { name: "write", status: "running", path: "unfinished.md" },
                    { name: "write", status: "ok", args: { path: "not-public.md" } },
                ],
            }),
        ]),
        [{ path: "actual.md", action: "write", entryId: 2 }],
    );
});

test("empty histories, non-path arguments and control characters do not manufacture output links", () => {
    assert.deepEqual(writtenFiles([]), []);

    for (const path of [undefined, {}, 1, "", "  ", "x\ny", "x\u0000y"]) {
        assert.deepEqual(
            writtenFiles([assistant(1, call("w", "write", { path })), result(2, "w")]),
            [],
        );
    }
});
