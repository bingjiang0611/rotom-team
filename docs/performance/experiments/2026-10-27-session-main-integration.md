# Integrate the complete model-switch session into main

## Scope and merge decisions

The owner requested all session changes on main, including the retained-process model switch, measurement/tests,
executor splitting, investigations and the native dynamic-update **proposal**. No proposed native capability is
implemented or enabled by this merge. No service restart, deployment or real account was authorized or performed.

Main advanced to `aa2ac945e8b4` during coordination. Its committed send-correlation work already included a different
responsibility split of the executor and bounded performance modules/ledger. The main working tree was clean before
integration; its previously staged work had been committed and pushed by its owner. Integration used the separate
`integration/session-model-switch` worktree, not those files or their staging area.

- Merge `bcc753c` through `e6c1fff`, preserving all reports/proposal. Resolve the overlapping `710b0d3` split in favor
  of main's equivalent ownership modules, rather than keeping two executors or losing send tracing.
- Merge `21bd757` and its separate historical measurement/optimization commits. Port the actual model-rebind behavior
  into main's `contracts.ts`, `launch.ts`, `run.ts` and a cohesive `model-preflight.ts`. Preserve `operations.ts`,
  lifecycle/error handling and reserved/dispatch trace boundaries.
- Keep account/provider/API-incompatible transitions on process retirement. Rotate gate tokens/identity epochs;
  snapshot identity across body/authorization awaits. Require actual native model readback before settlement.
- Keep a full reload before the following non-switch operation. A successful switch's revision update must not erase
  pending resource work. Explicit `/reload` now performs exactly one reload and clears pending work only after its
  operation returns through normal barrier/error checks. This fixes the previously documented redundant case.
- Preserve current main's image-finish measurement repair, sharded ledger and all existing keys/status/metadata/
  tolerances. Add the 138 historical model metrics; where both branches have baselines, retain the smaller value.
  This carries 105 additional tightened platform values without loosening a gate or a newer main baseline.
- Keep main's more complete D9b measurement note. Drop the old branch's comment-only journal change rather than
  modifying a 64 KiB stored-data module for an equivalent comment. No journal/schema behavior is lost.

The new main layout supersedes historical file-layout descriptions, not their dated validation scope. The native
proposal's module references and integration status were updated; it remains design only.

## File budget and preservation

No hook bypass or size exception. All staged blobs are at most 20,000 bytes after formatting.

The native policy needed room for the approved rebind adapter. Extract four pure context projection functions into
`rotom-context-view.mjs`; keep the SnapshotStore, capture registration and lifecycle cleanup in the policy. Independent
syntax-leaf comparison against `21bd757` matched all four bodies after the explicit snapshot/filter parameters.
Native context and UI proofs independently exercise the resulting projection.

Split CONFIGURATION by responsibility into `CONFIGURATION-NATIVE.md` and `CONFIGURATION-SESSIONS.md`, retaining the
original headings/anchors with links in the root. Reconstructing the three-way merged configuration proved all 20
section bodies preserved modulo formatting, including main's D9c contract and the model-switch update.

The historical verification JSON exceeded the limit. Its schema-2 summary now references web/other fragments and an
ordered key list. Reconstructing it and restoring schema 1 exactly matches every original field and all 89 counter
records at `21bd757`; original report hashes are unchanged. No result was discarded to fit the limit.

## Current verification

Node 24.18.0, darwin-arm64, pinned native rotom 0.1.26. Local HTTP tests bypass the host proxy via
`NO_PROXY=no_proxy=127.0.0.1,localhost,::1` (both variables are assigned separately). All providers/data are synthetic.

| Check                                                       | Result                                                                                                                                                               |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`, `npm run lint`, `npm run format:check`     | Passed                                                                                                                                                               |
| Full `npm test`                                             | **747 passed**, 0 failed/skipped                                                                                                                                     |
| Focused model/preflight/error/image/docs tests              | 13 passed                                                                                                                                                            |
| `node test/model-switch-proof.ts`                           | Actual model/history/PID, token rotation/denial, next-operation auxiliary reload, one explicit reload, busy/foreign rejection, replay/conflict/unknown fences passed |
| `node test/native-commands-proof.ts`                        | Passed: 19 loopback inferences, including context usage/injections and native command effects                                                                        |
| `node test/team-kernel-proof.ts`                            | Passed: native admission/ownership/history/subagent/Stop/account/payer coverage                                                                                      |
| `node test/native-commands-proof.ts --ui`                   | Passed: 29 loopback inferences; real Chromium desktop/mobile context, model picker/handoff, sidebar model refresh and unknown/failure projection                     |
| Independent read-only integration review                    | No blocking defects; no tests claimed by the reviewer                                                                                                                |
| Explicit-reload sensitivity control                         | Removing the preflight exclusion in an isolated copied helper makes the no-preflight-reload assertion fail; production source unchanged                              |
| Configuration / historical JSON / context extraction audits | 20 sections, 89 records and 4 function bodies preserved                                                                                                              |
| Ledger monotonic guard / staged size / diff checks          | Passed, no exceptions or threshold relaxation                                                                                                                        |

The authorization snapshot/recheck is reviewed and token rejection is exercised. The current proof does not separately
hold an authorization request across epoch rotation; no claim of that specific delayed-race experiment is made.
No real account, physical device or production service is covered by these fixtures.

## Performance on the integrated production code

```sh
node .agents/skills/rotom-team-performance-climb/scripts/timing-run.mjs session-model-main-integration -- \
  npm run perf:ci -- aa2ac94 --runs 3 --out /tmp/session-merge-perf
