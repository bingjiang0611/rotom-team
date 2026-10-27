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
import { fileURLToPath } from "node:url";
import { runRatchetCli } from "./ratchet-cli.ts";

export {
    check,
    guard,
    propose,
    register,
    metricKey,
    validateLedger,
    validateReport,
    type Entry,
    type Ledger,
    type Row,
} from "./ratchet-core.ts";
export { compare, formatCheck, formatComparison, type Comparison } from "./ratchet-comparison.ts";
export { LEDGER } from "./ledger.ts";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    runRatchetCli();
}
