# Measure explicit native readiness before optimising startup

Third experiment in the first climb batch: measurement only, no runtime optimisation. This supplies the missing
POST-discovery coverage for stage 2. Existing stages 1/2/3 plan is [here](../2026-10-17-proposals.md).

## Instrument and unchanged contracts

Append an additional fresh session after **all** existing scenarios, including `web.open`, so the old workloads do
not gain sessions/history. One tab observes it. Run:

1. `commands.discover.cold`: explicit authenticated POST prompts with a stable new request ID; assert handled receipt,
   dynamic registry ready and zero new synthetic model requests.
2. `commands.discover.warm`: a second explicit POST with another request ID, same assertions and same segment.
3. `turn.prepared`: first ordinary prompt on that session; assert settled receipt and exactly one synthetic inference.

Report common counters, pushes, response bytes where relevant, and `subprocess.rotom` (existing process-count hook,
newly reported only for these workloads). Keep fixture streaming, quiet windows, JSON bookkeeping exclusion and old
scenarios unchanged. This is explicit user-authorised native startup, not automatic prewarming on GET or session open.
All inference uses the loopback fixture; no real model account is used.

## Two-times baseline

Both are five fresh-process runs on macOS arm64 / Apple M1 eight cores / Node 24.18.0, the current dirty tree copied
into temporary checkouts. Current production sources are the two retained phase-1 optimisations. No code changes
between measurements. The timing lock reported `highLoad: false` for both.

| Scenario                   | Median A / B         | Native launches (each run) | SQL statements (each run) | JSON parses (each run) |
| -------------------------- | -------------------- | -------------------------- | ------------------------- | ---------------------- |
| Cold explicit discovery    | 1,665.2 / 1,625.0 ms | 1                          | 86                        | 116                    |
| Warm explicit discovery    | 87.5 / 85.0 ms       | 0                          | 79                        | 68                     |
| Prompt on prepared segment | 109.1 / 106.3 ms     | 0                          | 176–202                   | 160–174                |

Cold/warm parse characters are stable at 413,701 / 213,838. Prepared prompt characters are 524,071–574,631 and pushes
also vary; register the actual combined spread, not an invented deterministic zero. Both discovery operations make
no inference and the prepared prompt makes exactly one, asserted in every run.

Reports: `/tmp/rt-readiness-a.json` (load 4.42→2.73) and `/tmp/rt-readiness-b.json` (2.30→2.53). Registered 35 metrics
as candidates from both reports with `node test/perf/ratchet.ts register ... --write`. No existing workload, baseline,
ceiling or tolerance was raised. Ledger guard passed. Ratchet on B passed both Git gates; 20 existing candidate
warnings remain visible (including session-open/command-catalog growth against the old ledger), not rebaselined away.

`npm run check`, `npm run lint`, `npm run format:check` and 7 ratchet tests passed after registration. The actual new
scenarios executed successfully in ten runs. Full runtime tests on the retained production code passed earlier in
the batch (439 tests), plus synthetic kernel and native-command proofs; the measurement addition changes no runtime
source. No UI/device/production readiness claim is made.

## Decision and next action

The existing native lifecycle already retains discovery's process: 1/0/0 starts, not three independent cold starts.
Moving discovery before a prompt would move cost, not remove it. Do not report a 1.6-second win or add automatic
startup. These are new baseline scenarios, not L1/L2/L3 improvements or the same operation before/after a fix.

Next authorised batch: add controlled startup phase counters/spans (resource validation/resolution/writes, verified
launcher, spawn/handshake, native resource/MCP readiness and registry), then remove a measured repeated stage.
Production journal collection changes still require separate approval; prefer test-only instrumentation first.
Stage 3 paging/protocol work is not yet implemented. This session closes at three experiments under the skill limit.
