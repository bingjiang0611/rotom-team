# Reuse roomState's exact session snapshot

First experiment in the sixth climb batch. Hypothesis: `TeamKernel.roomState` already performs a fresh synchronous
journal session read, while `#commandSnapshot` immediately repeats presence, head/session and binding decode. Pass the
first exact value into command-catalog validation in this one stack frame. Standalone `nativeCommands` calls keep their
own fresh existence/session reads.

## Safety and removed work

The reused object includes the exact segment and full `KernelBinding` decoded by `RotomJournal.session`; catalog
validation still requires exact member, segment and `JSON.stringify(binding)` equality. Per-viewer catalog isolation is
unchanged. Pending/unknown receipt, cutoff/resume, ready/live/dialog/status/widget/subagent and command invalidation
checks remain fresh and independent. No cross-call cache, credential sharing, model fallback, replay, protocol or
unknown-outcome change.

Native proof additions establish: Alice sees the exact catalog revision; Bob and a viewer do not; one `roomState` calls
journal `session` exactly once; a same-member/same-segment snapshot with a changed model fails full binding equality.
Removing the member predicate makes the existing proof fail (`dynamicReady true !== false`), log
`/tmp/rt-roomstate-member-control.log`. Removing session reuse makes the new count assertion fail (`2 !== 1`), log
`/tmp/rt-roomstate-no-reuse-control.log`. Positive proof log `/tmp/rt-roomstate-session-positive.log` passes without real
accounts.

## Base/head, five fresh runs each

macOS arm64 / Apple M1 eight cores / Node 24.18.0 / rotom 0.1.25. Base
`/tmp/rt-kernel-roomstate-b.json`, load 4.02→2.54; head `/tmp/rt-roomstate-session-head.json`, load 2.53→3.65.
Both timing locks `highLoad: false`.

| Scenario       | Kernel SQL statements |     Rows | JSON decodes |  Decoded chars |        Median duration |
| -------------- | --------------------: | -------: | -----------: | -------------: | ---------------------: |
| Four-tab open  |                140→98 |   112→70 |        42→28 |  22,722→15,148 |   50.2→50.2 ms (noise) |
| Four-tab paced |              424*→316 | 352*→244 |     140*→104 | 75,740*→56,264 | 875.7→879.5 ms (noise) |

`*` worst/common 36-push base; one base run coalesced 32 pushes. Head has 36 in all runs. Per kernel projection the
change removes three SQL statements, three returned rows, one binding parse and 541 decoded characters. At open that
is a 30–37.5% reduction; at paced worst/common it is 25–31%. Counts move across established scenario totals too;
`perf:propose` mechanically tightens those candidates, but only kernel-scoped reductions are credited here.

`perf:check`, propose and ledger guard pass. Type/lint, native proof and full final verification are recorded with the
batch close. Durations are noise: keep as **L1 only**, no L2/L3 claim.

## Next action

Measure the remaining `roomState` reads by subcomponent before changing them. The expected next candidates are pending
receipt (must remain fresh for unknown fencing) and cutoff (`latest` + `resume`). Prefer one SQL query that returns the
same complete state over a long-lived cache. Do not cache receipts or skip unresolved-input checks.
