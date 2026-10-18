# Read complete latest/pending receipt rows once

Third experiment in the sixth climb batch. Hypothesis: `latest` and `pendingConversation` select an attempt ID, then
`receipt` selects the same full row. Read the full row on the first query and run the existing decode/fence logic once.

## Implementation and safety

`src/server/rotom-journal.ts` extracts a private row decoder. `receipt(id)` still selects by ID and throws the same
unknown-receipt error. `latest` preserves conversation filter, descending rowid and limit; `pendingConversation`
preserves conversation filter, dispatch-intent/unknown status filter and limit. Both use the complete row they already
read. Every receipt still parses its full binding and performs a fresh unresolved-command-input query. No cache,
transaction/state/schema change or replay decision is added.

New journal test verifies empty results; latest ordering against an earlier known rejection; pending filtering;
complete equality with `receipt`; fresh queued-input completion; phase/failure/unknown status; conversation/member
scope; restart; unknown-ID error; and exactly one attempt-row read plus one required fence read. Reintroducing the
second read fails `2 !== 1`, log `/tmp/rt-receipt-two-read-control.log`. Removing the fence fails `0 !== 1` and the
existing queued-command semantics test, log `/tmp/rt-receipt-fence-control.log`. Restored fix passes 20 journal tests.

## Base/head, five fresh runs each

macOS arm64 / Apple M1 eight cores / Node 24.18.0 / rotom 0.1.25. Base `/tmp/rt-kernel-query-b.json`, load
2.32→4.82; head `/tmp/rt-receipt-row-head.json`, load 3.36→3.38. Both timing locks `highLoad: false`.

| Scenario       | Kernel SQL total | Attempts-table SQL | Required fence reads | Binding parses |        Median duration |
| -------------- | ---------------: | -----------------: | -------------------: | -------------: | ---------------------: |
| Four-tab open  |            98→84 |              42→28 |                14→14 |          28→28 |   49.6→47.9 ms (noise) |
| Four-tab paced |          316→248 |             140→72 |                68→68 |        104→104 | 875.9→882.3 ms (noise) |

Every large-scenario count has zero spread. Removed work is one redundant attempt-row query/returned row per existing
latest or pending receipt. Empty lookups remain one query. Decoding/fence work remains exactly unchanged. Existing
scenario totals also fall; propose lowers measured candidates only. Three incidental JSON baselines tightened by a
few characters are not credited as this SQL optimization. Warm/discovery head runs sometimes emitted an extra
coalesced view (1→2); their totals are not evidence of SQL regression or improvement and no baseline was raised.

Final type/lint/format, 448 tests, synthetic kernel proof (82 loopback requests), native command proof and real Chromium
open/paced benchmark pass. A final test-only extension of the journal ordering/filter assertion was then checked by
the 20 journal tests. No real account, production service/data, polling fallback or full UI/device acceptance used.
Keep as **L1 only**; no L2/L3 claim.

## Next action

This batch stops at three experiments. Remaining roomState reads are presence/head twice, one exact session decode,
two current receipt lookups and input fences. Next independent hypothesis: combine presence/head/session into one
fresh joined read with an optional missing-conversation result, but preserve errors for a present head with missing
segment and all immutable binding/unknown checks. Test parity and record query plans before choosing it; no broad cache.
