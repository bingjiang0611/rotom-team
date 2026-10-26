# Reuse the projected history prefix on append (2026-10-26)

## Question and decision

Can a new message avoid visiting every old entry while rebuilding the room's display sequence? **Yes: keep the change at L1 (less work), not L2 or L3 (faster).** This does not explain or fix the production journal's 1.55 s median confirmed-message delay.

`Room.#sequence` already recognised an unchanged immutable prefix for the per-client cursor. It nevertheless traversed that entire prefix, performed cached-entry lookups and visible-entry filtering, and rebuilt the projected arrays on every append. Move the existing append predicate before construction, copy the previous projected arrays, and visit only the new source suffix. Keep the predicate, head-reset rebuild, visible order, revision tracking, independent client cursors, access checks and push scheduling unchanged.

The removed work is repeated **projection-loop visits and Map lookups over old entries**. It was not moved into another process or outside the measured window. Array copies and `order.join(",")` still take linear work; this is not an O(1) append claim. No new cache, dependency, invalidation policy or configuration was introduced. Durable's `harness/view.js` preserves entry references on append and prepends a new marker for every head reset, including retained-suffix resets. The optimisation uses that existing contract, not a new assumption about mutable history.

## Method

- Isolated branch `perf/room-append-20261026`, based on measurement-only commit `e2a1eb0b59c5`. The original dirty workspace was not edited, staged or stashed.
- Measurement repair is separate: [image finish-event completion](2026-10-26-image-finish-measurement.md). Both sides use it. No benchmark workload, counter definition, quiet window or benchmark assertion was changed. No threshold tolerance or native boundary was relaxed. `view.entry.visits` now reports the actual suffix loop length.
- Apple M1, 8 cores, darwin-arm64, Node 24.18.0. Five complete base runs and five complete head runs, fresh fixed-length temporary checkouts, synthetic loopback provider and real Chromium. Existing `web.send.stream`, `.poll`, `turn.warm`, `turn.paced`, `web.paced` and `projection.large.paced` scenarios were reused.
- Commands: `timing-run.mjs send-base -- npm run perf:measure -- --runs 5 --out /tmp/rt-send-base-20261026.json`, then the same for head, and `npm run perf:compare -- /tmp/rt-send-base-20261026.json /tmp/rt-send-head-20261026.json`.
- Baseline wrapper load: 5.36 → 5.36, `highLoad: false`. Head wrapper load: 5.09 → 11.58, **`highLoad: true`**. Do not claim a millisecond improvement. Shared timing-lock contention returned exit 75; work waited for the recorded owner's exit and then acquired the normal lock. No bypass or parallel timing runs.

## L1 results

All five runs agree on each value below. The six candidate baselines were tightened on darwin-arm64 only. No candidate was promoted and no ceiling/tolerance was raised. `perf:propose --write` was run in the disposable baseline worktree; only these six reproducible, task-related proposals were applied to the implementation branch. Other proposed changes were discarded, and the baseline worktree's ledger restored.

| Scenario                 | Before `view.entry.visits` | After | Reduction |
| ------------------------ | -------------------------: | ----: | --------: |
| `turn.warm`              |                          8 |     2 |     75.0% |
| `turn.paced`             |                         19 |     2 |     89.5% |
| `web.paced`              |                         59 |     2 |     96.6% |
| `web.send.poll`          |                         65 |     3 |     95.4% |
| `web.send.stream`        |                         69 |     2 |     97.1% |
| `projection.large.paced` |                        267 |     2 |     99.3% |

The 64-turn/four-tab scenario keeps SQL statements at **490** and view pushes at **44** in every base and head run. Thus its 267 → 2 reduction is not from fewer updates or a skipped client. Full output/history assertions remain in the benchmark. Do not credit the timing-sensitive reductions in other counters as additional wins.

The stream send's confirmed-message paint is 108.2 → 119.4 ms median; first-reply paint is 1,090.6 → 1,100.2 ms (the synthetic provider deliberately waits before answering). These numbers do not demonstrate a regression or gain on the loaded head run. More importantly, even the baseline only takes about 0.1 s to confirm the message, so this local fixture does **not** reproduce the production 1.55 s median. Extending the fixture to representative remote latency/history remains the next investigation, not an achieved result.

