/** The final report must retain cross-thread work, not only the already-ratcheted counters. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReport } from "./perf/measure.ts";
import { SCENARIOS } from "./perf/workload.ts";

const meta = {
    revision: "fixture",
    platform: "fixture",
    node: "fixture",
    cpu: "fixture",
    load: { before: [0], after: [0], cores: 1 },
    inject: null,
};
const run = (counts: Record<string, number>) =>
    Object.keys(SCENARIOS).map((scenario) => ({
        scenario,
        ms: 1,
        counts: scenario === "startup.restart" ? counts : {},
        extra: { storageRoundTripMs: 2 },
    }));

test("performance reports preserve V8 and storage transport work separately from timing", () => {
    const counts = {
        "storage.worker.requestBytes": 100,
        "storage.worker.replyBytes": 200,
        "v8.serialize.calls": 3,
        "v8.serialize.bytes": 300,
        "v8.deserialize.calls": 4,
        "v8.deserialize.bytes": 400,
    };
    const report = buildReport([run(counts)], meta);

    for (const [metric, value] of Object.entries(counts)) {
        const observed = report.observations.find(
            (item) => item.scenario === "startup.restart" && item.metric === metric,
        );

        assert.equal(observed?.availability, "measured", `${metric} must survive report export`);
        assert.deepEqual(observed?.availability === "measured" && observed.runs, [value]);
        assert.equal(observed?.unit, /bytes$/i.test(metric) ? "bytes" : "count");
    }

    assert.equal(
        report.observations.some((item) => item.metric.endsWith("Ms")),
        false,
    );
    assert.equal(report.timings.find((item) => item.metric === "storageRoundTripMs")?.median, 2);
});

test("an absent transport sample is unavailable, never a synthetic zero", () => {
    const report = buildReport([run({ "storage.worker.replyBytes": 42 }), run({})], meta);
    const observed = report.observations.find(
        (item) => item.metric === "storage.worker.replyBytes",
    );

    assert.equal(observed?.availability, "unavailable");
    assert.equal("runs" in observed!, false);
});
