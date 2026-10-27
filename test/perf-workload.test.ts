import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { readLedger } from "./perf/ledger.ts";
import { metricSpec, REPORTED, SCENARIOS } from "./perf/workload.ts";

test("extracted benchmark stages retain the original execution order, including native-long before assets", () => {
    const source = ts.createSourceFile(
        "scenarios.ts",
        readFileSync(new URL("./perf/scenarios.ts", import.meta.url), "utf8"),
        ts.ScriptTarget.Latest,
        true,
    );
    const stages = [
        "runImageScenarios",
        "runHistoryScenarios",
        "runNativeWarmScenarios",
        "runEstablishedSends",
        "runJournalScenario",
        "runNativeLongScenario",
        "runAssetScenarios",
        "runNetworkSends",
    ];
    const actual: string[] = [];

    for (const statement of source.statements) {
        if (!ts.isExpressionStatement(statement) || !ts.isAwaitExpression(statement.expression)) {
            continue;
        }

        const call = statement.expression.expression;

        if (
            ts.isCallExpression(call) &&
            ts.isIdentifier(call.expression) &&
            stages.includes(call.expression.text)
        ) {
            actual.push(call.expression.text);
        }
    }

    assert.deepEqual(actual, stages);
});

test("every assembled ledger key still describes a reported scenario with the same workload, layer and unit", () => {
    for (const [key, entry] of Object.entries(readLedger().metrics)) {
        assert.equal(entry.workload, SCENARIOS[entry.scenario], key);
        assert.ok(REPORTED[entry.scenario]?.includes(entry.metric), key);
        const spec = metricSpec(entry.metric);

        assert.equal(entry.layer, spec.layer, key);
        assert.equal(entry.unit, spec.unit, key);
    }
});
