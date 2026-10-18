# Measure room projection parts and browser view work

First experiment in the fifth climb batch: measurement only. Time live/inbox/native-kernel projection construction
with a subscriber-only diagnostics channel; count each construction independently. In the real browser store, opt-in
`window.__rotomPerf` counters count SSE parsing and entry-map copy/merge/prune work, with elapsed parse/apply time.
Only the controlled Chromium benchmark installs the counter object. No production journal schema or protocol changes.

A new `web.paced` key runs last: a fresh signed-in Chromium tab opens the seeded 12-turn history unmeasured, then one
paced prompt is timed through the final DOM answer. Existing `web.open` and all other workload inputs remain unchanged.
Client counters include quiet-window updates like existing work counts; page timings stop at the answer. SSE only,
not the polling fallback. Missing Chromium remains unavailable, not zero.

## Two-times baseline

Five fresh runs per report on macOS arm64 / Apple M1 eight cores / Node 24.18.0 / rotom 0.1.25. Both timing locks
`highLoad: false`. Reports `/tmp/rt-payload-browser-a.json` load 2.48→2.76 and
`/tmp/rt-payload-browser-b.json` 2.49→2.50.

| Scenario            | Browser parse calls / chars | View events | Existing entry-map copies | Delta entries | Prune checks |
| ------------------- | --------------------------: | ----------: | ------------------------: | ------------: | -----------: |
| Open seeded history |                  9 / 90,791 |           1 |                         0 |            24 |           24 |
| Paced reply         |          13 / 59,118–60,718 |          10 |                       248 |             2 |           51 |

Counts other than streamed character size have zero spread. Browser parsing totals 0.5–1.1 ms, applying views
0.2–1.2 ms on paced reply; all script work totals 14.2–32.9 ms. Most view events carry no entry/order delta but still
copy the existing Map. Opening needs all 24 entries and is not the copy target.

Four-tab server projection spans: open kernel 2.3–2.9 ms, live/inbox below report rounding; paced kernel typically
13.3–14.6 ms (one 3.8 ms sample), live 0.1–0.6 ms, inbox below rounding. Spans accumulate until the scenario action
result; late quiet-window calls are in construction counters but not those phase spans. Browser `web.paced` includes
native history resume on submit (the restart earlier in the workload closed its runtime), so its 2.9–3.1 s is not a
warm-stream latency baseline. It is still an exact browser copy workload. No L1/L2/L3 improvement is claimed.

Registered all new observations from both reports as candidates; ledger guard/ratchet pass, no promotion. Type/lint,
22 targeted projection/cache/ratchet tests and browser-backed five-run reports pass. Scope does not cover real accounts,
Linux, multi-tab browser rendering, polling fallback, large extension widgets or a long browser history.

## Decision

Attempt one narrow client optimization: reuse the immutable entries Map when an incremental view carries neither
entries nor order. Keep the view object new for live/status updates; full/switch/delta/order/reset paths retain copying
and pruning. Native-kernel projections are the larger server lead, but their per-viewer command/member binding and
unknown-state checks must not be cached without a separate exact-invalidating counter investigation.
