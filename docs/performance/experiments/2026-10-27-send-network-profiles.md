# Send response-latency profiles — 2026-10-27

## Question and decision

Can a bounded, remote-style browser profile reproduce the October 26 journal's 1.554 s median confirmed-message wait?
Where does the controlled send wait: submit response, native dispatch, receipt of the confirmed message, or display?

**Keep two calibrated measurement scenarios, not a product optimisation.** They do not reproduce that production wait.
They also reveal an important limit: Chromium's response-latency setting is not physical round-trip latency on every
chunk of an already established event stream. Do not use this result to rule out real network propagation, buffering,
or production-side admission delays. No work was removed, and no L1 reduction, L2 speed improvement, or L3 improvement
is claimed. The server's 90 ms push coalescing and credential/unknown-outcome boundaries are unchanged.

## Instrument and controls

Measurement code: `44b01fe` (`test/perf/send-phases.ts`, `scenarios.ts`, and `workload.ts`).

- New keys: `web.send.poll.network` and `web.send.stream.network`. They run after every established scenario.
- Chromium resolves `perf-remote.test` to loopback. The page uses the application's non-local transport path.
  Each scenario gets a new browser profile. The model is the existing loopback fixture, not a real account.
- CDP applies **150 ms response latency** and **500,000 bytes/s in each direction**, before session navigation.
  The model's first-output pause remains 1000 ms, with the existing 6000-character paced answer and 25 ms chunks.
- Before shaping, a same-origin, no-store `/api/theme` request is timed. The same probe runs after shaping.
  Its elapsed time must grow by at least 120 ms (80% of the configured delay), or the benchmark fails.
  Both values are reported. Authentication, calibration, navigation and warming precede the send window.
  No existing work was moved out of a counted window.
- The original unthrottled Node event-stream observer remains the reference. Its receipt time is a proxy for local
  push delivery, **not a timestamp at the server's send syscall**. Browser/process clock calibration is unchanged.
- Network-specific user/reply markers prevent an earlier send in the shared history from satisfying the assertions.
  The original transport, confirmed-message, reply, native-run and quiet-window assertions remain active.
- `WORKLOAD`, every existing scenario description, and every existing counter list were checked for exact equality
  with the parent version. Only two keys were added. The old and new cases share the same counter list.

The histories are explicit, but not matched controls: original poll/stream opens 13/14 turns; the appended profile
opens 15/16 turns. Do not subtract their medians and call the result a causal network cost. Within-send phase gaps
below are calculated from paired timestamps in each run, then aggregated.

### Sensitivity control

Temporarily setting only CDP `latency` to zero made the benchmark fail at the calibration assertion:

```text
network control must observe the injected response delay:
2.700000286102295 → 3.3999996185302734 ms
```

The run exited 1 and produced no successful report. The 150 ms setting was restored and the three measurement files
matched their saved SHA-256 values. The later source edit only added braces around the calibration error throw.
The next three-run report passed on committed `44b01fe`. No skip, retry, timeout extension, or weakened assertion was
introduced. The negative control's wrapper marked `highLoad: true`; its failure is a correctness control, not timing
improvement evidence.

## Runs and observed phases

Both positive reports ran through the timing lock, at different times, on Apple M1, darwin-arm64, Node 24.18.0.
Proxy variables were removed for these test processes and `NODE_USE_ENV_PROXY=0`; production configuration was not
changed. Each report contains three complete runs, giving six observations per scenario.

| Report | Recorded revision                               | Wrapper wall time | Wrapper load before → after, 8 cores | `highLoad` |
| ------ | ----------------------------------------------- | ----------------: | -----------------------------------: | ---------- |
| A      | `1098d85a823d-dirty`, measurement before commit |         373175 ms |                          3.55 → 5.87 | false      |
| B      | `44b01fe99005`                                  |         364314 ms |                          2.98 → 6.47 | false      |

Median milliseconds from Enter, pooled across the six runs:

| Phase                                              | Original poll | CDP-profile poll | Original stream | CDP-profile stream |
| -------------------------------------------------- | ------------: | ---------------: | --------------: | -----------------: |
| Submit response complete                           |          20.5 |            168.1 |            20.7 |              168.3 |
| Native prompt dispatched                           |          61.0 |             43.2 |            45.3 |               57.8 |
| Node reference receives confirmed user message     |         107.6 |            103.3 |           107.1 |              107.8 |
| Browser receives confirmed user message            |         111.1 |            174.9 |           106.9 |              107.8 |
| Confirmed user message displayed                   |         119.9 |            186.3 |           120.9 |              117.7 |
| First reply displayed, including fixed model pause |        1097.4 |           1090.8 |          1087.7 |             1105.4 |

The application's own `send.shown` medians, using the journal metric's semantics, are **116.6 / 183.1 / 117.0 /
113.7 ms** in the same column order. That interval starts in the application's send handler, not at the independent
probe's Enter timestamp. Both observations remain far below the production median in this synthetic workload.

