# Account for warming started by an open page — 2026-10-22

## Question

Opening a native session now starts warming before composer focus. Does the browser benchmark account for that work,
or let it escape into the next scenario?

## Finding

The first five-run `perf:ci -- origin/main` comparison passed the ratchet and ledger guard, but `native.warm` fell from
about 1996 to 4 ms while `turn.prewarmed` rose from 112 to 1873 ms. This was not a faster warm start. The previous browser
page had started warming another session for the same member; SQL and pushes went quiet while that process initialized.
The browser helper then closed its page and the next explicit warm request was refused by the existing one-warm-per-member
admission limit. Its supposedly prewarmed send was cold. These two timings must not be cited as performance improvements
or regressions of the native engine.

## Instrument repair (separate commit)

`test/perf/browser.ts` tracks only page-started `/warm` fetch promises in its document-start instrumentation. Before
closing the page or beginning the next scenario, it waits for those promises to settle and for the existing quiet rule.
It does not change the quiet rule, input, output, think time, ledger, or paint endpoint. Warm startup is now counted in
the open scenario that caused it, rather than being hidden outside all windows or charged to a later scenario.
Browser paint timing remains the marker's first painted frame, not warm completion. Earlier process startup is work
moved before send, not eliminated work. The same instrument is copied into both comparison checkouts.

## Check

One alternating accounting check against `c61d8fd`, with the pending implementation, passed the ratchet and ledger guard
(`/tmp/rt-proposal2-accounting`, `highLoad: false`). Explicit `native.warm` started one native process on both sides
(1978 / 1924 ms); `turn.prewarmed` started none (116 / 114 ms). This is an instrument sanity check, not L2 evidence.
The previous contaminated five-run report remains at `/tmp/rt-proposal2-ci`; its warm/prewarmed timings are invalid.

The final implementation experiment must repeat the five-run comparison with this repaired instrument and describe
additional open-time work and the remaining production-only activation steps. No real model account was used.