```

Three alternating base/head pairs, same current instrument on both revisions, equal-length disposable checkouts.
**46 scenarios / 1,968 observations, zero unavailable observations. Ratchet and ledger guard passed.** Both Git process
gates remain 2 and 3 in every sample. No workload/window/quiet-rule changes, paid probes or skipped assertions.
Wrapper exit 0; 762613 ms; 8 cores; load 3.83 → 4.05, `highLoad:false`. Reports identify base `aa2ac945e8b4` and candidate
`e6c1fff7cdb4-dirty`; recorded source hashes bind that candidate to the integrated code, independently of later doc commits.

| Scenario              | Main median ms | Integrated median ms | Interpretation                                                     |
| --------------------- | -------------: | -------------------: | ------------------------------------------------------------------ |
| Cold model switch     |         1725.4 |               1853.1 | Comparison noise; process startup remains, no cold speedup claimed |
| Retained model switch |         1754.2 |             **67.9** | Faster; real native application/readback, not optimistic UI        |
| Following operation   |           84.2 |            **814.1** | Required full reload is deferred, not removed                      |

Retained switch L1 work: native starts 1 → 0; parent file reads 48 → 23; SQL statements 70 → 67; JSON parses 107 → 59.
This reaches L1 and low-load L2 for retained selection only, not L3 production acceptance or universal latency parity.

Every increased work counter is retained with base/head samples in
[session counter increases](2026-10-27-session-main-counter-increases.json), with summaries/source hashes in
[integration evidence](2026-10-27-session-main-integration.json). All 65 are nongating:

- **33 catalog-related character counters:** 31 increase by exactly 306 characters, from the added private rebind
  command in native catalog/readback; the same approved cost was measured on the older branch. Two projection totals
  increase by 310/318 rather than 306. Their additional 4/12 characters are not attributable to an exact field from
  aggregate reports; no extra parse call is established for those two residuals. Do not invent a field-level cause.
- **12 following-operation counters:** the retained full reload/barrier adds 8 JSON parses, 1,362 total/RPC/readback
  characters, 7 record parses, one notification and 360 stringified characters. This is the explicit latency trade-off;
  it starts no native process. Overlapping scope counters are not separate work to add together.
- **18 paced-Web counters:** view pushes are base `[11,11,11]`, head `[12,12,11]`. The extra projection accounts for
  the additional view SQL/parse/field serialization, delivered event and browser apply in those samples. This paced
  workload races the unchanged 90 ms coalescing boundary; it is not evidence of a new per-view query. All sample data
  are retained rather than suppressing an event or changing a tolerance.
- **2 browser-allocation counters:** poll layout samples `[18,18,18]` → `[18,19,18]`; CDP node samples
  `[1605,1605,1607]` → `[1606,1632,1628]`. These are observed layout/allocation increases, not proven zero. Web source and
  transport workload are unchanged by this merge; no allocation-cause trace was collected. Exact cause remains
  unverified and no Web speed/parity claim is made. A separate browser allocation trace is the next action if these
  candidates are to gate acceptance; they were not weakened here.

Other timing verdicts are retained in the JSON. The only non-model slower verdict is image decode 0.2 → 0.3 ms; this
is not claimed as a measured improvement or proof of a decode regression. Historical Git lifecycle attribution limits
remain in the round-2 report; this run does not replace them with an unsupported OS-level explanation.

## Final delivery scope

The intended merge contains all session branch ancestry while retaining current main's independently delivered
changes. The new native dynamic-selector/capability API remains **unimplemented**; do not describe the following
814 ms reload as eliminated. No pinned runtime, credentials, production data or launchd service was changed.

Raw logs/reports and the isolated negative helper remain under `/tmp/session-merge-*`; disposable performance
checkouts are removed by CI. Validation ran on the integrated source before final merge publication. Main publication
and exact resulting ancestry/remote hash are checked separately at delivery, not inferred from this report.
