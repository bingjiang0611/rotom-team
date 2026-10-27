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
import type { Observation, Report } from "./measure.ts";

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
