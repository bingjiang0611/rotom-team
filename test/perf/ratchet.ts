/**
 * The work-counter ratchet: a ledger (`test/perf/ledger.json`) of counters, and the checks that keep them honest.
 *
 *   node test/perf/ratchet.ts check   <report.json>              gating counters within their ceilings?
 *   node test/perf/ratchet.ts propose <report.json> [--write]    lower ceilings / record baselines from a report
 *   node test/perf/ratchet.ts register <report.json…> [--write]  add the reports' new counters as candidates
 *   node test/perf/ratchet.ts guard   <base-ledger> <head-ledger> did a ledger edit loosen anything?
 *   node test/perf/ratchet.ts compare <base-report> <head-report> before/after, counters and milliseconds
 *
 * A counter counts how much work one fixed scenario does (SQL statements, child processes, bytes pushed to tabs, page
 * layouts). Counters do not move with machine load the way milliseconds do, so they can fail a check. A counter may
 * gate only after reviewed evidence that it is stable (repeat runs agree), sensitive (injected extra work moves it),
 * and correlated (it moves with the duration people wait for). Until then it is a candidate: reported against its
 * same-platform baseline, never failing. Ceilings and baselines only move down by themselves; raising one, widening a
 * tolerance, or demoting or removing a gate is a separate change with a raise record and explicit approval
 * (`ROTOM_TEAM_PERF_RAISE_APPROVED=1`).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Observation, Report, Timing } from "./measure.ts";

export const LEDGER = join(dirname(fileURLToPath(import.meta.url)), "ledger.json");

const LAYERS = ["storage", "process", "cpu", "push", "http", "web"];
const UNITS = ["count", "bytes", "chars"];

export type Entry = {
    scenario: string;
    metric: string;
    layer: string;
    unit: string;
    workload: string;
    source: string;
    status: "gating" | "candidate";
    /** How far same-revision runs may differ, and a value may exceed the ceiling or baseline, without failing. */
    tolerance: number;
    ceiling: number | null;
    /** Last accepted value per platform (`darwin-arm64`, `linux-x64`): counts may differ between systems. */
    baselines?: Record<string, number>;
    evidence?: { stability: string; sensitivity: string; correlation: string };
    raise?: { from: number; to: number; reason: string };
};

export type Ledger = { schema: 1; metrics: Record<string, Entry> };

export type Row = {
    key: string;
    layer: string;
    unit: string;
    status: Entry["status"] | "unregistered";
    result:
        | "pass"
        | "tightenable"
        | "regressed"
        | "unstable"
        | "missing"
        | "unavailable"
        | "candidate"
        | "better"
        | "worse"
        | "unchanged"
        | "unregistered";
    gateFailed: boolean;
    value?: number;
    min?: number;
    spread?: number;
    ceiling?: number | null;
    tolerance?: number;
    baseline?: number;
    proposedCeiling?: number;
    reason?: string;
};

const fail = (message: string): never => {
    throw new Error(message);
};

const count = (value: unknown): value is number =>
    Number.isSafeInteger(value) && Number(value) >= 0;
const text = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

export const metricKey = (scenario: string, metric: string) => `${scenario}/${metric}`;

export function validateLedger(ledger: Ledger): Ledger {
    if (ledger?.schema !== 1 || typeof ledger.metrics !== "object" || ledger.metrics === null) {
        fail("Unsupported ledger schema");
    }

    for (const [key, entry] of Object.entries(ledger.metrics)) {
        if (key !== metricKey(entry.scenario, entry.metric)) {
            fail(`Ledger key must be scenario/metric: ${key}`);
        }

        if (!LAYERS.includes(entry.layer) || !UNITS.includes(entry.unit)) {
            fail(`Unknown layer or unit for ${key}`);
        }

        if (!text(entry.workload) || !text(entry.source)) {
            fail(`Ledger entry needs a workload and a source: ${key}`);
        }

        if (!count(entry.tolerance)) {
            fail(`Tolerance must be a whole number: ${key}`);
        }

        if (entry.status === "gating") {
            if (!count(entry.ceiling)) {
                fail(`A gating counter needs a whole-number ceiling: ${key}`);
            }

            // Promotion evidence is a reviewed record; an empty field means that check never ran.
            for (const check of ["stability", "sensitivity", "correlation"] as const) {
                if (!text(entry.evidence?.[check])) {
                    fail(`A gating counter lacks ${check} evidence: ${key}`);
                }
            }
        } else if (entry.status === "candidate") {
            if (entry.ceiling !== null) {
                fail(`A candidate must not carry a ceiling: ${key}`);
            }
        } else {
            fail(`Unknown status for ${key}`);
        }

        if (
            entry.baselines !== undefined &&
            !Object.entries(entry.baselines).every(
                ([platform, value]) => text(platform) && count(value),
            )
        ) {
            fail(`Baselines map a platform to a whole number: ${key}`);
        }

        if (
            entry.raise !== undefined &&
            !(
                count(entry.raise.from) &&
                count(entry.raise.to) &&
                entry.raise.to > entry.raise.from &&
                text(entry.raise.reason)
            )
        ) {
            fail(`Invalid raise record: ${key}`);
        }
    }

    return ledger;
}

