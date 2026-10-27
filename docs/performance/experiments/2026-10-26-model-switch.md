# Same-account native model switching

Follow-up: [2026-10-27 full verification](2026-10-27-model-switch-verification.md) closes the image-fixture and ledger
blockers recorded below. It also adds native browser verification; this file preserves the original measurements.

## Question and authority

The model picker waits seconds for `POST configure`. Can an already-ready, idle native session switch in under
100 ms without an optimistic UI update? The user explicitly approved controlled same-account process reuse, while
retaining per-execution payer/model binding, token invalidation, permission checks and unknown outcomes. No service,
real account, deployment or push was authorized or used. Work is isolated on `perf/model-switch-latency` from `5bde0dd`.

## Measurement

Measurement-only commits: `adf28f9` adds cold/warm HTTP scenarios and candidates; `1bc0cba` adds the following
operation so deferred work remains visible. Before publication, the branch was rebased to omit the unrelated,
unpublished journal-note commit `5bde0dd`. The published measurement equivalents are `9437770` and `2ccde05`;
production code, tests and measurement fixtures are byte-identical. Original local hashes below identify the recorded
runs; use the published equivalents to reproduce them from a fresh clone. The same fixtures run in
`test/perf/scenarios.ts` and the focused runner.
Fresh sample processes, canonical fixed-length disposable checkouts, synthetic account, real pinned rotom 0.1.26,
Node 24.18.0, darwin-arm64, 8 cores. No inference in these scenarios. Windows include HTTP completion, handled receipt
and model projection checks; counters continue through the normal 400 ms quiet interval. Native inference is tested
separately by `test/model-switch-proof.ts` and `test/native-commands-proof.ts`.

```sh
node .agents/skills/rotom-team-performance-climb/scripts/timing-run.mjs base -- \
  node test/perf/model-switch-measure.ts /tmp/model-switch-base-quiet.json 5 9437770
node .agents/skills/rotom-team-performance-climb/scripts/timing-run.mjs head -- \
  node test/perf/model-switch-measure.ts /tmp/model-switch-final.json 5
npm run perf:compare -- /tmp/model-switch-base-quiet.json /tmp/model-switch-final.json
```

Earlier diagnostic runs are not the final timing baseline. The initial lock was occupied by another performance
experiment and was respected. Some early baseline samples had high load; they supplied counter observations only.

## Experiments and decision

1. **Reuse process but reload all resources during the switch. Rejected.** Five observed warm switches had a median
   of 965.9 ms (891.3–1170.3 ms), still above the target. Starts fell from one to zero, but resource loading remained
   on the waiting path. This was not an L2 comparison against the loaded early baseline.
2. **Rotate the gate, update native catalog/model now, reload resources before the next non-switch operation. Keep.**
   `set_model`, thinking selection and final native model readback complete before returning success. The next
   operation reloads startup-captured extension configuration before dispatch. Consecutive switches coalesce that
   reload. Account/provider/API changes and a process that is not ready still use the cold path.

### Final paired observations

| Scenario             | Base samples (ms)                      | Final samples (ms)                     | Median base → final | Comparison        |
| -------------------- | -------------------------------------- | -------------------------------------- | ------------------- | ----------------- |
| Cold switch          | 8102.8, 2568, 2588.4, 2371.2, 2482.6   | 8473.3, 2531.1, 2460.1, 2393.2, 2358.3 | 2568 → 2460.1       | noise             |
| Ready-process switch | 2203.9, 2519.4, 2219.2, 2148.1, 2123.6 | 63, 54.1, 50.7, 59.9, 59               | 2203.9 → 59         | faster, −97%      |
| Following operation  | 55.9, 59.6, 86.7, 92.9, 97.1           | 794.8, 864.3, 788.6, 751.2, 739.3      | 86.7 → 788.6        | slower, +701.9 ms |

Load (one minute): base 3.159 → 4.277; final 5.527 → 4.110, 8 cores. Both are below the unchanged high-load rule.
The timing wrapper reports `highLoad: false`. L1 and L2 are reached for ready-process selection, not L3.
The comparison exits nonzero because the following operation is slower: this is an explicit trade-off, not a clean
all-path speedup. The median of each sample's switch-plus-next-operation sum is 2259.8 → 839.3 ms. This sum excludes
between-scenario quiet waits, and is not browser latency.

### Where the work went

| Work counter, ready-process switch | Base   | Final  | Explanation                                           |
| ---------------------------------- | ------ | ------ | ----------------------------------------------------- |
| Native process starts              | 1      | 0      | Process startup/import/initialization is not repeated |
| Parent synchronous file reads      | 48     | 23     | Fewer native pin/resolver/settings reads              |
| Parent synchronous bytes read      | 298056 | 148720 | Same removed startup reads                            |
| SQL statements                     | 70     | 67     | No replacement-process startup thinking lookup        |
| JSON parses                        | 107    | 59     | Pin/resolver/settings/RPC work reduced                |

