import { check, metricKey, validateReport, type Ledger } from "./ratchet-core.ts";
import type { Report, Timing } from "./measure.ts";

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
        throw new Error("Compare reports of one platform and workload");
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
