/** Reproduce the three readers of one children report: transport, prompt waiter and Team live view. */
import assert from "node:assert/strict";
import { snapshot, since } from "../../../test/perf/counters.ts";
import { childrenReport } from "../../../src/server/rotom-rpc.ts";

const records = Array.from({ length: 100 }, (_, i) => ({
    type: "extension_ui_request",
    method: "notify",
    message: JSON.stringify({ kind: "team-kernel-children-v1", pending: i % 3 }),
}));
const before = snapshot();

for (const [i, record] of records.entries()) {
    for (let reader = 0; reader < 3; reader++) {
        assert.equal(childrenReport(record), i % 3);
    }
}

const counts = since(before);

assert.equal(typeof counts["json.parse.nativeReadback.calls"], "number");
assert.equal(typeof counts["json.parse.nativeReadback.chars"], "number");
console.log(
    JSON.stringify({
        records: records.length,
        readers: 3,
        parseCalls: counts["json.parse.nativeReadback.calls"],
        parseChars: counts["json.parse.nativeReadback.chars"],
    }),
);
