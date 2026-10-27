# Performance opportunities

Leads for the climb, each with the evidence that raised it. A lead is a question, not a finding: confirm it with a
counter or the journal before changing code. Record each tried idea here with its outcome, kept or reverted, and link
its experiment file in `experiments/`.

Workload: `test/perf/workload.ts` as of 2026-10-16 (12 seeded turns of 6000-character answers). Numbers are the
`darwin-arm64` ledger baselines (worst of 10 runs from temporary checkouts) and benchmark medians, Apple M1, load below
the core count.

## Main integration and benchmark layout — 2026-10-27

Integrating the four send-measurement commits required splitting older oversized benchmark sources and the ledger.
The assembled 1,830 records, 43 workload definitions and 90 metric specs remain unchanged. New persistence/CLI and
scenario-order checks pass; the final full suite passes 743 tests. Both main and incoming-feature performance guards
pass with `highLoad:false`; this is not a speed claim. See the
[merge acceptance record](experiments/2026-10-27-main-integration.md).
Deployment and production sampling still need the owner's separate approval.

## Anonymous send correlation and bounded modules — 2026-10-27

Implemented correlation for native sends across six server milestones and exact browser request confirmation.
Opaque tags are process-local HMACs; raw request identity and message text do not enter the journal.
This is measurement, not a fix or attribution of the production 1.554 s median.

Responsibility extraction keeps every changed/new staged file below 20,000 bytes without weakening the hook.
Parent acceptance found and repaired stale lifecycle/error state, request-marker and JS linkage regressions.
A benchmark checkout bug omitted staged edits; fixed with a staged/unstaged/move/delete fixture and negative control.
Final acceptance: 725/725 tests; corrected performance comparisons with the immediate parent and main pass,
both `highLoad: false`. Module loading costs six extra requests and 3,640 gzip body bytes.
One pair per base and candidate/A/A variation do not establish an L2 or L3 gain.
See [experiment and complete worse-counter records](experiments/2026-10-27-send-correlation.md).

Next owner/action: the owner may approve deployment and read-only collection of new paired production records.
Until then, no production attribution, account action, restart, deployment or push is claimed.

## Send response-latency measurement — 2026-10-27

Added `web.send.poll.network` and `web.send.stream.network` after all established workloads, with Chromium CDP
response latency of 150 ms and throughput of 500,000 bytes/s each way. A paired no-store HTTP probe must observe
at least 120 ms added delay. Disabling that delay fails the probe (2.7 → 3.4 ms); restoring it passes.

Two three-run reports, both `highLoad: false`, observe approximately 168 ms submit responses. The application's
`send.shown` medians are **183.1 ms for poll** and **113.7 ms for stream**. The shaped stream displays confirmation before
the submit response in every run. Its reference-to-browser gap is inside clock uncertainty: CDP response latency
does **not** establish physical propagation latency on the ongoing stream. This fixture therefore cannot rule out
real transport delay, and it still does not reproduce the production 1.554 s median. The old/new histories differ;
do not treat their median differences as isolated network costs.

Kept as a measurement foundation: **72 new darwin-arm64 candidates**, no promotions or changes to existing ledger
entries. No production code changed; there is no new L1 reduction, L2 speed improvement, or L3 improvement claim.
See [the profile, controls, phase table and limits](experiments/2026-10-27-send-network-profiles.md).

Next owner: the coding agent, after approval to change journal collection, should define bounded, content-free
per-send phase correlation across submit, native admission/user-entry visibility, push receipt and confirmed display.
Deployment and real-account use remain separately gated. Do not reduce push coalescing or add a cache from this
fixture alone.

## Room append climb — 2026-10-26

**Kept at L1, not a speed claim.** `Room.#sequence` now reuses its existing immutable-prefix test before
construction and visits only newly appended source entries. Full/head-reset rebuilds, independent client deltas,
permissions and scheduling stay unchanged. Array copies and order-key joining still scale with history.
Five base/head runs agree: `view.entry.visits` is **8 → 2** for `turn.warm`, **19 → 2** for `turn.paced`,
**59 → 2** for `web.paced`, **65 → 3** for `web.send.poll`, **69 → 2** for `web.send.stream`, and **267 → 2**
for `projection.large.paced`. The last scenario retains 490 SQL statements and 44 view pushes in every run.
Only these six darwin-arm64 candidate baselines were tightened; guard and gating checks pass.

