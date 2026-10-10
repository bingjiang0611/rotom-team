/** Pinned SessionManager projection/import proof, with no Agent loop or network. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyRotomKernel } from "../src/server/rotom-kernel.ts";
import { publicNativeHistory } from "../src/server/rotom-history.ts";

process.umask(0o077);
const { version } = verifyRotomKernel();
const { SessionManager } = await import(
    new URL(
        "../runtime/rotom/node_modules/@bingjiang0611/rotom/runtime/pi/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js",
        import.meta.url,
    ).href
);
const root = realpathSync(mkdtempSync(join(tmpdir(), "rotom-history-proof-")));
const workspace = join(root, "workspace");

mkdirSync(workspace, { mode: 0o700 });
const source = SessionManager.create(workspace, join(root, "source"));
const usage = {
    input: 5,
    output: 3,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 8,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const assistant = (text: string) => ({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "fixture",
    usage,
    stopReason: "stop",
    timestamp: 2,
});

source.appendMessage({ role: "system", content: "SECRET_SYSTEM" });
source.appendMessage({ role: "user", content: "original question", timestamp: 1 });
const branch = source.appendMessage(assistant("original answer"));

source.appendMessage({ role: "user", content: "SECRET_OFF_BRANCH", timestamp: 3 });
source.appendMessage(assistant("SECRET_OFF_BRANCH_REPLY"));
source.branch(branch);
const kept = source.appendMessage({
    role: "user",
    content: "public current question",
    timestamp: 4,
});
const editable = source.appendMessage(assistant("SECRET_SUPERSEDED_TEXT"));

source.appendContextEdit(editable, { content: [{ type: "text", text: "public edited answer" }] });
source.appendCustomEntry("qoder-account-binding", { fingerprint: "SECRET_FINGERPRINT" });
source.appendCompaction(
    "public prior summary",
    kept,
    1000,
    { private: "SECRET_COMPACTION_DETAILS" },
    false,
    usage,
);
source.appendCustomMessageEntry("private-extension", "SECRET_EXTENSION", false, { secret: true });
const sourcePath = source.getSessionFile();
const before = readFileSync(sourcePath, "utf8");

assert.ok(before.includes("SECRET_OFF_BRANCH"));
const reopened = SessionManager.open(sourcePath);
const projection = publicNativeHistory(reopened.buildSessionProjection().messages);

assert.equal(readFileSync(sourcePath, "utf8"), before);
assert.ok(!JSON.stringify(projection).includes("SECRET"));
assert.ok(JSON.stringify(projection).includes("public prior summary"));
assert.ok(JSON.stringify(projection).includes("public edited answer"));
const target = SessionManager.create(workspace, join(root, "target"));

for (const message of projection) {
    target.appendMessage(message);
}

assert.notEqual(target.getSessionId(), source.getSessionId());
const targetPath = target.getSessionFile();
const targetDisk = readFileSync(targetPath, "utf8");

assert.ok(!targetDisk.includes("SECRET"));
assert.ok(!targetDisk.includes(sourcePath));
assert.equal(readFileSync(sourcePath, "utf8"), before);
assert.deepEqual(SessionManager.open(targetPath).buildSessionProjection().messages, projection);
const report = {
    status: "passed",
    version,
    noNetwork: true,
    activeBranchOnly: true,
    contextEditsApplied: true,
    compactionApplied: true,
    nativePrivateStateOmitted: true,
    independentNativeSession: true,
    sourceUnchanged: true,
    messages: projection.length,
    lifecycleJournalWired: false,
};

writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ ...report, evidence: join(root, "report.json") }));
