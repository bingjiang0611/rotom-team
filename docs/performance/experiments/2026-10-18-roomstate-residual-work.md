# Residual room-state work after the joined snapshot

Third experiment in the seventh climb batch: rank the remaining work from the existing five-run head report, rather
than immediately adding another cache. No new workload, counters, native behavior or protocol is introduced here.
Source `/tmp/rt-head-session-head.json`, macOS arm64 / Node 24.18.0; load 3.19→3.28, timing lock `highLoad: false`.

| Four-tab scenario | Total SQL | Kernel projection SQL | Total JSON decodes | Kernel decodes | Total/kernel median span |
| ----------------- | --------: | --------------------: | -----------------: | -------------: | -----------------------: |
| Open              |       199 |            56 (28.1%) |              2,057 |      28 (1.4%) |            47.4 / 2.5 ms |
| Paced             |       755 |           176 (23.3%) |              5,387 |     104 (1.9%) |          882.8 / 11.4 ms |

Counts have zero spread. Kernel JSON characters are 15,148 / 56,264, against roughly 1.455 / 3.902 million total.
The report's accumulated component spans and scenario duration are different boundaries, so these are context, not
predicted speedups. Base/head durations remain noise.

## What remains in this subtree

`roomState` does a fresh joined session read, fresh pending receipt, then `#cutOff` reads latest receipt even if running.
A complete receipt retains its full binding decode and fresh unresolved-input fence. In paced projection there are
36 head statements, 72 attempt statements, 68 input-fence statements and no resume statements. Open has 14, 28, 14, 0.
The categories sum exactly to their scoped totals. Moving `isRunning` ahead of the latest read would skip some SQL, but
would weaken the expressly retained fresh safety-read contract of this climb; do not do that as a counter trick.

The single-pending-writer index alone does not prove the pending receipt is the latest historical row. No receipt can
be reused solely because its conversation matches. A combined fresh lookup would need independent latest and pending
selection, exact receipt-ID equality before shared decode, current unresolved-input checks and cutoff/restart parity.
That is not implemented or assumed safe here.

## Decision and next owner/action

Stop this batch at three experiments. The remaining kernel binding decodes account for under 2% of the measured parent
JSON call count. Before more room-state work, the coding agent should add content-free scoped counters around native
readback, journal mirror and Durable projection/storage reads, register them from two runs at different times, and rank
which source scales with history. Current totals do not identify the dominant parser; no source attribution or speedup
is claimed. This is the next measurement task, not authorization for pagination, a protocol change, an account-bearing
runtime pool, native behavior changes or production actions.

The retained JOIN reaches L1: this batch reduces kernel SQL 84→56 and 248→176. Since the room-state climb baseline,
common/worst counts are 140→56 (60%) and 424→176 (about 58%). The full verification belongs to commit `73a99b7`'s
code and test changes: 449 tests, type/lint/format, synthetic kernel proof (82 requests), native-command proof (19
inferences), and Chromium open/stream readback. No L2/L3, real-account or physical-device claim.
