# Split native RPC parsing into transport records and notify payloads

Twelfth batch, experiment one; measurement only. Existing native RPC calls/chars are partitioned into transport JSONL
records and nested notify message JSON. A separate content-free counter counts transport notify records for comparison.
No payload, path, ID, stack or credential is recorded. Parsing, record limits, policy checks and unknown fences are
unchanged. Without a diagnostics subscriber the parser adds no AsyncLocalStorage scope.

Two five-run reports `/tmp/rt-rpc-sources-a.json` and `/tmp/rt-rpc-sources-b.json`, current tree at `9ab5642` plus
measurement and unchanged user edits. Node 24.18.0, macOS arm64, Apple M1 eight cores, rotom 0.1.25. Both timing locks
report highLoad false, 3.07→3.53 and 3.53→4.20. These are two times of the same instrument, not optimization before/after.
Candidates registered from both; ledger guard/check pass.

| Scenario                   | All RPC | Transport | Nested notify | Transport notify records | Nested notify chars |
| -------------------------- | ------: | --------: | ------------: | -----------------------: | ------------------: |
| Cold turn                  |      59 |        57 |             2 |                        2 |                 182 |
| Warm / paced / large paced |      48 |        47 |             1 |                        1 |                  90 |
| Prepared turn              |      52 |        51 |             1 |                        1 |                  90 |
| Warm command discovery     |       5 |         4 |             1 |                        1 |                  90 |

All ten runs have identical calls. Calls/chars partition exactly in every scenario/run. The attribution test checks
legacy aggregate behavior, nested sums, real transport-only notify counting and unchanged JSON results. Existing RPC
malformed, oversized, ambiguous-result and no-replay tests pass.

Decision: no nested payload duplication in these fixed workloads; caching the one 90-character barrier marker cannot
remove meaningful repeated work. Preserve transport parsing and fresh nonce/policy checks. Do not replace the protocol
or skip records. Next lead: constant unclassified `other` parsing in ordinary turns (24 calls / 103,190 chars) needs
content-free attribution before any change. No L1 optimization, L2 or L3 claim for this measurement.