The loaded head run (`highLoad: true`, ending at 11.58 on 8 cores) cannot establish L2. The unchanged local
send fixture confirms a message in about 0.1 s, not the production median of 1.55 s. Next owner/action: the agent
should add a representative remote-send measurement before claiming that journal lead is fixed.
The full synthetic suite passes **725 tests**, with proxy variables removed for the test command only after the
unchanged baseline reproduced a proxy-related hang. No production change, account use or push.
See [the experiment and negative controls](experiments/2026-10-26-room-append-prefix.md),
[all worse counters](experiments/2026-10-26-room-append-counters.md), and the separate
[measurement repair](experiments/2026-10-26-image-finish-measurement.md).

## Journal refresh — 2026-10-26, 12:53 UTC

Read-only snapshot `/tmp/rt-journal-20261026T125348Z`: all four files parsed, **42,394 complete records, zero malformed lines**. The report was run for October 19 onward, separately for the deployed release, and for October 25 onward. Current release `3c0133c5c49e875bb72b64fbc1c84f3082de4480` contributes **19,245 records from one server session**, October 22 11:09 through October 26 12:53 UTC. Environment: Apple M1 (8 cores), darwin-arm64, Node 24.18.0. Deployed source, not this dirty checkout, was used to check timing semantics and the warm/Changes call chains. These are **L3-data leads**, not an L1/L2 experiment or demonstrated L3 improvement. Machine `highLoad` is unavailable; one server session does not meet the two-session improvement contract.

### User waits, ranked by cumulative measured time

| Lead                                                   | Samples |     Median / p95 |     Total | Related scenario and next action                                                                                                                                                                    |
| ------------------------------------------------------ | ------: | ---------------: | --------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First reply on screen (`reply.first`, stream)          |      34 | 7.877 / 26.698 s | 368.049 s | `web.send.stream`, `turn.warm`, `web.paced`. Reproduce dispatch-to-first-output and delivery separately with a synthetic delayed provider; the real provider/network is not reproduced by loopback. |
| Confirmed own message on screen (`send.shown`, stream) |      52 |  1.554 / 5.026 s | 105.457 s | `web.send.stream` / `.poll`, `projection.large.paced`. Trace admission → native user entry → projection → push → store, rather than optimising paint first.                                         |
| Confirmed session switch (`switch`, stream)            |     176 |     241 / 884 ms |  70.328 s | `web.reopen`, `web.open.long`. Investigate the tail (max 5.654 s), below send/reply in cumulative measured wait.                                                                                    |

Arrival and paint phases overlap; do not sum them, HTTP durations, or native durations as independent user time. `reply.arrived` has 40 samples, 7.862 / 28.246 s median/p95, 476.725 s total. `send.arrived` has 52 samples, 1.541 / 4.999 s, 104.849 s total. Submit acknowledgement is much shorter (`send.answered`: 54 samples, 83 / 749 ms), and optimistic local echo is fast (`send.echoed`: 59 samples, 11 / 21 ms). These aggregates suggest investigating before confirmed-store arrival, not adding another optimistic row; they are not paired traces, so subtracting medians does not measure a component's cost. Four hidden first-paint waits are unavailable, not zero.

Of 56 settled prompts, 53 reused a native process. Reused admission-to-dispatch is 547 / 1,178 ms median/p95; dispatch-to-first-output is **6.105 / 18.154 s** (50 outputs, three without output). Three cold prompts take 3.919 / 4.153 s to dispatch. Most observed first-output waiting is after dispatch, but the journal cannot split provider queueing, inference, upstream network and native processing. Whole-task duration is 165.508 s median, 28.193 min p95, 51.059 min max, 6.897 hours aggregate. Reused runs spend 34% of aggregate time with a tool active; the remainder is not a measured model-only share. Outcomes also include two handled commands, two discoveries, one fork, one handoff and six errors.

October 26 supplies 29 of the 34 visible first-reply samples (median 7.926 s, p95 26.698 s), so the recent wait is not merely an old-release hotspot. Earlier days have too few comparable interactions to establish a regression.

### HTTP work and shared-server stalls

