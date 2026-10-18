# Split native readback parsing into RPC, JSONL and gate

First experiment of the tenth climb batch. This is measurement only; no runtime behavior or fixed workload changes.

## Instrument

The existing subscriber-only native-readback scope now adds three nested counters while retaining its coarse total:
RPC records (including event payloads), native JSONL lines, and inference/usage gate request bodies. Every coarse native
call/character equals the sum of the three parts in every scenario/run of both reports. JSON is still parsed exactly once
by the same `JSON.parse`; no content, IDs, paths or stack traces are published. With no diagnostics subscriber, scopes
still execute without AsyncLocalStorage state. The attribution test covers coarse/nested sums and parser results; RPC,
large snapshot, malformed/oversized and unknown-outcome tests pass.

Two five-run reports: `/tmp/rt-native-readback-a.json` and `/tmp/rt-native-readback-b.json`, current on-disk tree at
`4be8a97` plus the previously committed roomInfo optimization and unchanged user edits; Node 24.18.0, macOS arm64,
Apple M1 eight cores, rotom 0.1.25. Load A 3.83→3.19 and B 2.60→6.25; timing lock says `highLoad: false`, but this
measurement adds counters and makes no timing comparison. Candidates registered from both times; check/guard pass.

| Scenario calls (chars) |          RPC |                 JSONL |   Gate |          Coarse total |
| ---------------------- | -----------: | --------------------: | -----: | --------------------: |
| Cold turn              | 59 (170,678) |           14 (93,976) | 1 (60) |          74 (264,714) |
| Warm turn              |  48 (49,280) |          18 (107,362) | 1 (60) |          67 (156,702) |
| Paced turn             |  48 (49,307) |          22 (120,766) | 1 (60) |          71 (170,133) |
| Prepared turn          | 52 (168,290) |           14 (93,982) | 1 (60) |          67 (262,332) |
| Four-tab large paced   |  48 (49,332) | 270 (201,266–201,292) | 1 (60) | 319 (250,658–250,684) |

Call counts have zero spread at both times; only bounded fixture IDs/path-dependent characters vary by a few bytes.
Gate is already one tiny fresh identity check and is not a lead. RPC stays near 48 across warm/paced/large-paced;
large-history growth is JSONL lines, 22→270.

## Deciding call chain and next hypothesis

Each active execution owns one incremental `NativeTail` for message durability and final ingestion. Yet
`running.snapshot` calls `readNativeSnapshot`, which constructs another `NativeTail` and reparses the entire persisted
prefix before asking RPC only for the in-memory suffix. Goal finalization invokes that snapshot even for ordinary
prompts. The existing tail has validated many of the same complete lines already.

Next experiment: let the run-owned tail retain its validated complete entries and supply the persisted prefix to
`readNativeSnapshot`; continue incrementally reading file growth before every snapshot. Keep get_entries `since`, leaf
identity, partial-line buffering, shrink/replacement errors, malformed/duplicate/parent checks, 64 MiB limits,
message-level journaling and final unknown fencing. Standalone readNativeSnapshot remains fresh. Count total process
work: fewer parses/reads are valid only if the retained bodies are bounded to the same session lifetime and are not
reparsed elsewhere. No cross-process cache or native protocol change.