export function validateReport(report: Report): Report {
    if (
        report?.schema !== 1 ||
        !Array.isArray(report.observations) ||
        !text(report.revision) ||
        !text(report.platform)
    ) {
        fail("Unsupported report schema");
    }

    const seen = new Set<string>();

    for (const observation of report.observations) {
        const key = metricKey(observation.scenario, observation.metric);

        if (seen.has(key)) {
            fail(`Duplicate observation: ${key}`);
        }

        seen.add(key);

        if (observation.availability === "unavailable") {
            // Missing evidence stays explicit: it is never zero work.
            if (!text(observation.reason)) {
                fail(`An unavailable observation needs a reason: ${key}`);
            }
        } else if (
            observation.availability !== "measured" ||
            observation.runs.length === 0 ||
            !observation.runs.every(count)
        ) {
            fail(`A measured observation needs whole-number runs: ${key}`);
        }
    }

    return report;
}

/** How a report's counters stand against the ledger. Only gating rows can fail. */
export function check(ledger: Ledger, report: Report): { passed: boolean; rows: Row[] } {
    validateLedger(ledger);
    validateReport(report);
    const observations = new Map<string, Observation>(
        report.observations.map((each) => [metricKey(each.scenario, each.metric), each]),
    );
    const rows: Row[] = [];

    for (const [key, entry] of Object.entries(ledger.metrics)) {
        const observation = observations.get(key);
        const row = {
            key,
            layer: entry.layer,
            unit: entry.unit,
            status: entry.status,
            ceiling: entry.ceiling,
            tolerance: entry.tolerance,
        };

        observations.delete(key);

        if (observation === undefined) {
            rows.push({ ...row, result: "missing", gateFailed: entry.status === "gating" });
            continue;
        }

        if (
            observation.workload !== entry.workload ||
            observation.unit !== entry.unit ||
            observation.layer !== entry.layer
        ) {
            fail(
                `The report measured ${key} differently from the ledger; register a new key instead`,
            );
        }

        if (observation.availability === "unavailable") {
            rows.push({
                ...row,
                result: "unavailable",
                reason: observation.reason,
                gateFailed: entry.status === "gating",
            });
            continue;
        }

        const value = Math.max(...observation.runs);
        const min = Math.min(...observation.runs);
        const measured = { ...row, value, min, spread: value - min };

        if (entry.status === "candidate") {
            const baseline = entry.baselines?.[report.platform];
            const result =
                baseline === undefined
                    ? "candidate"
                    : value > baseline + entry.tolerance
                      ? "worse"
                      : value < baseline
                        ? "better"
                        : "unchanged";

            rows.push({
                ...measured,
                result,
                ...(baseline === undefined ? {} : { baseline }),
                gateFailed: false,
            });
            continue;
        }

        // Repeat runs of one revision must agree within tolerance; a counter that wanders cannot block a change.
        if (value - min > entry.tolerance) {
            rows.push({ ...measured, result: "unstable", gateFailed: true });
        } else if (value > entry.ceiling! + entry.tolerance) {
            rows.push({ ...measured, result: "regressed", gateFailed: true });
        } else if (value < entry.ceiling!) {
            rows.push({
                ...measured,
                result: "tightenable",
                proposedCeiling: value,
                gateFailed: false,
            });
        } else {
            rows.push({ ...measured, result: "pass", gateFailed: false });
        }
    }

    for (const [key, observation] of observations) {
        rows.push({
            key,
            layer: observation.layer,
            unit: observation.unit,
            status: "unregistered",
            result: observation.availability === "measured" ? "unregistered" : "unavailable",
            ...(observation.availability === "measured"
                ? { value: Math.max(...observation.runs) }
                : { reason: observation.reason }),
            gateFailed: false,
        });
    }

    return { passed: rows.every((row) => !row.gateFailed), rows };
}

/**
 * Lower gating ceilings to what the report measured, and record or lower the report platform's candidate baselines.
 * Never raises, promotes, or removes; refuses a failing report.
 */
