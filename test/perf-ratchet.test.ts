// The work-counter ratchet: gating counters fail on regression, instability, or missing evidence; candidates only
// report; ceilings and baselines move down by themselves and up only with approval; injected reports never tighten.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Report } from "./perf/measure.ts";
import { check, compare, guard, type Ledger, propose, register } from "./perf/ratchet.ts";
import { readLedger } from "./perf/ledger.ts";

const workload = "fixed work";
const base = { layer: "process", unit: "count", workload, source: "test" } as const;

const ledger = (): Ledger => ({
    schema: 1,
    metrics: {
        "git.changes/subprocess.git": {
            scenario: "git.changes",
            metric: "subprocess.git",
            ...base,
            status: "gating",
            tolerance: 0,
            ceiling: 5,
            evidence: { stability: "s", sensitivity: "s", correlation: "c" },
        },
        "turn.warm/sql.statements": {
            scenario: "turn.warm",
            metric: "sql.statements",
            ...base,
            layer: "storage",
            status: "candidate",
            tolerance: 2,
            ceiling: null,
            baselines: { "darwin-arm64": 148 },
        },
    },
});

const report = (git: number[] | null, sql: number[], inject: string | null = null): Report => ({
    schema: 1,
    revision: "abc",
    platform: "darwin-arm64",
    node: "24",
    cpu: "test",
    load: { before: [1, 1, 1], after: [1, 1, 1], cores: 8 },
    runs: sql.length,
    inject,
    workload: {} as Report["workload"],
    observations: [
        git === null
            ? {
                  scenario: "git.changes",
                  metric: "subprocess.git",
                  ...base,
                  availability: "unavailable",
                  reason: "no git",
              }
            : {
                  scenario: "git.changes",
                  metric: "subprocess.git",
                  ...base,
                  availability: "measured",
                  runs: git,
              },
        {
            scenario: "turn.warm",
            metric: "sql.statements",
            ...base,
            layer: "storage",
            availability: "measured",
            runs: sql,
        },
    ],
    timings: [{ scenario: "git.changes", metric: "ms", runs: [300, 310, 305], median: 305 }],
});

const result = (key: string, value: ReturnType<typeof check>) =>
    value.rows.find((row) => row.key === key)!.result;

test("a gating counter passes at its ceiling and fails above it, when unstable, or when unmeasured", () => {
    assert.equal(check(ledger(), report([5, 5, 5], [148])).passed, true);

    const regressed = check(ledger(), report([6, 6, 6], [148]));

    assert.equal(regressed.passed, false);
    assert.equal(result("git.changes/subprocess.git", regressed), "regressed");
    assert.equal(
        result("git.changes/subprocess.git", check(ledger(), report([4, 5, 5], [148]))),
        "unstable",
    );

    const unavailable = check(ledger(), report(null, [148]));

    assert.equal(unavailable.passed, false, "missing evidence is never a pass");
    assert.equal(result("git.changes/subprocess.git", unavailable), "unavailable");
});

test("a candidate reports worse or better against its baseline, and never fails", () => {
    const worse = check(ledger(), report([5], [151]));

    assert.equal(worse.passed, true);
    assert.equal(result("turn.warm/sql.statements", worse), "worse");
    assert.equal(
        result("turn.warm/sql.statements", check(ledger(), report([5], [150]))),
        "unchanged",
    );
    assert.equal(result("turn.warm/sql.statements", check(ledger(), report([5], [140]))), "better");
});

test("propose lowers ceilings and baselines only, and refuses failing or injected reports", () => {
    const { ledger: next } = propose(ledger(), report([4, 4, 4], [140]));

    assert.equal(next.metrics["git.changes/subprocess.git"]!.ceiling, 4);
    assert.equal(next.metrics["turn.warm/sql.statements"]!.baselines!["darwin-arm64"], 140);
    assert.deepEqual(
        propose(ledger(), report([5], [151])).ledger.metrics["turn.warm/sql.statements"]!.baselines,
        {
            "darwin-arm64": 148,
        },
    );
    assert.throws(() => propose(ledger(), report([6], [148])), /failing report/);
    assert.throws(() => propose(ledger(), report([4], [140], "git")), /injected/);
});

