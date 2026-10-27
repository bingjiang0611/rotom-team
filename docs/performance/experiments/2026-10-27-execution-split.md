# Native execution file split: prerequisite, not a speed claim

## Decision and scope

The user asked to continue the model-switch performance climb. Current main introduced a staged-blob limit of
20,000 bytes per changed file. Integrating the older model-switch branch would immediately modify multiple oversized
files. The user chose **split files first**, rather than a one-off hook bypass.

The uncommitted integration was aborted. This change starts from main `c379bb7cfb57` on
`refactor/native-execution-modules`; it only splits the existing native executor. The earlier millisecond model-switch
implementation remains on `perf/model-switch-latency` at `21bd757`, untouched. This prerequisite does not merge it,
change the current model gate or claim a new latency improvement. The running service, real accounts and production
data were not accessed. No hook exception was used.

## Ownership and file budget

`src/server/rotom-executions.ts` was 76,716 bytes. It is now a 16,647-byte public facade and run owner. All changed
production files fit the unchanged 20,000-byte limit after formatting:

| File under `src/server/`            | Bytes | Responsibility                                                                                                                      |
| ----------------------------------- | ----: | ----------------------------------------------------------------------------------------------------------------------------------- |
| `rotom-executions.ts`               | 16647 | Public API/exports, journal construction, active-run registry, tracking/performance boundary, Stop/thinking/queue/dialog operations |
| `rotom-executions/contracts.ts`     |  4415 | Existing public auth/context/hooks and internal execution data types                                                                |
| `rotom-executions/native-prompt.ts` |  5964 | Native input identity/parsing, Goal branch state and prompt phase calculations                                                      |
| `rotom-executions/history.ts`       |  9793 | Handoff, fork/clone/import and durable seed materialization                                                                         |
| `rotom-executions/processes.ts`     | 17551 | Concrete retained-process owner: gate, launch, warm starts/timers and proven closure                                                |
| `rotom-executions/execute.ts`       | 19144 | Admission/reservation, observers, final native readback, journal settlement and unknown-safe cleanup                                |
| `rotom-executions/dispatch.ts`      |  7080 | Native command adapters and Goal-owned completion                                                                                   |

Public type/value exports stay at the existing import path. Callers and the native-tail memory probe keep their
paths. The process owner holds the same running-map reference; the gate holds the same live active-attempt latch.
There is no registry, implementation interface, mixin, prototype mutation, worker, cache or asynchronous warm queue
added for the split. Extracted implementation modules do not import the public facade.

Lifecycle invariants retained:

- Admission still authorizes, checks the observed head, reserves atomically, and checks Stop before dispatch.
- Every gate inference still checks the current active receipt, then rechecks Stop and the active latch after
  authorization. No new await follows that last check before admission.
- Usage writes drain before settlement; unknown child closure retains the active run and writer lease.
- Warm starts publish before yielding, requests wait for pending starts, and retirement removes the process before
  awaiting closure. Public close still refuses while executions are active.
- History operations remain inside the existing tracked callback. The 8 MiB seed-worker boundary is unchanged.
- Native adapters return the existing disposition; their extracted Goal completion reads extension errors through a
  getter, not a stale snapshot. Thinking changes, queued commands and native snapshots retain their checks.

The code has modestly more declarations/imports and explicit delegation, not fewer runtime operations. File splitting
is not itself L1 work reduction. No L2/L3 speedup is claimed and the ledger was not tightened from incidental changes.

## Verification

Node 24.18.0, darwin-arm64, 8 cores, pinned rotom 0.1.26. Test and proof HTTP uses loopback fixtures only, with
`NO_PROXY` and `no_proxy` set to `127.0.0.1,localhost,::1` so the host proxy does not intercept local test servers.

| Check                                                                   | Result                                                                                                                                                      |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`, `npm run lint`, `npm run format`                       | Passed                                                                                                                                                      |
| Focused lifecycle/seed/storage/commands/snapshot/room/native-tail tests | 108 passed                                                                                                                                                  |
| Full `npm test`                                                         | 724 passed, 0 failed/skipped; 256029 ms                                                                                                                     |
| `node test/native-commands-proof.ts`                                    | Passed, 19 loopback inferences: model/thinking/payer, command effects, handoff/history, compaction, unknown/restart fences                                  |
| `node test/team-kernel-proof.ts`                                        | Passed, 85 loopback requests: admission/head/permission races, subagent gate/Stop, account generations, fixed payer, fork/history, attachments and recovery |
| Independent read-only review                                            | No blocking findings; separately checked type/lint/format and 36 focused tests                                                                              |
| Structural source audit                                                 | 37 method/helper body comparisons matched after explicit owner/name substitutions, dispatch return extraction and close-guard delegation                    |
| Actual staged-file-size check                                           | Passed; unchanged hook, no bypass                                                                                                                           |

The structural audit is supplementary, not proof that all async scheduling is identical. It parses old/new source,
compares syntax-leaf tokens while ignoring comments/formatting/trailing commas, and separately checks the dispatch,
Goal and close-guard extraction. The initial raw scanner was unsuitable for template literals and was replaced by
parser-owned syntax tokens before drawing conclusions. The runtime tests and proofs above remain the acceptance
checks. The script and log are `/tmp/verify-execution-split.mjs` and `/tmp/execution-split-token-audit.log`.

## Performance checks and increases

Two locked three-pair CI comparisons used the **unchanged current instrument**, identical fixed-length disposable
checkouts and main production baseline. Both completed all 41 scenarios / 1,758 observations, with zero unavailable
observations. All gates and ledger guards pass. The Git subprocess gates remain exactly 3 and 2 in every sample.
No workload, assertions, measurement windows, quiet rule, threshold, tolerance or ledger entry changed.

```sh
node .agents/skills/rotom-team-performance-climb/scripts/timing-run.mjs execution-split -- \
  npm run perf:ci -- origin/main --runs 3 --out /tmp/execution-split-perf