/** A report from a deliberate regression must never become a baseline or ceiling. */
const genuine = (report: Report) => {
    if (report.inject !== null) {
        fail(
            `The report carries an injected regression (${report.inject}); measure without ROTOM_TEAM_PERF_INJECT`,
        );
    }
};

export function propose(ledger: Ledger, report: Report) {
    genuine(report);
    const result = check(ledger, report);

    if (!result.passed) {
        fail("Refusing to tighten from a failing report");
    }

    const next = structuredClone(ledger);
    const changes: object[] = [];

    for (const row of result.rows) {
        const entry = next.metrics[row.key];

        if (row.result === "tightenable") {
            changes.push({
                key: row.key,
                ceiling: { from: entry!.ceiling, to: row.proposedCeiling },
            });
            entry!.ceiling = row.proposedCeiling!;
            delete entry!.raise;
        } else if (
            row.status === "candidate" &&
            (row.result === "candidate" || row.result === "better")
        ) {
            changes.push({
                key: row.key,
                platform: report.platform,
                baseline: { from: row.baseline ?? null, to: row.value },
            });
            entry!.baselines = { ...entry!.baselines, [report.platform]: row.value! };
        }
    }

    return { ledger: next, changes };
}

/**
 * Add the reports' unregistered counters as candidates: the baseline is the worst run of all the reports, and the
 * tolerance the spread across all of them (several reports, taken at different times, show more of the noise than
 * one). Registering never gates: promotion is a reviewed edit with evidence.
 */
export function register(ledger: Ledger, reports: Report[]) {
    validateLedger(ledger);

    for (const report of reports) {
        genuine(report);
        validateReport(report);
    }

    const platform = reports[0]!.platform;

    if (
        reports.some(
            (report) =>
                report.platform !== platform ||
                JSON.stringify(report.workload) !== JSON.stringify(reports[0]!.workload),
        )
    ) {
        fail("Register from reports of one platform and workload");
    }

    const next = structuredClone(ledger);
    const added: string[] = [];

    for (const observation of reports[0]!.observations) {
        const key = metricKey(observation.scenario, observation.metric);

        if (next.metrics[key] !== undefined || observation.availability !== "measured") {
            continue;
        }

        const runs = reports.flatMap((report) => {
            const same = report.observations.find(
                (each) => metricKey(each.scenario, each.metric) === key,
            );

            return same?.availability === "measured" ? same.runs : [];
        });
        const { scenario, metric, layer, unit, workload, source } = observation;

        next.metrics[key] = {
            scenario,
            metric,
            layer,
            unit,
            workload,
            source,
            status: "candidate",
            tolerance: Math.max(...runs) - Math.min(...runs),
            ceiling: null,
            baselines: { [platform]: Math.max(...runs) },
        };
        added.push(key);
    }

    return { ledger: next, added };
}

/**
 * Guard a ledger edit. Tightening and new candidates or gates are free. Loosening (a higher ceiling or baseline, a
 * wider tolerance, a demoted or removed gate, a dropped baseline) needs approval, and a higher ceiling also a matching
 * raise record. Changing what a key measures needs a new key.
 */
export function guard(base: Ledger, head: Ledger, raiseApproved = false) {
    validateLedger(base);
    validateLedger(head);
    const violations: { key: string; kind: string; reason: string }[] = [];

    const loosened = (key: string, reason: string) => {
        if (!raiseApproved) {
            violations.push({ key, kind: "needs-approval", reason });
        }
    };

    for (const [key, before] of Object.entries(base.metrics)) {
        const after = head.metrics[key];

        if (after === undefined) {
            if (before.status === "gating") {
                loosened(key, "gating counter removed");
            }

            continue;
        }

        if (
            ["workload", "unit", "layer", "scenario", "metric"].some(
                (field) => after[field as keyof Entry] !== before[field as keyof Entry],
            )
        ) {
            violations.push({
                key,
                kind: "redefined",
                reason: "workload, unit, or layer changed; register a new key instead",
            });
            continue;
        }

        if (before.status === "gating" && after.status === "candidate") {
            loosened(key, "gating counter demoted");
            continue;
        }

        if (before.status === "gating") {
            if (after.tolerance > before.tolerance) {
                loosened(key, `tolerance ${before.tolerance} -> ${after.tolerance}`);
            }

            if (after.ceiling! > before.ceiling!) {
                if (after.raise?.from !== before.ceiling || after.raise?.to !== after.ceiling) {
                    violations.push({
                        key,
                        kind: "raise-record",
                        reason: `raise ${before.ceiling} -> ${after.ceiling} needs a matching raise record`,
                    });
                }

                loosened(key, `ceiling ${before.ceiling} -> ${after.ceiling}`);
            } else if (
                after.raise !== undefined &&
                JSON.stringify(after.raise) !== JSON.stringify(before.raise)
            ) {
                violations.push({
                    key,
                    kind: "raise-record",
                    reason: "raise record without a higher ceiling",
                });
            }
        } else if (after.tolerance > before.tolerance) {
            loosened(key, `tolerance ${before.tolerance} -> ${after.tolerance}`);
        }

        // A higher or dropped baseline would hide a `worse` report: that is loosening too.
        for (const [platform, value] of Object.entries(before.baselines ?? {})) {
            const next = after.baselines?.[platform];

            if (next === undefined) {
                loosened(key, `${platform} baseline removed`);
            } else if (next > value) {
                loosened(key, `${platform} baseline ${value} -> ${next}`);
            }
        }
    }

    for (const [key, after] of Object.entries(head.metrics)) {
        if (base.metrics[key] === undefined && after.raise !== undefined) {
            violations.push({
                key,
                kind: "raise-record",
                reason: "a new counter cannot carry a raise record",
            });
        }
    }

    return { passed: violations.length === 0, violations };
}