- **Warm:** 153 requests, 279.036 s cumulative (63.6% of 438.635 s recorded HTTP time), median 14 ms, p95 5.316 s, max 28.265 s. There are 99 requests below 100 ms, 45 at 1–5 s, and nine at least 5 s. All return HTTP 200, which does not prove `warmed: true`: that body is not recorded. The deployed `warmSession` is fire-and-forget; its total is not proved user blocking. The native path already coalesces in-flight starts and reuses an existing process, and a send arriving during warm waits for that start. Use `native.warm` / `turn.prewarmed` to split preparation, launch and retirement before changing anything. Do not remove prewarming or relax its ownership/spending gates to improve the route total.
- **Changes:** 239 requests, 65.291 s cumulative, median 232 ms, p95 491 ms, max 1.795 s. Of these, 237 occur since October 25. Deployed `Workspace.changes` already shares concurrent repository work and incrementally folds transcript edits. `repositoryChanges` still runs fresh repository metadata, status, numstat and per-file version reads. `changes.poll.images` is the starting reproducer; first isolate those costs on a representative changed repository, then test whether independent status/numstat work can overlap without stale results. No reduction is yet demonstrated.
- **Configure and files:** configure has only four samples: successful calls take 25.600 and 4.454 s; two 409 refusals take under 2 ms. Files has 20 samples, 12.058 s total, 152 ms median, 2.800 s p95. Both are sparse leads, with no exact current scenario; add a synthetic reproducer before optimising. Current images have only 24 samples, median 143 ms, p95 403 ms, 3.544 s total; do not carry forward the old-release multi-second image hotspot as a current finding.
- **Shared stalls:** 5,864 process-minute samples, event-loop p99 median 2.5 ms / worst 105.4 ms. **121 sampled intervals contain a stall at least 500 ms; 18 contain one at least 1 s**. These count intervals, not individual stalls. Longest is 3.820 s in the interval ending October 26 03:46:54 UTC; a 28.265 s warm request ends about 20 seconds later. This is temporal proximity, not causal proof. Busy fraction is 0.5% median / 24.3% worst; RSS peaks at 484 MiB. The journal has neither stacks nor whole-machine load. No benchmark reproduces this exact stall: first use an isolated startup/large-history workload with CPU/GC profiling; production profiling or collection changes require approval.
- **Pushes:** per active minute, sized payloads are 42,277 B `view`, 6,894 B `sessions`, 4,578 B `presence`, 2,012 B `changes`, and 1,313 B `sessions-delta`. Since October 25, `view` is 105,554 B/min and `presence` 12,016 B/min. Different activity mixes prevent calling that a regression. Current-release unsized deliveries are one each for eight event names and 56 Changes deliveries. These are payload counts, not total network traffic. `projection.large.paced`, `sessions.rename.tabs` cover related synthetic work; no evidence yet makes this the first optimisation target.

### Reliability lead, separate from speed

October 26 09:27–09:35 UTC contains **four submit 500s and two fork 500s** (six native `error` outcomes). A read-only copy of `service-error.log` ends in six current-release `Unpaired native tool history; reconcile outcomes before handoff or fork` stacks: four through submit/handoff history extraction, two through fork. The stderr records lack timestamps/request IDs, so their matching count and call paths support but do not prove one-to-one correlation. Preserve the paired-history/unknown-outcome fence; do not hide it by retrying or bypassing validation. Next owner: the coding agent, with approval for a separate correctness investigation using synthetic interrupted-tool history; any production-history repair needs explicit authorisation.

**Next owner/action:** the coding agent should first extend the existing `web.send.stream` measurement to localise the confirmed-message delay, then attempt one L1/L2 optimisation in isolation. Investigate the shared stalls with synthetic profiling in a separate experiment; retain warm, Changes, configure/files and switch as ranked follow-ups, not proven fixes. This refresh changes documentation only. No benchmarks or tests were run. No runtime work was removed, thresholds changed, real model accounts used, or service/data modified. Raw snapshots, stderr and full reports remain in `/tmp`, not Git. Push and deployment are not authorised by this analysis request.

## Earlier records

Historical records are preserved verbatim below these links; they are not current product requirements.

## Program 3, step 2 — 2026-10-21