Calibration requests ranged from 1.8–3.2 ms unshaped to 156.9–163.5 ms shaped. The profile is observably active;
this is not merely a successful CDP command dispatch. The probe verifies response delay, not independent throughput
accuracy. Browser/process clock uncertainty is 0.2–1.1 ms across the sends.

Within the new scenarios:

- Poll reference-to-browser gap: median **71.4 ms**, range **66.1–76.3 ms**. Browser-to-display gap:
  median **11.5 ms**, range **9.4–14.8 ms**.
- Stream reference-to-browser gap: **−0.2 to +0.1 ms**, inside clock uncertainty, not negative network travel.
  Browser-to-display gap: median **9.7 ms**, range **3.1–11.2 ms**.
- Every shaped-stream send displays its confirmed message before its submit response completes. The displayed-message
  path does not wait for the POST response in these fixtures.

These six-run fixtures are not a population estimate for production. They neither reproduce the 1.554 s journal
median nor establish its cause. In particular, the stream result is a limit of this emulation, not proof that real
stream transport adds no delay.

## Ledger and verification

Registered **72 new candidate entries**, 36 per new scenario, from both reports. All 72 counters are measured in
both reports. Each darwin-arm64 baseline is the worst of the six runs; initial tolerance is their observed spread.
No counter was promoted. All pre-existing ledger entries are unchanged after JSON parsing: no ceiling,
baseline, tolerance, status, or evidence changed. Ledger guard passes with zero violations.

- `npm run check` and `npm run lint` pass.
- `node --test test/perf-phases.test.ts test/perf-ratchet.test.ts`: 8 pass, no failures or skips.
- Both complete three-run benchmarks pass, including their transport and confirmed-message assertions.
- Both `perf:check` commands pass their gating counters. Candidate alerts against the historical ledger are not gates
  and are not a claim of improvement; they were not cleared by loosening the ledger.
- Targeted formatting and `git diff --check` pass.

### Historical candidate alerts: unchanged-parent control

A separate detached checkout of **unchanged `1098d85`**, without the new instrumentation, completed three runs.
Wrapper: 313576 ms, load 1.99 → 5.12 on 8 cores, `highLoad: false`. Its two gates pass, and it already reports
**221 candidate alerts** against the historical ledger.

| New-instrument report | Candidate alerts | Same keys already alert on unchanged parent |
| --------------------- | ---------------: | ------------------------------------------: |
| A                     |              230 |                                         215 |
| B                     |              225 |                                         217 |

This is a control for pre-existing alerts, not a full attribution of every variation. The remaining keys and values
are retained in `/tmp/rt-remote-send-candidate-control-20261027.json`; they were not waived or labelled harmless.
The production source is identical between these revisions, and new profiles execute only after the old windows.
Exact scheduling causes for the remaining variations are not established. They do not support a speed claim or a
ledger relaxation. If one is selected for a later climb, the coding agent should isolate its workload and trace its
operations before changing code; this measurement change does not resolve those candidate leads.

## Artifacts and reproduction

Artifacts are local test files, not production data:

- `/tmp/rt-remote-send-a-20261026.json` and `.log` (the inherited filename says October 26; the run completed October 27).
- `/tmp/rt-remote-send-b-20261027.json` and `.log`.
- `/tmp/rt-remote-send-negative-20261027.log`.
- `/tmp/rt-remote-send-parent-20261027.json` and `.log` (unchanged-parent control).
- `/tmp/rt-remote-send-candidate-control-20261027.json` (all A/B candidate alerts joined to the parent control).
- `/tmp/rt-remote-send-check-a-20261027.log` and `/tmp/rt-remote-send-check-b-20261027.log`.
- `/tmp/rt-remote-send-ledger-before-20261027.json` and `/tmp/rt-remote-send-register-20261027.json`.

```sh
node .agents/skills/rotom-team-performance-climb/scripts/timing-run.mjs send-network -- \
  env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
  -u http_proxy -u https_proxy -u all_proxy NODE_USE_ENV_PROXY=0 \
  npm run perf:measure -- --runs 3 --out /tmp/send-network.json
npm run perf:check -- /tmp/send-network.json
```

## Limits and next decision

This fixed profile has no packet loss, jitter, TLS/proxy buffering, independently verified bandwidth, or per-chunk
physical propagation delay. It covers one small warm history, not a cold native process or production-scale history.
Changing the profile or workload needs new scenario keys, not different values under these keys. If a future question
is specifically about established-stream propagation, use a separately validated bidirectional link fixture or a
real network capture; this CDP profile is insufficient.

The October 26 production distributions cannot be joined into a per-send timeline. The next production-facing step
is anonymous, per-send phase correlation across submit, native admission/user-entry visibility, push receipt and
confirmed display. **Owner: coding agent after user approval to change journal collection.** First define its bounded,
content-free schema and synthetic checks; production deployment, profiling, and real-account use remain separate
permissions. Do not guess the production cause or change push scheduling from these fixture timings.