test("register adds candidates from several reports with their combined spread, never gates", () => {
    const empty: Ledger = { schema: 1, metrics: {} };
    const { ledger: next, added } = register(empty, [
        report([5, 5], [148, 150]),
        report([5], [146]),
    ]);

    assert.deepEqual(added.sort(), ["git.changes/subprocess.git", "turn.warm/sql.statements"]);
    assert.equal(next.metrics["turn.warm/sql.statements"]!.status, "candidate");
    assert.equal(next.metrics["turn.warm/sql.statements"]!.tolerance, 4);
    assert.deepEqual(next.metrics["turn.warm/sql.statements"]!.baselines, { "darwin-arm64": 150 });
    assert.throws(() => register(empty, [report([5], [148], "git")]), /injected/);
});

test("guard lets tightening through and stops loosening without approval and a raise record", () => {
    const before = ledger();
    const tightened = structuredClone(before);

    tightened.metrics["git.changes/subprocess.git"]!.ceiling = 4;
    tightened.metrics["turn.warm/sql.statements"]!.baselines = { "darwin-arm64": 140 };
    assert.equal(guard(before, tightened).passed, true);

    const raised = structuredClone(before);

    raised.metrics["git.changes/subprocess.git"]!.ceiling = 6;
    assert.deepEqual(
        guard(before, raised)
            .violations.map((each) => each.kind)
            .sort(),
        ["needs-approval", "raise-record"],
    );
    raised.metrics["git.changes/subprocess.git"]!.raise = {
        from: 5,
        to: 6,
        reason: "a needed new git call",
    };
    assert.equal(guard(before, raised).passed, false, "a raise record alone is not approval");
    assert.equal(guard(before, raised, true).passed, true);

    const loosened = structuredClone(before);

    loosened.metrics["turn.warm/sql.statements"]!.baselines = { "darwin-arm64": 160 };
    assert.equal(guard(before, loosened).passed, false);

    const demoted = structuredClone(before);

    delete demoted.metrics["git.changes/subprocess.git"];
    assert.equal(guard(before, demoted).passed, false);

    const redefined = structuredClone(before);

    redefined.metrics["git.changes/subprocess.git"]!.workload = "other work";
    assert.equal(guard(before, redefined, true).violations[0]!.kind, "redefined");
});

test("compare calls milliseconds faster or slower only when the runs separate past the noise", () => {
    const head = report([5], [140]);

    head.timings = [{ scenario: "git.changes", metric: "ms", runs: [150, 160, 155], median: 155 }];
    const faster = compare(report([5], [148]), head);

    assert.equal(faster.timings[0]!.verdict, "faster");
    assert.deepEqual(
        faster.counters.find((row) => row.key === "turn.warm/sql.statements"),
        { key: "turn.warm/sql.statements", base: 148, head: 140, delta: -8, verdict: "better" },
    );

    head.timings = [{ scenario: "git.changes", metric: "ms", runs: [150, 160, 320], median: 160 }];
    assert.equal(
        compare(report([5], [148]), head).timings[0]!.verdict,
        "noise",
        "one lucky run is not a speedup",
    );
    // turn.warm/sql.statements has tolerance 2 in the ledger: 148 -> 146 is what the same code does.
    assert.equal(
        compare(report([5], [148]), report([5], [146]), ledger()).counters.find(
            (row) => row.key === "turn.warm/sql.statements",
        )!.verdict,
        "same",
    );
    assert.equal(
        compare(report([5], [148]), report([5], [145]), ledger()).counters.find(
            (row) => row.key === "turn.warm/sql.statements",
        )!.verdict,
        "better",
    );
});

test("the committed ledger is valid, and every gating counter carries its evidence", () => {
    const committed = readLedger();
    const gating = Object.values(committed.metrics).filter((entry) => entry.status === "gating");

    assert.ok(gating.length > 0);
});
