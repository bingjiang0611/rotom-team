---
name: rotom-team-performance-climb
description: Maintain rotom team's performance loop. Use to find where people wait from the server's daily performance journal; answer "what is slow, where is the biggest win, what next"; climb a work counter or a millisecond number down; check a change before and after; or maintain the work-counter ledger (register, tighten, promote, Linux baselines). Not for features or bugs unrelated to speed, deployments, or anything needing real model accounts.
---

# Performance climb

The loop is described in [docs/PERFORMANCE.md](../../../docs/PERFORMANCE.md): read its Terms and Rules first. Three
modes; pick the one the request needs.

| Mode     | Question                          | Evidence it produces                        |
| -------- | --------------------------------- | ------------------------------------------- |
| Analyse  | where do people wait?             | ranked leads from the journal (L3 data)     |
| Climb    | make one thing do less work       | counters down (L1), milliseconds down (L2)  |
| Maintain | keep the ledger honest and useful | registered, tightened, or promoted counters |

## What you may do alone, and what needs the user

| Action                                                                                     | Alone?      |
| ------------------------------------------------------------------------------------------ | ----------- |
| Run benchmarks, tests, `perf:check`, `perf:compare`, `perf:ci`; read code                  | yes         |
| Snapshot and analyse the journal (read only: copy first, never edit or delete it)          | yes         |
| Change code to do less work, in a branch, with tests; tighten (`perf:propose --write`)     | yes         |
| Register new candidates; add a counter or scenario (a separate measurement commit)         | yes         |
| Promote a candidate to gating (needs the three pieces of evidence)                         | ask         |
| Raise a ceiling or baseline, widen a tolerance, demote or remove a counter                 | ask         |
| Change the journal's records, retention, or what it collects                               | ask         |
| Restart, upgrade, or touch the running service or its data; push; open a PR                | ask         |
| Use a real model account; change credential routing, the native boundary, unknown outcomes | never alone |

## Analyse: where do people wait?

1. Snapshot, then report (never read the live files in place):
   `npm run perf:report -- snapshot <data-dir> /tmp/rt-journal-<date>` and
   `npm run perf:report -- report /tmp/rt-journal-<date> [--since …] [--release …]`.
2. Rank by total time (count × duration), not by the slowest single request. Also read: native runs by outcome, event
   loop p99 and longest stall (a stall delays every tab), pushed bytes per active minute.
3. For each lead, name the benchmark scenario that reproduces it, or say none does yet (then a new scenario is the
   first step). Groups under 30 samples are hints, not findings.
4. Write leads into [docs/performance/opportunities.md](../../../docs/performance/opportunities.md).

## Climb: one hypothesis at a time

1. Baseline on a quiet machine:
   `node .agents/skills/rotom-team-performance-climb/scripts/timing-run.mjs base -- npm run perf:measure -- --runs 5 --out /tmp/base.json`.
   Exit 75 means another timing run holds the lock: wait, do not bypass it.
2. Find the work behind the number: which counter moves with it? Follow the call chain to the code that does the work.
3. Change the code so the work is not done, done once, or done off the waiting path. Keep behaviour: freshness,
   errors, permissions, and unknown outcomes stay exactly as they were.
4. Measure the same way (`--out /tmp/head.json`), then `npm run perf:compare -- /tmp/base.json /tmp/head.json`, or
   `npm run perf:ci -- <base-ref>` for a committed change.
5. Keep it only with L1 (the counter went down) and, to claim "faster", L2 (`faster` in the comparison, with
   `highLoad: false`). Then `npm run perf:propose -- /tmp/head.json --write` and commit the ledger with the change.
6. Record the experiment in `docs/performance/experiments/<date>-<name>.md`: question, method, numbers, load, where
   the removed work went, decision, limits. Reverted ideas get a file too.

Stop rules: three attempts per hypothesis, then write it up and move on; at most three experiments (or about two
hours) per session; stop and report when a fix would need a decision from the "ask" rows.

## Maintain the ledger

- New scenario or counter: add it to `test/perf/workload.ts` (and the scenario to `scenarios.ts`) in a commit of its
  own, measure at two different times, `node test/perf/ratchet.ts register <a.json> <b.json> --write`.
- Promotion: stable (repeat runs agree), sensitive (a deliberate regression, such as `ROTOM_TEAM_PERF_INJECT=git`,
  moves it and `perf:check` fails), correlated (that regression costs milliseconds). Write the three into the entry's
  `evidence` and an experiment file, and ask before committing.
- A workload change means new keys. A Linux baseline comes from Linux reports. `guard` must pass on every ledger edit.

## Never game a number

- The removed work must have gone somewhere you can name: not done, done once, done later off the waiting path, or
  done in less. Moving it outside the counted window or process, or into a path the benchmark skips, is not a win.
- Do not change the workload, the counters, or the quiet rule to make a number smaller; do not add sleeps, retries,
  skips, or wider timeouts; do not weaken assertions.
- Measurement changes and optimisations are separate commits. Unmeasured is `unavailable`, never zero.
- Report the level you reached (L1, L2, L3) and do not let a lower one stand in for a higher one.

## Known facts that save time

- Milliseconds on a loaded machine are not evidence; the counters are stable across load.
- `turn.paced` push counts race the 90 ms coalescing and can move with timing; prefer `turn.warm` for push bytes.
- `web.open` leaves JSON counts out: the DevTools connection driving Chromium parses JSON in the same process.
- The suite's known flake (before this loop): "a drop-in that is on gives Pi its tools and hooks" can time out under
  load and passes alone.

## Report to the user

Short sentences. Separate measured facts from guesses. Include: leads or changes with their numbers and load, the
level reached, where the removed work went, what was not verified, and only the decisions that are truly theirs.
