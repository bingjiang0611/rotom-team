import assert from "node:assert/strict";
import { test } from "node:test";
import { publicNativeHistory } from "../src/server/rotom-history.ts";

const usage = {
    input: 11,
    output: 5,
    cacheRead: 3,
    cacheWrite: 2,
    totalTokens: 21,
    reasoning: 2,
    cacheWrite1h: 1,
    cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.002, total: 0.033 },
};
const assistant = (content: unknown[], stopReason = "stop") => ({
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "fixture",
    usage,
    content,
    stopReason,
    timestamp: 1,
});
const call = (id = "call_private|fc_private", name = "read") => ({
    type: "toolCall",
    id,
    name,
    arguments: { path: "notes.txt", nested: { public: true } },
    thoughtSignature: "SECRET_CALL",
});
const result = (toolCallId = "call_private|fc_private", toolName = "read") => ({
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text: "public result", signature: "SECRET_RESULT" }],
    isError: false,
    timestamp: 2,
    details: { token: "SECRET_DETAILS" },
    usage,
});

test("cross-account history reconstructs only public content and paired neutral tool IDs", () => {
    const source = [
        { role: "system", content: "SECRET_SYSTEM", toolsAdded: [{ name: "private" }] },
        { role: "custom", content: "SECRET_EXTENSION", details: { private: true } },
        { role: "user", content: "public prompt", timestamp: 0, extra: "SECRET_USER" },
        {
            ...assistant(
                [
                    {
                        type: "thinking",
                        thinking: "SECRET_THINKING",
                        thinkingSignature: "SECRET_SIGNATURE",
                    },
                    { type: "text", text: "public answer", textSignature: "SECRET_TEXT" },
                    call(),
                ],
                "toolUse",
            ),
            responseId: "SECRET_RESPONSE",
            deferred: { data: "SECRET_HANDLE" },
            diagnostics: "SECRET_DIAGNOSTICS",
        },
        result(),
        assistant([{ type: "text", text: "finished" }]),
    ];
    const before = structuredClone(source);
    const projected = publicNativeHistory(source);

    assert.deepEqual(source, before);
    assert.equal(projected.length, 4);
    assert.ok(!JSON.stringify(projected).includes("SECRET"));
    assert.ok(!JSON.stringify(projected).includes("private|fc"));
    const response = projected[1],
        toolResult = projected[2];

    assert.ok(response?.role === "assistant" && toolResult?.role === "toolResult");
    assert.equal(response.provider, "team-public-history");
    assert.deepEqual(response.usage, usage);
    assert.notEqual(response.usage, usage);
    const tool = response.content.find((part) => part.type === "toolCall")!;

    assert.equal(tool.id, "team_tool_1");
    assert.equal(toolResult.toolCallId, tool.id);
    assert.deepEqual(toolResult.usage, usage);
    tool.arguments.path = "changed";
    assert.deepEqual(source, before);
});

test("summaries, images and reused source call IDs preserve public context without native metadata", () => {
    const image = {
        type: "image",
        data: "public-base64",
        mimeType: "image/png",
        private: "SECRET",
    };
    const projected = publicNativeHistory([
        {
            role: "compactionSummary",
            summary: "public compacted context",
            tokensBefore: 1000,
            timestamp: 0,
            systemMessage: "SECRET",
        },
        { role: "branchSummary", summary: "public branch summary", fromId: "SECRET", timestamp: 1 },
        { role: "user", content: [image], timestamp: 2 },
        assistant([call()], "toolUse"),
        result(),
        assistant([call()], "toolUse"),
        { ...result(), content: [image] },
        assistant([{ type: "thinking", thinking: "SECRET" }]),
    ]);

    assert.equal(projected.length, 7);
    assert.ok(JSON.stringify(projected).includes("public compacted context"));
    assert.ok(JSON.stringify(projected).includes("public branch summary"));
    assert.ok(!JSON.stringify(projected).includes("SECRET"));
    assert.ok(JSON.stringify(projected).includes("team_tool_2"));
    assert.equal(JSON.stringify(projected).match(/public-base64/g)?.length, 2);
});

test("unfinished, duplicate, mismatched and orphan tool pairs are blocked rather than invented or replayed", () => {
    for (const messages of [
        [assistant([call()], "toolUse")],
        [result()],
        [assistant([call()], "toolUse"), result("wrong")],
        [assistant([call()], "toolUse"), result(undefined, "write")],
        [assistant([call(), call()], "toolUse"), result()],
        [assistant([call()], "toolUse"), { role: "user", content: "next", timestamp: 3 }],
        [assistant([call()], "toolUse"), assistant([{ type: "text", text: "next" }])],
    ]) {
        assert.throws(() => publicNativeHistory(messages), /Unpaired|Duplicate/);
    }

    assert.throws(
        () => publicNativeHistory([assistant([{ type: "text", text: "pending" }], "pending")]),
        /Unsettled/,
    );
    assert.throws(
        () => publicNativeHistory([assistant([{ type: "text", text: "deferred" }], "deferred")]),
        /Unsettled/,
    );
});

test("malformed persisted public fields fail closed instead of becoming synthetic values", () => {
    assert.throws(
        () => publicNativeHistory([{ role: "user", content: "test", timestamp: null }]),
        /number/,
    );
    assert.throws(
        () =>
            publicNativeHistory([
                { ...assistant([{ type: "text", text: "test" }]), usage: undefined },
            ]),
        /record/,
    );
    assert.throws(
        () => publicNativeHistory([assistant([{ type: "text", text: { secret: true } }])]),
        /text/,
    );
    assert.throws(
        () => publicNativeHistory([assistant([{ ...call(), arguments: null }], "toolUse")]),
        /record/,
    );
});