All increases in the focused comparison are accounted for:

- Cold switch JSON parse characters rise by 306 in total and the nativeReadback/nativeRpc/nativeRpcRecord views of
  the same data. Native command discovery includes the new private authorization-rotation command. These are
  overlapping instrumentation views, not four independent payloads.
- The following operation performs the deferred reload and barrier. Notify records rise 1 → 2; JSON parses 63 → 71;
  total/nativeReadback/nativeRpc parsed characters rise by 1362; native RPC records rise 4 → 11 and 1272 characters;
  notify parses rise 1 → 2 and 90 characters; stringified characters rise by 360. It starts no new process.
- Resource reload, extension initialization and possible MCP reconnects were moved, not removed. They must happen
  before the next non-switch operation because SoL-Pi and other extensions capture their model at startup.

## Correctness and safety

- `test/model-switch-proof.ts`: passed with real native history/model changes, same PID/session, old-token rejection
  during an active new-model inference, wrong-model rejection with the current token, actual model-B inference,
  busy/foreign-member refusal, idempotent/conflicting IDs, cycles, and injected model-select failure staying unknown.
- Negative control: the same proof against `adf28f9` fails at “no process startup or resource reload during switch”.
- The proof exposed a reload defect: `rotom-skills.mjs` prepared resources without the payer model, removing the derived
  SoL-Pi config. Reload now obtains the current model from the parent gate file. The proof requires the new auxiliary
  model configuration before inference; it does not replace this with a visual label.
- `node test/native-commands-proof.ts`: passed, 19 loopback inferences. Covers model/thinking/payer, compaction, native
  history, handoff, recovery and unknown fences. No real accounts.
- `npm run format`, `npm run check`, `npm run lint`: passed. `npm test`: 723 passed, 0 failed/skipped.
  The machine sets `NODE_USE_ENV_PROXY=1` without NO_PROXY. The first full test attempt stalled on local HTTP and was
  stopped. Setting `NO_PROXY` and `no_proxy` to `127.0.0.1,localhost,::1` makes local fixtures direct; the event-compression
  suite and then the unmodified full test suite passed. No assertions/timeouts were weakened.

## Ledger and broader comparison limits

The new candidates were registered from two measurements and the ledger guard passed. No candidate was promoted,
no ceiling/baseline/tolerance was raised, and no gate was removed.

`perf:ci -- origin/main --runs 1` completed with gating counters and ledger guard passing; its high-load timings are
not L2 evidence. That remote-tracking baseline is 105 commits behind the first measurement commit, so its many
non-model deltas also include pre-existing branch work and cannot be attributed to this optimization.

An immediate-base `perf:ci -- 1bc0cba --runs 1` was also attempted. The head run stopped in the untouched image fixture
at `test/perf/images.ts:175` (“unfinished/aborted image phases are unavailable, not zero”), before the appended model
scenarios. A complete immediate-base all-scenario comparison is therefore unavailable; the focused comparison above
isolates this change. The original checkout already has a separate pending image-measurement repair; it was not copied
into this branch or weakened to make the run pass.

`perf:propose -- /tmp/model-switch-final.json --write` refused because the focused report correctly marks the two
unrelated Git gating scenarios unavailable. No ledger tightening was applied. Follow-up: after the independent image
fixture repair is integrated, run the full immediate-base comparison and `perf:propose`, then guard the tightening.
Do not fabricate Git observations by combining unrelated runs.

## Limits and handoff

Only a ready, idle process on the same member/account/provider/model API has the measured millisecond switch. Cold
starts still take seconds. The next operation pays about 0.7 seconds more for reload in this fixture. Real ChatGPT/Qoder
accounts, long/complex native sessions, browser click-to-paint and production L3 are not verified. The running service
was not restarted or changed. Push and deployment require the user's decision; deployment should follow integration
with the existing work on the source branch and the normal release verification.

Local raw evidence: `/tmp/model-switch-{base-quiet,final}.json`, `/tmp/model-switch-final-compare.log`,
`/tmp/model-switch-proof-final.log`, `/tmp/model-switch-negative-control.log`, `/tmp/model-native-proof.log`,
`/tmp/model-tests-local.log`, `/tmp/model-switch-ci/`, `/tmp/model-switch-local-ci.log`.
Further speed work is triggered if the real ready-process path exceeds 100 ms or the following-operation cost is
unacceptable; first measure project extensions/MCP and native reload phases without relaxing the gate.
