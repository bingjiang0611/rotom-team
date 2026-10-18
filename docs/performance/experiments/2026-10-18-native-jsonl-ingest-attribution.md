# Attribute remaining native JSONL parses to ingestion or snapshot fallback

Eleventh batch, experiment three. Measurement only; no runtime behavior, workload, history or parser changes.

The existing `nativeJsonl` aggregate now has two exclusive children. `nativeJsonlIngest` covers the one run-owned tail
that validates complete lines and queues them for authoritative journal ingestion. `nativeJsonlSnapshot` covers
standalone/full/fallback parses, including the bounded-cache path. The aggregate and coarse native-readback counters
remain unchanged. Production without a diagnostics subscriber still creates no AsyncLocalStorage scope. Counters carry
only calls/chars, never content, IDs, paths, stack traces or credentials.

Two different-time, five-run reports: `/tmp/rt-tail-sources-a.json` and `/tmp/rt-tail-sources-b.json`, current tree at
`e410d5a` plus measurement and unchanged user edits; Node 24.18.0, macOS arm64, Apple M1 eight cores, rotom 0.1.25.
Both timing locks say `highLoad: false`, A 2.17→3.17 and B 3.17→4.94. Milliseconds are not compared or claimed. The
new counters were registered as candidates from both reports; ledger guard/check pass.

| Scenario             | JSONL aggregate | Ingestion | Snapshot/full fallback |
| -------------------- | --------------: | --------: | ---------------------: |
| Cold turn            |               7 |         7 |                      0 |
| Warm turn            |               9 |         9 |                      0 |
| Paced turn           |              11 |        11 |                      0 |
| Prepared turn        |               7 |         7 |                      0 |
| Four-tab large paced |             135 |       135 |                      0 |

Calls have zero spread across all ten runs. Calls and characters satisfy `aggregate = ingestion + snapshot` in every
scenario/run of both reports. The controlled histories are below the new 1 MiB cache limit, so no fallback is expected.
Dedicated >1 MiB tests and the memory probe prove the fallback separately rather than changing the fixed workload.

Decision: there is no remaining duplicate complete-prefix JSONL parse in these benchmark turns. The 135 large-paced
calls are the first full validation needed to ingest that native session, not another snapshot copy. Removing them
would require moving parsing/validation, changing the journal/protocol/storage contract or trusting unvalidated data;
none is authorized or justified by current evidence. Do not optimize this number further. The next batch may split the
stable 48 RPC parses into transport records versus nested bridge payloads, preserving unknown/no-replay and record
bounds, before choosing another optimization. Gate remains one 60-character fresh check and is not a lead.
