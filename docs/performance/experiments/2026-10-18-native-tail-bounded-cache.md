# Bound active NativeTail entry reuse to 1 MiB

Eleventh batch, experiment two. Retained for bounded memory, with the prior small-workload L1 benefit preserved.

## Change

The run-owned tail keeps decoded prefix bodies only while the encoded file prefix is at most 1 MiB. It always keeps
the ID tree needed to validate later appends and a separate undelivered-entry queue needed for authoritative journal
ingestion. Crossing the limit releases cached bodies; snapshots then use the original fresh, complete parse. There is
no selective parsing or truncated history. A tail-less standalone snapshot is explicitly fresh, so the size rule does
not accidentally create an implicit cache there.

The bound is on encoded bytes, not V8 object size. A single undelivered entry can still be up to the existing 64 MiB
line limit because it cannot be dropped before journal ingestion. After `read()` delivers it, the large object is no
longer retained by the tail. Small histories retain entries until the existing run ends. No credentials or state cross
calls/runs/processes.

## Evidence

Five-run memory reports compare `/tmp/rt-tail-memory-before-reuse-final.json`,
`/tmp/rt-tail-memory-reuse-final.json`, and `/tmp/rt-tail-memory-bounded-final.json`. The bounded head lock reports
highLoad false, 2.88→3.08. Values are median process deltas after three snapshots and an idle/GC boundary.

| Payload | Unbounded reuse idle heap | Bounded idle heap | Before-reuse idle heap | Snapshot parses: unbounded→bounded (before) |
| ------- | ------------------------: | ----------------: | ---------------------: | ------------------------------------------: |
| ~15 KiB |                  ~0.1 MiB |            ~0 MiB |                 ~0 MiB |                               129→129 (516) |
| 8 MiB   |                    ~8 MiB |            ~0 MiB |                 ~0 MiB |                               129→516 (516) |
| 70 MiB  |                 ~65.2 MiB |         ~-4.8 MiB |              ~-4.8 MiB |                                   6→24 (24) |

Large-case RSS remains allocator-sensitive: bounded 8 MiB idle RSS ~83.1 MiB versus pre-reuse ~89.9; bounded 70 MiB
~273.5 MiB versus pre-reuse ~484.3, while peak high-water ~315.6 versus ~526.9. Only heap retention and parse counts
support the decision; RSS is contextual, not a gate or claimed speedup.

The existing controlled turn fixtures are all below 1 MiB, so their prior L1 remains exactly stable across five runs:
warm JSONL 9 and native-readback 58; paced 11/60; large-paced 135/184. Report
`/tmp/rt-tail-bounded-perf-final.json`, highLoad false 3.08→2.60. Every compared millisecond remains noise.

Tests cover crossing the limit, fresh full parse, continued append validation, independent delivery, and no duplicate
delivery. Negative controls fail if the limit is disabled or the fresh fallback is removed. Existing partial lines,
rewrites/replacements/truncation, malformed history, selected branch, >64 MiB cumulative history, line/RPC bounds and
foreign header tests pass. This does not prove a 1 MiB threshold is globally optimal; it proves bounded retention and
preserves the fixed-workload win. No L2/L3, real account, production service/data or device claim.
