import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeNativeControl } from "../src/server/rotom-control.ts";
import type { RpcRecord } from "../src/server/rotom-rpc.ts";

const notification = (message: string): RpcRecord => ({
    type: "extension_ui_request",
    method: "notify",
    message,
});

test("native control decoding preserves ordinary text/JSON and ignores non-notify events", () => {
    for (const message of [
        "plain notification",
        'mention {"kind":"team-kernel-context-v1"} in text',
        '{"kind":"custom","message":"not a Team control"}',
        '{"incomplete ordinary JSON":',
        '[{"kind":"team-kernel-children-v1","pending":0}]',
    ]) {
        const event = notification(message);

        assert.equal(decodeNativeControl(event), undefined);
        assert.equal(decodeNativeControl(event), undefined);
        assert.equal(event.message, message);
    }

    const message = '{"kind":"team-kernel-children-v1","pending":0}';

    assert.equal(decodeNativeControl({ type: "message_update", message }), undefined);
    assert.equal(decodeNativeControl({ ...notification(message), method: "setStatus" }), undefined);
});

test("all five native envelopes decode once without changing their wire objects", () => {
    for (const value of [
        { kind: "team-kernel-children-v1", pending: 0 },
        { kind: "team-kernel-policy-v1", nonce: "probe", ready: false },
        { kind: "team-kernel-barrier-v1", nonce: "barrier", ok: true },
        { kind: "team-kernel-context-v1", nonce: "context", result: { text: "x".repeat(20_000) } },
        {
            kind: "team-kernel-tree-v1",
            nonce: "tree",
            result: {
                cancelled: false,
                editorText: "draft",
                summaryEntry: { type: "branch_summary", id: "summary" },
            },
        },
    ]) {
        const event = notification(JSON.stringify(value));
        const copy = structuredClone(event);
        const decoded = decodeNativeControl(event);

        assert.deepEqual(decoded, value);
        assert.equal(decodeNativeControl(event), decoded, "same event shares its decoded value");
        assert.notEqual(
            decodeNativeControl(notification(event.message as string)),
            decoded,
            "no cross-event cache",
        );
        assert.deepEqual(event, copy, "no change to the public RPC event");
        assert.deepEqual(decodeNativeControl(notification(JSON.stringify(value, null, 2))), value);
    }

    assert.deepEqual(
        decodeNativeControl(notification('{"pending":2,"kind":"team-kernel-children-v1"}')),
        { pending: 2, kind: "team-kernel-children-v1" },
    );
});

test("reserved malformed and unknown controls are rejected without exposing their payload", () => {
    const malformed = [
        '{"kind":"team-kernel-children-v1",',
        ' { "kind" : "team-kernel-unknown-v1",',
        ...[
            { kind: "team-kernel-new-v1", secret: "private-body" },
            { kind: "team-kernel-children-v1", pending: -1 },
            { kind: "team-kernel-children-v1", pending: 0.5 },
            { kind: "team-kernel-children-v1", pending: "0" },
            { kind: "team-kernel-children-v1", pending: Number.MAX_SAFE_INTEGER + 1 },
            { kind: "team-kernel-policy-v1", nonce: "n", ready: 1 },
            { kind: "team-kernel-barrier-v1", nonce: "", ok: true },
            { kind: "team-kernel-barrier-v1", nonce: "n", ok: false },
            { kind: "team-kernel-context-v1", nonce: "n", result: [] },
            { kind: "team-kernel-context-v1", nonce: "n", result: null },
            { kind: "team-kernel-tree-v1", nonce: "n", result: { cancelled: "false" } },
            {
                kind: "team-kernel-tree-v1",
                nonce: "n",
                result: { cancelled: false, editorText: 1 },
            },
            {
                kind: "team-kernel-tree-v1",
                nonce: "n",
                result: { cancelled: false, summaryEntry: {} },
            },
        ].map((value) => JSON.stringify(value)),
    ];

    for (const message of malformed) {
        assert.throws(
            () => decodeNativeControl(notification(message)),
            (error: Error) => {
                assert.match(error.message, /native control notification/);
                assert.ok(!error.message.includes("private-body"));

                return true;
            },
        );
    }
});
