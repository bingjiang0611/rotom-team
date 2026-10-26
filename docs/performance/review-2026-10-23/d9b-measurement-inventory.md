# D9b prerequisite: image measurement completion inventory

User explicitly authorized a separately scoped measurement diagnosis/fix after three final CI failures. This inventory precedes implementation. Keep this measurement commit separate from the D9b runtime deletion.

## Evidence and scope

- `perf-final-2`, `perf-final-3`, `perf-final-4` all failed the strict `probeImages.report` lifecycle assertion in base runs, not a counter gate. Attempt 3 completed one base/head pair before the next base failed.
- `test/perf/checkout.ts` already copies the **same current measurement files** into both checkouts. No change to checkout semantics, base runtime, main branch or runtime source is needed.
- `test/perf/scenarios.ts` fully awaits each real image response body, but then synchronously reports the server's independently delivered `finish`/`close` events. Diagnose the missing sample fields before attributing the failure to that ordering.

| File                       | Allowed change                                                                                                                                    | Invariant                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/perf/images.ts`      | Temporary failure-only diagnostics; if confirmed, add an event-backed completion receipt and a method that waits for observed responses to settle | Preserve exact request-count, non-aborted, end/finish and HTTP 200 assertions; never turn aborted/missing phases into zero. No sleep, retry, polling or wider timeout. |
| `test/perf/scenarios.ts`   | Await those receipts **inside** the existing image measurement window before reporting                                                            | Same requests, concurrency, data, bytes, model prohibition and workload. No work moved outside the window.                                                             |
| `test/perf-images.test.ts` | Add a controlled delayed-finish/abort check and await settlement before real-response assertions/reset where needed                               | Keep all independent binary, authorization, cache, range, sensitivity and error assertions.                                                                            |
| Evidence documents         | Record diagnosis, negative control, tests and paired measurements                                                                                 | No latency optimization claim from a measurement correction.                                                                                                           |

`test/perf/workload.ts`, `ledger.json`, tolerances, counter definitions, quiet rules, production journal, vendor files and credential routing remain unchanged. No merge/rebase/main push or production action is authorized.

## Acceptance

Capture the original missing fields in a failed diagnostic run. Prove the new wait remains pending before finish and that aborted responses still fail reporting. Run the existing image compatibility/sensitivity tests and full static/default checks; run the final unchanged locked `perf:ci` pair with the corrected common instrument. Commit only measurement files/evidence in the prerequisite commit, then resume D9b verification/delivery. Do not claim the earlier pre-cleanup performance run verifies the final runtime.