## Regression accounting

See [the complete worse-counter inventory](2026-10-26-room-append-counters.md). All 40 counters marked worse in the five-run isolated comparison, and all 56 marked worse against `origin/main`, are retained there rather than hidden by the entry-visit improvement.

- Cold sends gain one view push in two head runs; stream sends gain two or four in the final two head runs. Their extra SQL, projection, serialization and browser-application work moves with those pushes. The first three head runs match base's stream push/SQL counts exactly; no per-push safety work was removed. The unchanged 90 ms scheduler makes these counts timing-sensitive. This is not evidence of an invariant extra query introduced by the new suffix loop, nor a claim that those increases do not matter in real use.
- Startup restart has no attached clients or append projections. Its +1 storage parse/+19 characters is outside this optimisation's executed path. Small character-only differences in other scenarios retain the same protocol/schema; no response fields were added by this change. No baselines for these variations were tightened or loosened.
- `origin/main` is `e649d9d8a0ff`, well before the frozen implementation base. Of its 56 worse counters, **54 are already no worse than the frozen base's measured worst**. The other two are browser variation within their unchanged tolerance of 5: poll DOM nodes 1,620 → 1,621; stream style recalculations 112 → 115. Do not attribute inherited branch changes to this optimisation.

## Verification

- Strengthened existing room tests require one source visit for a visible append, one for a hidden append and one for append after a head reset. The unmodified baseline fails two tests (4 versus 1 visits; 2 versus 1). The optimised source passes.
- `node --test test/room-projection.test.ts test/native-room-info.test.ts test/perf-room-part.test.ts`: **11 passed**. Existing checks retain complete message/order readback, two independent tabs, hidden entries, missed revisions, full resend, head reset and retained suffix, restart, native room state and counter attribution.
- `npm run check`, `npm run lint`, targeted ESLint/Prettier and `git diff --check`: pass.
- `npm run perf:check -- /tmp/rt-send-head-20261026.json`: pass (2 gating and 1,756 candidate entries). No unavailable measurements in the isolated comparison. After the six ledger changes, the same check still passes; `ratchet.ts guard` reports no violations.
- `timing-run.mjs room-append-origin-main -- npm run perf:ci -- origin/main --runs 1 --out /tmp/rt-room-ci-20261026`: exit 0, gating check and ledger guard pass. It uses the same measurement instrument on both revisions. Load 8.85 → 5.22, `highLoad: true`; one run per side is a counter/regression check, not latency evidence.
- Full suite: `env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy NODE_USE_ENV_PROXY=0 npm test`: **725 passed, 0 failed, 0 skipped**, 223.5 s. This runs the unchanged test script with direct synthetic/local traffic.

Initial `npm test` attempts stalled with the ambient `HTTP_PROXY`/`HTTPS_PROXY` plus `NODE_USE_ENV_PROXY=1`. The unchanged baseline reproduced this. A temporary async-resource diagnostic found a retained TCP connection to the local proxy. With proxy variables removed **only for the test process**, unchanged baseline `app.test.ts` and `event-compression.test.ts` pass **45/45** in 8.3 s. No assertion, product configuration, system proxy or production data was changed. Interrupted test processes were stopped before the clean-environment run.

## Limits and next owner

Level reached: **L1 only**. No deployment, real model account, production mutation, push, L2 speedup or L3 improvement. Keep the optimisation because repeated prefix work demonstrably disappears while behaviour is checked. The agent's next experiment should add a separate measurement for representative remote send confirmation; do not retune the scheduler or remove safety checks based on unpaired production medians. A quiet paired benchmark would be needed before claiming this particular optimisation is faster.

Reports and logs remain under `/tmp/rt-send-*20261026*`, `/tmp/rt-room-*20261026*` and `/tmp/rt-test-*20261026*`. Only aggregate evidence is committed.