export type Comparison = {
    counters: {
        key: string;
        base: number;
        head: number;
        delta: number;
        verdict: "better" | "worse" | "same";
    }[];
    timings: {
        key: string;
        base: number;
        head: number;
        change: number;
        verdict: "faster" | "slower" | "noise";
    }[];
    unavailable: string[];
};

/**
 * Before and after, from two reports of the same workload and platform. Counters compare their worst run; timings
 * their medians, called faster or slower only past `noise` (a share, 0.2 = 20 %) and when every head run is on the
 * same side of every base run, so one lucky run cannot claim a speedup. A counter that moved no more than its
 * ledger tolerance (the spread its repeat runs showed when registered) is the same: the same code moves that much.
 */
export function compare(base: Report, head: Report, ledger?: Ledger, noise = 0.2): Comparison {
    validateReport(base);
    validateReport(head);

    if (
        base.platform !== head.platform ||
        JSON.stringify(base.workload) !== JSON.stringify(head.workload)
    ) {
        fail("Compare reports of one platform and workload");
    }

    const result: Comparison = { counters: [], timings: [], unavailable: [] };
    const headObservations = new Map(
        head.observations.map((each) => [metricKey(each.scenario, each.metric), each]),
    );

    for (const before of base.observations) {
        const key = metricKey(before.scenario, before.metric);
        const after = headObservations.get(key);

        if (
            after === undefined ||
            before.availability !== "measured" ||
            after.availability !== "measured"
        ) {
            result.unavailable.push(key);
            continue;
        }

        const from = Math.max(...before.runs);
        const to = Math.max(...after.runs);

        const tolerance = ledger?.metrics[key]?.tolerance ?? 0;

        result.counters.push({
            key,
            base: from,
            head: to,
            delta: to - from,
            verdict: Math.abs(to - from) <= tolerance ? "same" : to < from ? "better" : "worse",
        });
    }

    const headTimings = new Map<string, Timing>(
        head.timings.map((each) => [metricKey(each.scenario, each.metric), each]),
    );

    for (const before of base.timings) {
        const key = metricKey(before.scenario, before.metric);
        const after = headTimings.get(key);

        if (after === undefined) {
            result.unavailable.push(key);
            continue;
        }

        const change = before.median === 0 ? 0 : (after.median - before.median) / before.median;
        const separated =
            Math.max(...after.runs) < Math.min(...before.runs) ||
            Math.min(...after.runs) > Math.max(...before.runs);
        const verdict =
            Math.abs(change) < noise || !separated ? "noise" : change < 0 ? "faster" : "slower";

        result.timings.push({
            key,
            base: before.median,
            head: after.median,
            change: Math.round(change * 1000) / 1000,
            verdict,
        });
    }

    return result;
}

export function formatCheck(result: ReturnType<typeof check>, report: Report): string {
    const show = (value: number | null | undefined) =>
        value === undefined || value === null ? "-" : String(value);
    const worse = result.rows.filter((row) => row.result === "worse");

    return [
        `Ratchet: ${report.revision} · ${report.platform} · ${result.passed ? "passed" : "FAILED"}`,
        ...(worse.length > 0
            ? [
                  `${worse.length} candidate(s) worse than baseline (not gating): ${worse.map((row) => `${row.key} ${row.baseline} → ${row.value}`).join(", ")}`,
              ]
            : []),
        "",
        `${"counter".padEnd(42)}${"status".padEnd(13)}${"value".padStart(10)}${"baseline".padStart(10)}${"ceiling".padStart(10)}  result`,
        ...result.rows.map(
            (row) =>
                `${row.key.padEnd(42)}${row.status.padEnd(13)}${show(row.value).padStart(10)}${show(row.baseline).padStart(10)}${show(row.ceiling).padStart(10)}  ${row.result}${row.proposedCeiling === undefined ? "" : ` → ${row.proposedCeiling}`}${row.spread ? ` (spread ${row.spread})` : ""}${row.reason ? ` (${row.reason})` : ""}`,
        ),
    ].join("\n");
}

