# Register Git diff measurement

Measurement-only change before Git metadata batching. No production code changes.

Added `git.diff`: authenticated GET of the tracked `src/file-0.txt` diff in the existing 20-file workload. Assert HTTP
200, exact diff header, removed original line and added new line. Existing scenarios, counter windows, assertions,
fixture pacing and quiet rules are unchanged. Four direct Changes tests establish pre-optimisation behavior for
external commits/checkout, detached and unborn HEAD, scoped/newline/tab paths, linked worktrees and outside-Git errors.

Two five-run reports at different times on macOS arm64 / Apple M1 eight cores / Node 24.18.0, current dirty tree copied
into temporary checkouts:

| Report                       | Git changes processes | Git diff processes | Load before → after | Timing evidence                                |
| ---------------------------- | --------------------: | -----------------: | ------------------- | ---------------------------------------------- |
| `/tmp/rt-phase1-base-a.json` |           5 every run |        4 every run | 8.69 → 24.03        | `highLoad: true`, unavailable for speed claims |
| `/tmp/rt-phase1-base-b.json` |           5 every run |        4 every run | 18.85 → 12.73       | `highLoad: true`, unavailable for speed claims |

Both were run under the timing lock with `npm run perf:measure -- --runs 5`. Diff response is 1,195 bytes every run.
No SQL or JSON parsing occurs in the diff window. Occasional unrelated stringify work is retained (candidate spread
34), not filtered out. Register added eight `git.diff` candidate metrics from the two reports; no existing baseline,
ceiling, status or tolerance was raised. Ledger guard passed; `perf:check` on base-b passed existing gates and reported
23 existing candidate warnings. Those are not attributed to the measurement addition or silently reset.

`node --test test/changes-metadata.test.ts`: 4 passed before optimisation. `node --test test/perf-ratchet.test.ts`:
7 passed. Targeted ESLint passed. These fixtures are local and synthetic; no account, service or live journal was used.
No before/after speedup (L2) or real-use improvement (L3) is claimed.
