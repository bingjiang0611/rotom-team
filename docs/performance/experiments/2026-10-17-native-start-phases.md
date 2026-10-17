# Measure native cold-start phases and managed writes

Measurement-only instrumentation before another runtime optimisation. Production behavior, startup order, authorization,
resource policy and journal records are unchanged. Signals are content-free and published only while a controlled
benchmark subscribes; production journal collection is unchanged.

## Instrument

A successful `startRotomKernel` reports:

- pinned launcher verification;
- local path/options validation;
- owner/project resource validation, resolution and materialization;
- Computer Use helper probe;
- `spawn()` call until the OS `spawn` event;
- OS spawn event until native `get_state` confirms model/thinking/idle state;
- RPC-ready and total startup duration.

`RotomRpc.spawnMs` observes the existing child; it does not alter dispatch or readiness. The benchmark additionally
counts parent-process synchronous writes, write bytes and atomic renames during cold discovery. All phase milliseconds
remain timings, not ratchet work counters. Only the three filesystem counters are registered candidates.

## Evidence

Five fresh runs per report, macOS arm64 / Apple M1 eight cores / Node 24.18.0. Timing lock reported `highLoad: false`.
Reports `/tmp/rt-native-phases-a.json`, `/tmp/rt-native-phases-b.json`, `/tmp/rt-resource-writes-a.json`, and
`/tmp/rt-resource-writes-b.json`. Phase A lacks the later spawn/initialize split but independently establishes the
same RPC-ready dominance.

| Cold operation                                 |         Verify | Resources | OS spawn |    Native initialize |        Total startup |
| ---------------------------------------------- | -------------: | --------: | -------: | -------------------: | -------------------: |
| First prompt, phase B median                   |         3.0 ms |   68.5 ms |   0.6 ms |           1,555.3 ms |           1,634.7 ms |
| Explicit discovery, phase B median             |         2.8 ms |   67.3 ms |   0.6 ms |           1,634.2 ms |           1,705.4 ms |
| Explicit discovery, write A/B median resources | 76.4 / 72.9 ms |         — |   0.5 ms | 1,518.7 / 1,592.5 ms | 1,598.4 / 1,663.8 ms |

The dominant measured phase is after OS spawn, while the native process loads/verifies its bundled runtime and reaches
its first state response. OS process creation itself is about 0.5–0.6 ms. Team's resource preparation is about
67–76 ms. Repeated Team pin verification is only about 2–3 ms and is not an attractive reason to weaken verification.
These spans do not split native bundled-Pi verification, module loading, extension/MCP setup and session creation;
that requires supported native instrumentation or a controlled launcher comparison.

Before optimisation, cold discovery does exactly 4 parent synchronous writes, 1,213 bytes and 3 atomic renames in all
ten runs. Two reports at different times register those three candidates with zero spread. Ledger guard and ratchet
check pass; no gate promotion, baseline raise or tolerance widening.

Tests: `npm run check`, `npm run lint`, 13 performance journal/ratchet tests and 28 RPC tests pass. Instrumentation does
not use accounts, UI, live service data or production restart. No L1/L2/L3 performance claim: this commit measures.

## Next hypothesis

`prepareTeamResources` atomically rewrites managed files even when the bytes are unchanged. Preserve every source,
collision, removal, digest and permission check, but skip only private regular-file writes whose current bytes exactly
match the derived bytes. This should remove three of four parent writes/renames in cold discovery. The remaining write
is expected to be per-run gate/context state outside resource materialization. Removing these writes is small versus
native initialization and is not expected to produce a 20% end-to-end latency improvement.