export function formatComparison(result: Comparison, base: Report, head: Report): string {
    const changed = result.counters.filter((row) => row.verdict !== "same");
    // The 1-minute load at either end of either report above the core count makes its milliseconds untrustworthy.
    const highLoad = [base, head].some((report) =>
        [report.load.before[0]!, report.load.after[0]!].some((load) => load > report.load.cores),
    );
    const load = (report: Report) =>
        `${report.load.before[0]!.toFixed(1)} → ${report.load.after[0]!.toFixed(1)}`;

    return [
        `Compare ${base.revision} → ${head.revision} · ${head.platform}`,
        `Load (1 min) base ${load(base)} · head ${load(head)} on ${head.load.cores} cores${highLoad ? ": HIGH, milliseconds are not evidence" : ""}`,
        "",
        "Counters that changed (worst run):",
        ...(changed.length === 0
            ? ["  none"]
            : changed.map(
                  (row) =>
                      `  ${row.verdict === "better" ? "↓" : "↑"} ${row.key.padEnd(40)}${String(row.base).padStart(10)} → ${String(row.head).padStart(10)}  (${row.delta > 0 ? "+" : ""}${row.delta})`,
              )),
        "",
        "Milliseconds (median of runs):",
        ...result.timings.map(
            (row) =>
                `  ${row.verdict.padEnd(7)} ${row.key.padEnd(30)}${String(row.base).padStart(9)} → ${String(row.head).padStart(9)}  (${row.change > 0 ? "+" : ""}${Math.round(row.change * 100)} %)`,
        ),
        ...(result.unavailable.length > 0
            ? ["", `Not comparable: ${result.unavailable.join(", ")}`]
            : []),
    ].join("\n");
}

const readJson = <T>(path: string) => JSON.parse(readFileSync(path, "utf8")) as T;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const [command, first, second] = process.argv.slice(2);
    const usage =
        "Usage: node test/perf/ratchet.ts check <report> | propose <report> [--write] | register <report…> [--write] | guard <base-ledger> <head-ledger> | compare <base-report> <head-report>";

    try {
        if (command === "check" && first !== undefined) {
            const report = readJson<Report>(first);
            const result = check(readJson<Ledger>(LEDGER), report);

            console.log(formatCheck(result, report));
            process.exitCode = result.passed ? 0 : 1;
        } else if (command === "propose" && first !== undefined) {
            const { ledger, changes } = propose(readJson<Ledger>(LEDGER), readJson<Report>(first));

            console.log(JSON.stringify(changes, null, 2));

            if (process.argv.includes("--write")) {
                writeFileSync(LEDGER, `${JSON.stringify(ledger, null, 4)}\n`);
                console.log(`Wrote ${LEDGER}`);
            }
        } else if (command === "register" && first !== undefined) {
            const paths = process.argv.slice(3).filter((arg) => arg !== "--write");
            const { ledger, added } = register(
                readJson<Ledger>(LEDGER),
                paths.map((path) => readJson<Report>(path)),
            );

            console.log(JSON.stringify(added, null, 2));

            if (process.argv.includes("--write")) {
                writeFileSync(LEDGER, `${JSON.stringify(ledger, null, 4)}\n`);
                console.log(`Wrote ${LEDGER}`);
            }
        } else if (command === "guard" && first !== undefined && second !== undefined) {
            const result = guard(
                readJson<Ledger>(first),
                readJson<Ledger>(second),
                process.env.ROTOM_TEAM_PERF_RAISE_APPROVED === "1",
            );

            console.log(JSON.stringify(result, null, 2));
            process.exitCode = result.passed ? 0 : 1;
        } else if (command === "compare" && first !== undefined && second !== undefined) {
            const base = readJson<Report>(first);
            const head = readJson<Report>(second);

            const ledger = validateLedger(readJson<Ledger>(LEDGER));

            console.log(formatComparison(compare(base, head, ledger), base, head));
        } else {
            fail(usage);
        }
    } catch (error) {
        console.error((error as Error).message);
        process.exitCode = 1;
    }
}
