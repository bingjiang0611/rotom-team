import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";

// This checks the probe's workload and readback semantics, not a machine-dependent memory ceiling.
test("memory probe counts complete prefix parses, refreshes delivery and samples a released snapshot", () => {
    const r = JSON.parse(
        execFileSync(
            process.execPath,
            [
                "--expose-gc",
                join(import.meta.dirname, "perf/native-tail-memory.ts"),
                "--child",
                join(import.meta.dirname, "../src/server/rotom-executions.ts"),
                "small",
            ],
            { encoding: "utf8" },
        ),
    );

    assert.equal(r.before.parses, 0);
    assert.equal(r.afterRead.parses, 129);
    assert.equal(r.afterSnapshot[0].parses, 129);
    assert.equal(r.afterAppend.parses, 130);
    assert.equal(r.atSnapshot.length, 3);
    assert.equal(r.workload.entries, 128);
    assert.equal(r.workload.chars, 120);

    for (const s of [
        r.before,
        r.afterRead,
        ...r.atSnapshot,
        ...r.afterSnapshot,
        r.afterAppend,
        r.afterRelease,
    ]) {
        for (const key of [
            "rss",
            "heapUsed",
            "heapTotal",
            "external",
            "arrayBuffers",
            "peakRss",
            "parses",
            "parseChars",
        ]) {
            assert.ok(Number.isFinite(s[key]) && s[key] >= 0, key);
        }
    }
});
