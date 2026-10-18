# Reuse validated native tail entries for active-run snapshots

Third experiment of the tenth climb batch. Retained as L1 only.

## Hypothesis and method

An active execution already owns an append-only `NativeTail` that validates each complete native JSONL line for final
journal ingestion. Goal snapshots instead created a second tail and decoded the same persisted prefix. Pass the
run-owned tail to `readNativeSnapshot`, retain its validated entries for that run, refresh only appended file bytes,
and give snapshots a copy without moving the independent journal-delivery cursor. Standalone snapshots remain fresh.

A snapshot still re-reads and hashes every prefix byte against the incrementally maintained digest. If the file was
rewritten, replaced or truncated, it discards cached objects and performs the original full parse, preserving valid
rewrites and exact JSON/header/tree failures, including malformed non-current branches. It still asks native RPC for
entries after the last complete persisted ID; partial lines, unflushed/final entries, selected leaf, line/RPC size
bounds and unknown/no-replay behavior are unchanged. Entry objects live only for the existing execution lifetime; no
cross-call credential/session cache or protocol/schema change.

Baseline `/tmp/rt-native-tail-base.json`, head `/tmp/rt-native-tail-head-final.json`; five runs each, fixed workload,
macOS arm64 / Apple M1 eight cores / Node 24.18.0 / rotom 0.1.25. Both timing locks report `highLoad: false` (baseline
2.27→2.33, head 2.15→4.04). Parent `readSync` counters prove prefix bytes are still checked rather than moving work to
an uncounted read path.

| Scenario             | Native JSONL calls | Native readback calls | Total JSON calls |     Parent read calls / bytes |
| -------------------- | -----------------: | --------------------: | ---------------: | ----------------------------: |
| Cold turn            |               14→7 |                 74→67 |          214→207 |   50 / 391,847 → 50 / 391,847 |
| Warm turn            |               18→9 |                 67→58 |          144→135 | 25 / ~255,920 → 25 / ~255,920 |
| Paced turn           |              22→11 |                 71→60 |          270→259 | 25 / ~269,328 → 25 / ~269,328 |
| Prepared turn        |               14→7 |                 67→60 |          170→163 |   25 / 242,536 → 25 / 242,536 |
| Four-tab large paced |            270→135 |               319→184 |      1,712→1,577 | 25 / ~350,084 → 25 / ~350,082 |

Calls are stable across all five head runs. Characters fall by the same removed lines: large-paced native JSONL
~201,274→~100,636 and total JSON ~1,302,876→~1,202,207. RPC (48) and gate (1) are unchanged, and every native coarse
call/character still equals the three nested sources. Milliseconds are noise: cold 1,736.1→1,712.3, warm 85.4→83.6,
paced 888.3→888.9 and large-paced 891.0→900.4 ms. Therefore no L2 claim.

## Controls and verification

New tests cover retained-prefix parse counts, partial-line RPC anchoring, unflushed suffix/leaf Goal selection,
identity mismatch, journal delivery after snapshot, same-size rewrite, replacement, truncation, malformed append and
fresh fallback semantics. Negative controls fail when the prefix digest comparison is removed and when snapshot moves
the delivery cursor. Existing >64 MiB selected-branch, oversized-line and foreign-header tests pass.

Type/lint/format pass; all 454 tests pass. Synthetic kernel proof passes 82 loopback requests. Native
command/Chromium proof passes 28 synthetic inferences. Candidate ceilings were tightened; ledger guard/check pass.
No real accounts, entities, production data/service, deployment or browser/device L3 evidence were used.
