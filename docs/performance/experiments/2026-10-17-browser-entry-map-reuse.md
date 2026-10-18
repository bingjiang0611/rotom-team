# Reuse browser entry maps for live-only updates

Second experiment in the fifth climb batch. Hypothesis: when a view event has neither entries nor order, transcript
state is unchanged and its immutable `Map` can be shared with the next view snapshot instead of cloned.

## Implementation and behavior

`web/store.js` now clones only when `data.entries.length > 0` or an `order` field is present. The containing view object
is always new, so live, inbox, kernel, stats, presence, approvals and changed slow fields still update and subscribers
still run. Full/switch views start from `emptyView`; append/replacement/order-only reset copy before mutation. No Map is
mutated after publication. Server payload and protocol are unchanged.

A focused test executes the real reducer source and covers identity reuse with fresh live/kernel fields, append,
replacement, order-only reset (including empty order), full reconnect, non-empty and empty conversation switches, and
prior-snapshot immutability. Forced always-copy negative control fails map identity; forced always-reuse fails append
snapshot isolation. Logs `/tmp/rt-view-map-no-reuse-control.log` and `/tmp/rt-view-map-mutation-control.log`.

## Base/head, five fresh runs each

macOS arm64 / Apple M1 eight cores / Node 24.18.0 / rotom 0.1.25. Base
`/tmp/rt-payload-browser-b.json`, load 2.49→2.50; head `/tmp/rt-view-map-head.json`, load 2.61→4.58. Timing locks
reported `highLoad: false`, but the head's higher absolute load reinforces treating timing as noise.

| Scenario            | Existing Map entries copied base → head |  Duration median base → head |
| ------------------- | --------------------------------------: | ---------------------------: |
| Browser paced reply |                                248 → 49 | 3,046.2 → 2,960.4 ms (noise) |
| Browser open        |                                   0 → 0 |     125.6 → 130.7 ms (noise) |

All head copy counts are identical across five runs. The remaining 49 copies are the two real transcript revisions:
24 old entries for append, then 25 for order/replacement. Eight live/status-only view updates now copy zero. Entry
deltas, prune checks, order IDs, SSE bytes and view-event count are unchanged. `viewApplyMs` remains about 0.6–0.8 ms,
so there is no L2 claim. The 3-second browser-paced timing includes native resume/start and is not a pure rendering
number.

`perf:check`, `perf:propose --write` and ledger guard pass; only the targeted candidate tightened. Type/lint and the
three focused tests pass; full verification is recorded at batch close. Keep as **L1 only**. Removed copying is not
deferred: unchanged immutable transcript state is shared. No production service, account or protocol touched.

Next measurement/decision: native-kernel projection costs around 13–15 ms over a four-tab paced scenario, but its
output contains viewer-specific ownership and rapidly changing dialogs/status/widgets/pending/command revisions. Do
not cache it wholesale. First split stable binding data from dynamic per-viewer/live data and count command catalog
revision computation before selecting a safe optimization.
