# Model switching: full verification after image measurement repair

## Outcome

The previously blocked immediate-base performance comparison is complete. All 44 scenarios and 1,896 observations
were measured in three base/head pairs; no observation is unavailable. Gating and ledger guard pass. The ready-process
model switch is L1/L2 faster, with median HTTP/native completion 2132.8 → 60.3 ms. This does not claim production L3 or
sub-100-ms browser click-to-paint.

The explicit trade-off remains: the next non-switch operation reloads native resources before dispatch, and its median
rises from 81.1 to 780.4 ms. Cold switching remains about two seconds. The verification does not turn these slower paths
into a claim that everything became faster.

## Artifact and method

- Base: `2ccde05d8875`, measurement commits before model-switch optimization.
- Head: `9edad43879c4`, optimization plus the independently reviewed image completion probe repair.
- The repair was cherry-picked from `c59b1c7`. Its four files are measurement/tests/documentation only. No other source
  branch work or uncommitted changes were included. Production files remain byte-identical to `a5d4e77`.
- `checkout.ts` installs the **same corrected instrument on both sides**. PNGs, concurrency, workload, quiet window,
  assertions and gate thresholds were not changed. Waiting for response finish is inside the measured window; aborted
  responses still fail rather than becoming zero.
- Node 24.18.0, darwin-arm64, 8 cores, pinned native rotom 0.1.26; synthetic accounts and loopback inference only.
- The timing lock was held for the whole pair run. Tests were queued until it released, rather than run concurrently.
  The wrapper reports `highLoad:false`, 670410 ms, one-minute load 4.94 → 3.28. The reports capture load after checkout
  setup: 5.300 → 3.284, also below eight cores.
- Local HTTP tests bypass the machine's configured proxy with `NO_PROXY` and `no_proxy` set to
  `127.0.0.1,localhost,::1`. No product configuration, retry or timeout was changed.

```sh
NO_PROXY=127.0.0.1,localhost,::1 no_proxy=127.0.0.1,localhost,::1 \
  node .agents/skills/rotom-team-performance-climb/scripts/timing-run.mjs model-switch-verification-20261027 -- \
  npm run perf:ci -- 2ccde05 --runs 3 --out /tmp/model-verify-20261027-ci
npm run perf:propose -- /tmp/model-verify-20261027-ci/head.json --write
node test/perf/ratchet.ts guard /tmp/model-verify-20261027-ledger-before.json test/perf/ledger.json
npm run perf:check -- /tmp/model-verify-20261027-ci/head.json
```

## Measurements

| Scenario                   | Base samples, ms       | Head samples, ms       | Median base → head | Comparison        |
| -------------------------- | ---------------------- | ---------------------- | ------------------ | ----------------- |
| Cold model switch          | 2127.4, 2082.6, 2077.7 | 2072.9, 2105.4, 1933.9 | 2082.6 → 2072.9    | noise             |
| Ready-process model switch | 2132.8, 2134.0, 2018.4 | 60.3, 63.7, 51.8       | 2132.8 → 60.3      | faster, −97.2%    |
| Following operation        | 85.9, 81.1, 80.2       | 780.4, 788.4, 716.2    | 81.1 → 780.4       | slower, +699.3 ms |

Ready-process work remains reduced: native starts 1 → 0, parent file reads 48 → 23, SQL statements 70 → 67,
JSON parses 107 → 59. Startup is removed from selection; extension reload is deferred, not removed. The following
operation is measured separately so its cost does not disappear from the report.

The only non-model timing classified slower is `turn.cold/nativeStartResourcesMs`, 59.1 → 73.3 ms. The corresponding
cold-turn file-read samples remain `[51,50,50]` on both sides; total cold-turn time is not classified slower. This phase
observation is retained, not claimed to be a new proven work regression or silently offset by the switching gain.

### Every increased work counter

The pre-tightening comparison labels 89 candidates worse by worst-sample value. The adjacent
[JSON evidence](2026-10-27-model-switch-verification.json) lists every key, base/head sample and delta. None is a gate.
They are accounted for as follows; overlapping parse views are not independent added payloads.