node .agents/skills/rotom-team-performance-climb/scripts/timing-run.mjs execution-split-confirm -- \
  npm run perf:ci -- c379bb7 --runs 3 --out /tmp/execution-split-perf-confirm
```

First wrapper: 647144 ms, load 5.24 → 5.14, `highLoad:false`. Confirmation: 635078 ms, load 5.37 → 4.56,
`highLoad:false`. The reports capture their own post-checkout load; both remain below eight cores. Full source hashes,
report hashes, counter samples and all non-noise timing verdicts are retained in
[2026-10-27-execution-split.json](2026-10-27-execution-split.json).

Every increased work counter is recorded:

1. First run: `projection.large.open/json.stringify.chars` worst sample 182042 → 182076 (+34);
   `image.concurrent/json.stringify.chars` 1396 → 1464 (+68). A separate diagnostic pair instrumented serialization
   **only in disposable checkouts**, without changing the official reports. It captured the existing room branch-head
   timer serializing `{"branch":"main"}` (17 characters) at `room.ts:329`. In that pair, projection had 2 → 6 timer calls
   (34 → 102 characters); image retrieval had 0 → 4 calls (0 → 68 characters). Subtracting those timer strings gives
   identical serialization totals on both sides: 181974 for projection and 1396 for image retrieval. This attributes
   the reproduced variation to unchanged periodic work crossing the scenario window; it does not reconstruct every
   lost field of the original samples. No timer was suppressed, rescheduled or excluded. These two increases do not
   recur as worse in the confirmation. The diagnostic instrument is not timing evidence; its checkouts were removed.
2. Confirmation: `web.send.poll/cdp.LayoutCount` 18 → 19 worst sample. Samples are base `[18,18,18]`, head `[19,18,18]`.
   There is one extra browser layout in one sample, not a repeated increase across all head samples. No Web source or
   CDP workload changed. The counter does not include a layout-cause trace, so no exact cause is asserted or hidden
   by widening tolerance. If this is to gate the refactor, capture browser layout reasons in a separate measurement
   change before promoting the candidate. The existing candidate and its limitation are retained.

Timing verdicts are not silently treated as parity. `git.branches/ms` is slower in both comparisons: medians
64.3 → 98.2 ms, then 58.1 → 70.2 ms. It does the same two Git subprocesses; Git route and workspace code are unchanged.
There is no demonstrated additional execution work on this route, but the latency signal is real in these samples;
these measurements do not establish its OS/scheduling cause. Do not report universal latency parity.

First-run `web.paced/scriptMs` (15.8 → 23.0) and `taskMs` (44.2 → 55.0) do not repeat as slower. Confirmation flags
`image.single/imageSendFinishMs` 2.8 → 3.7 ms. Both increases and the faster/noise phase samples remain in the JSON.
A refactor has no justified speed claim from the faster incidental samples. Before making a speed-sensitive acceptance
claim for the flagged routes, the concrete next investigation is to capture per-Git-child wait time and browser
layout/phase causes; this prerequisite only passes the existing work gates and correctness suite.

## Final scope and next action

This completes the native-executor file split, not every pre-existing oversized file in the repository. Other files
were not mechanically split merely to integrate old documentation or benchmark history. The performance ledger is
unchanged. This branch intentionally has no new millisecond model-switch behavior; the prior verified implementation
remains separately available on `perf/model-switch-latency`.

Next climb: port that same-account model epoch/authorization rotation onto the new process owner and execute modules,
then measure its next-operation native reload against the explicit following-operation scenario. Any large file that
actually needs modification must satisfy the same file budget; no general size exception has been introduced.
This session has reached the three-experiment limit (two full comparisons and one serialization diagnostic), so no
further timing experiment is silently added. The next session should first attribute the repeated Git branch latency
signal before claiming speed parity or resuming reload optimization. Publishing this new refactor branch and deployment
require owner approval. No service restart or deployment occurred.
Raw evidence remains under `/tmp/execution-split-*.log` and the two report directories listed above; test artifacts are
isolated temporary data, not production data.
