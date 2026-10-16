# 2026-10-16: gate the Git counters of the changes and branches routes

**Type**: metric maintenance (promotion of two candidates to gating). No product code changed.

## Question

Can `git.changes/subprocess.git` and `git.branches/subprocess.git` gate changes? Each counts the Git child processes
the server starts for one `GET changes` or `GET branches` in the benchmark workspace (20 changed files, 2 branches).

## Method

Machine: Apple M1, 8 cores, 16 GB, macOS, Node 24.18.0. Revision `4a5f45f` plus the uncommitted performance loop.

1. Stability: `npm run perf:measure -- --runs 5` twice, at different times (10 fresh-process runs).
2. Sensitivity and correlation: `ROTOM_TEAM_PERF_INJECT=git npm run perf:measure -- --runs 5`, which runs every Git
   command a second time, synchronously, in the same folder: the regression of a code path that calls Git twice.
3. `node test/perf/ratchet.ts check` on both reports, with the two counters gating at their measured values.

## Results

| Counter                       | 10 normal runs | 5 injected runs | Check on injected report |
| ----------------------------- | -------------- | --------------- | ------------------------ |
| `git.changes/subprocess.git`  | 5 every run    | 10 every run    | `regressed`, exit 1      |
| `git.branches/subprocess.git` | 2 every run    | 4 every run     | `regressed`, exit 1      |

Milliseconds, same machine, load 2.5 to 3.7 (below the 8 cores):

| Scenario       | Normal runs (median; all)                | Injected runs (median; all)              |
| -------------- | ---------------------------------------- | ---------------------------------------- |
| `git.branches` | 95.7; 98.2, 68.8, 95.7, 94.7, 99.3       | 166.7; 185, 155.9, 150.1, 170.6, 166.7   |
| `git.changes`  | 308.1; 325.4, 254.5, 326.2, 259.5, 308.1 | 389.9; 424.8, 369.1, 322.6, 389.9, 423.2 |

`git.branches` separates completely (every injected run slower than every normal run). `git.changes` moves its median
by 27 % but the slowest normal run (326.2) is above the fastest injected run (322.6): its Git commands partly run in
parallel, so doubling them costs less than double. Both counters move exactly with the injected work.

Repeated the same day after the benchmark moved to temporary checkouts (`test/perf/checkout.ts`): 10 more runs at load
2.4 to 3.3 gave 5 and 2 in every run. Medians: `git.changes` 222.9 and 291.3 ms, `git.branches` 90.6 and 101.1 ms.
The checkout's path changes character counts, not these process counts.

## Decision

Both counters gate: ceiling = measured value, tolerance 0. Every other counter stays a candidate with a `darwin-arm64`
baseline. No counter was promoted on stability alone.

## Limits

- One machine. A Linux runner may count differently; its baseline comes from Linux reports, not from these.
- The correlation is per scenario and per extra Git process; it does not say how much of a real user's wait the Git
  calls are. The daily journal (`GET /api/c/:n/changes` in `npm run perf:report`) answers that after real use.