| Scope                                 | Keys | Evidence and interpretation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------- | ---: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Native command catalog byte counters  |   33 | The new private `team-kernel-rebind` command adds 306 characters to the native RPC catalog. Cold/warm/prepared turns, discovery, cold switching and paced projection read it. NativeReadback/nativeRpc/nativeRpcRecord and total parse counters overlap. Projection aggregate differences are 285/299 characters because their other readback sizes also vary; their RPC increment is exactly 306. No extra model call is introduced.                                                                              |
| Next-operation reload/barrier         |   12 | Required deferred work: +8 JSON parses, +1362 parsed characters in the total/RPC/readback views, +7 RPC records, +1 notification and +326 stringified characters. No additional native process. This is the measured latency trade-off above.                                                                                                                                                                                                                                                                      |
| Paced browser push/projection work    |   39 | `web.paced` view counts: base `[11,11,11]`, head `[12,11,11]`; `web.send.stream`: base `[24,24,24]`, head `[26,24,24]`. Only the first head sample sends extra coalesced views. The increased SQL, view projection, serialization and browser event/application counters accompany those views. The unchanged 90 ms coalescer is in `room.ts`; `turn.warm` view counts remain `[2,2,2]` on both sides. This is retained as sample-dependent work, not claimed as an improvement or hidden by increasing tolerance. |
| Small stored-JSON character variation |    4 | `session.open` total/durable characters increase by 5/3 only in head sample two; `git.changes` total/durable characters increase by 2 only in that sample. Other samples equal baseline and no corresponding query/parse-call increase is established. The aggregate reports do not retain the exact differing field, so no specific field-level cause is claimed.                                                                                                                                                 |
| Chromium node snapshot                |    1 | `web.open/cdp.Nodes`: base `[1114,1114,1114]`, head `[1114,1114,1138]`. This is the CDP snapshot taken immediately after first paint, before the quiet/warm waits (`test/perf/browser.ts`), not a settled DOM-tree assertion. No Web source changed. Two head samples equal baseline; the extra 24 nodes remain a recorded one-sample observation, not a proven stable DOM regression or a zero.                                                                                                                   |

The last two groups lack raw payload/DOM attribution. If they recur consistently, or an owner wants to promote these
candidates, the next action is a separate bounded payload/DOM measurement before promotion; this verification does not
assert an exact cause that its instruments cannot establish.

## Ledger

`perf:propose` now succeeds using the complete report. It lowers 137 darwin-arm64 candidate baselines: 32 model-scenario
entries and 105 existing entries. The diff changes **only baseline values**. No gating ceiling, tolerance, status or
workload is changed; no candidate is promoted. Guard passes with zero violations and the head report passes the updated
ratchet. The two existing Git gates stay at 3 and 2 subprocesses in every sample.

A lower recorded baseline is not automatically an optimization from this change. In particular, the full suite has
warmed parent-module caches before the appended cold-switch scenario; its cold counters should not be interpreted as
a speedup over earlier focused-run cold initialization. The paired full-suite cold result is noise. The warm-switch
process/file/SQL/parse reductions are the attributable improvement.

## Regression verification

| Check                                                   | Result                                                                                                                                                                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Image fixture and compatibility tests                   | 4 passed, including pending-finish and aborted-response controls                                                                                                                                       |
| `npm run check`, `npm run format:check`, `npm run lint` | Passed                                                                                                                                                                                                 |
| Full `npm test` with local proxy bypass                 | 723 passed, 0 failed/skipped; 240695 ms                                                                                                                                                                |
| `node test/model-switch-proof.ts`                       | Passed: native history/model, same PID, rotated gate, active old-token/wrong-model denial, auxiliary reload, busy/foreign refusal, duplicate/conflict and unknown fences                               |
| `node test/native-commands-proof.ts --ui`               | Passed, 29 loopback inferences; actual browser model picker handoff/cycle, sidebar updates without reload, thinking/draft handling, native settings, handoff/history/compaction and unknown/failure UI |
| Full paired performance CI                              | Three complete pairs, 44 scenarios, zero unavailable observations, gate and guard pass                                                                                                                 |
| Tightened ledger guard and `perf:check`                 | Passed; 137 lower candidate baselines, no relaxed gates                                                                                                                                                |

The UI proof reports `realAccounts:false`. It verifies real UI behavior against the isolated native fixture, not the
latency of the user's logged-in production browser. Its screenshots and report remain under
`/private/var/folders/gq/gr5v20ss57550_3x_vbk9tpw0000gn/T/pi-pocket-test-K06Vgx/native-commands/`.

## Evidence and remaining boundary

Durable selected measurements, all increased counters and full-report SHA-256 hashes are in
[2026-10-27-model-switch-verification.json](2026-10-27-model-switch-verification.json). Raw reports and logs remain at
`/tmp/model-verify-20261027-ci/` and `/tmp/model-verify-20261027-*.log`; the previous ledger snapshot is
`/tmp/model-verify-20261027-ledger-before.json`.

This closes the previous image-fixture and ledger-tightening blockers. The remaining boundary is release approval:
no deployment, service restart, real account use or production-data operation was performed. Same-account ready-process
latency is locally L1/L2 verified; cold/API/account changes, long/complex project resources and production L3 retain the
limits in the original experiment. Deployment and real-account acceptance require the user's authorization.
