# Attribute parent-process JSON decoding

First experiment of the eighth climb batch: identify the work outside the narrowed roomState counters. No optimization.

## Instrument

A subscriber-only AsyncLocalStorage scope wraps Durable storage and journal method bodies with their original receiver.
Scopes follow async storage work without attributing concurrent callbacks by wall-clock start/end. Explicit native
JSONL/RPC/gate parsing and HTTP body parsing have their own scopes. Method-level journal subscopes distinguish mirror
`entries`, `thinkingLevel`, and `segmentEntries`; remaining calls go to journal or other. Every global JSON parse is
counted once, by the innermost source. The existing totals and scenario work are unchanged. JSON reviver behavior and
failures remain unchanged. No user content, paths or IDs are emitted and no stack capture is used.

Production has no parse-work subscriber: no Proxy objects or async scope are created. The daily journal's collection
and retention are untouched. Benchmarks incur source-attribution overhead; their timings cannot be compared with
older uninstrumented reports as an optimization. Two tests check opt-in identity, private receiver, async isolation,
nested scope, exception cleanup and exact call/character partition. Misclassifying Durable as other fails the test
(`/tmp/rt-parse-source-control.log`); restored instrument passes.

## Two five-run reports

`/tmp/rt-parse-source-a.json` and `/tmp/rt-parse-source-b.json`, `0978732` plus measurement and unchanged pre-existing
user changes; Node 24.18.0 / macOS arm64 / Apple M1 eight cores / rotom 0.1.25. Report loads A 4.01→4.31 and B
2.86→3.61; both timing locks `highLoad: false`. Every reported scenario's exclusive source calls and characters sum
exactly to the original total in every run. Candidates registered from both times; guard/check pass, no gate promotion.

| Source calls                    | Four-tab open | Four-tab paced |
| ------------------------------- | ------------: | -------------: |
| Durable storage                 |           139 |             14 |
| Journal receipts/bindings/other |            70 |            233 |
| Journal mirror history          |             0 |              4 |
| Journal thinking                |             0 |              0 |
| Journal full segment entries    |         1,848 |          4,792 |
| Native JSONL/RPC/gate readback  |             0 |            319 |
| HTTP body                       |             0 |              1 |
| Other                           |             0 |             24 |
| **Total**                       |     **2,057** |      **5,387** |

These counts have zero spread at both times. Segment reads account for 89.8%/89.0% of total calls and roughly
1.312/3.407 million of 1.455/3.902 million characters. A preliminary coarse report is retained at
`/tmp/rt-parse-source-coarse.json`; it led to finer scopes, not a different optimization experiment.

## Deciding call chain

`Room.push` serializes the slow `nativeGoal` field for each client even when unchanged. `TeamKernel.nativeGoal`
uses live state when present; otherwise it queries the fresh current session and calls `journal.segmentEntries`,
then `currentBranchGoalState` traverses the selected ancestry. Four-tab open performs 14 such pushes over 132 entries
(1,848); paced does 36 over 132–134 entries (4,792). This is **Goal readback**, not roomState and not thinking. The
initial coarse thinking hypothesis is rejected by the refined counts. In session.open, thinking also contributes
58 calls but is not the large-history dominant path.

## Next hypothesis

Share the same room-wide Goal snapshot only within one synchronous fanout. Read it fresh on each fanout, retain live
precedence and selected-branch semantics, keep viewer-specific command/catalog/member fields per client, and leave
single-client/full/reconnect reads fresh. Do not cache by elapsed time, credentials or transcript identity across calls.
If the source counter falls with safety/parity tests, keep as L1 only. No pagination or protocol delta is authorized.