Historical record: [Performance opportunities: approved programs (historical)](opportunities-programs.md#program-3-step-2--2026-10-21).

## Program 3, step 1 — 2026-10-21

Historical record: [Performance opportunities: approved programs (historical)](opportunities-programs.md#program-3-step-1--2026-10-21).

## Program 2, step 5 — 2026-10-20

Historical record: [Performance opportunities: approved programs (historical)](opportunities-programs.md#program-2-step-5--2026-10-20).

## Program 2, step 4 — 2026-10-20

Historical record: [Performance opportunities: approved programs (historical)](opportunities-programs.md#program-2-step-4--2026-10-20).

## Program 2, step 3 — 2026-10-20

Historical record: [Performance opportunities: approved programs (historical)](opportunities-programs.md#program-2-step-3--2026-10-20).

## Program 2, step 2 — 2026-10-20

Historical record: [Performance opportunities: approved programs (historical)](opportunities-programs.md#program-2-step-2--2026-10-20).

## Program 2, step 1 — 2026-10-20

Historical record: [Performance opportunities: approved programs (historical)](opportunities-programs.md#program-2-step-1--2026-10-20).

## Program 1 accepted — 2026-10-20

Historical record: [Performance opportunities: approved programs (historical)](opportunities-programs.md#program-1-accepted--2026-10-20).

## Approved programs: second implementation batch — 2026-10-20

Historical record: [Performance opportunities: approved programs (historical)](opportunities-programs.md#approved-programs-second-implementation-batch--2026-10-20).

## Approved programs: first implementation batch — 2026-10-19

Historical record: [Performance opportunities: approved programs (historical)](opportunities-programs.md#approved-programs-first-implementation-batch--2026-10-19).

## Journal refresh — 2026-10-19, 12:52 UTC

Historical record: [Performance opportunities: earlier journals (historical)](opportunities-journals.md#journal-refresh--2026-10-19-1252-utc).

## Journal analysis — 2026-10-19

Historical record: [Performance opportunities: earlier journals (historical)](opportunities-journals.md#journal-analysis--2026-10-19).

## Journal analysis — 2026-10-17

Historical record: [Performance opportunities: earlier journals (historical)](opportunities-journals.md#journal-analysis--2026-10-17).

## First climb batch — 2026-10-17

Historical record: [Performance opportunities: climbs 1–6 (historical)](opportunities-climbs-1-6.md#first-climb-batch--2026-10-17).

## Second climb batch — 2026-10-17

Historical record: [Performance opportunities: climbs 1–6 (historical)](opportunities-climbs-1-6.md#second-climb-batch--2026-10-17).

## Third climb batch — 2026-10-17

Historical record: [Performance opportunities: climbs 1–6 (historical)](opportunities-climbs-1-6.md#third-climb-batch--2026-10-17).

## Fourth climb batch — 2026-10-17

Historical record: [Performance opportunities: climbs 1–6 (historical)](opportunities-climbs-1-6.md#fourth-climb-batch--2026-10-17).

## Fifth climb batch — 2026-10-17

Historical record: [Performance opportunities: climbs 1–6 (historical)](opportunities-climbs-1-6.md#fifth-climb-batch--2026-10-17).

## Sixth climb batch — 2026-10-17

Historical record: [Performance opportunities: climbs 1–6 (historical)](opportunities-climbs-1-6.md#sixth-climb-batch--2026-10-17).

## Seventh climb batch — 2026-10-18

Historical record: [Performance opportunities: climbs 7–12 and original leads (historical)](opportunities-climbs-7-12.md#seventh-climb-batch--2026-10-18).

## Eighth climb batch — 2026-10-18

Historical record: [Performance opportunities: climbs 7–12 and original leads (historical)](opportunities-climbs-7-12.md#eighth-climb-batch--2026-10-18).

## Ninth climb batch — 2026-10-18

Historical record: [Performance opportunities: climbs 7–12 and original leads (historical)](opportunities-climbs-7-12.md#ninth-climb-batch--2026-10-18).

## Tenth climb batch — 2026-10-18

Historical record: [Performance opportunities: climbs 7–12 and original leads (historical)](opportunities-climbs-7-12.md#tenth-climb-batch--2026-10-18).

## Eleventh climb batch — 2026-10-18

Historical record: [Performance opportunities: climbs 7–12 and original leads (historical)](opportunities-climbs-7-12.md#eleventh-climb-batch--2026-10-18).

## Twelfth climb batch — 2026-10-18

Historical record: [Performance opportunities: climbs 7–12 and original leads (historical)](opportunities-climbs-7-12.md#twelfth-climb-batch--2026-10-18).

## Original leads (historical baselines)

Historical record: [Performance opportunities: climbs 7–12 and original leads (historical)](opportunities-climbs-7-12.md#original-leads-historical-baselines).

## Needs measurement first

Historical record: [Performance opportunities: climbs 7–12 and original leads (historical)](opportunities-climbs-7-12.md#needs-measurement-first).
