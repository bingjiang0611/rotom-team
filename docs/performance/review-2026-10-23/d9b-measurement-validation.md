# D9b prerequisite: image completion measurement

## Result and limits

The corrected common instrument passes the full locked main/head three-pair CI run, including gating and ledger guard. The change is measurement-only and will be committed separately from D9b runtime deletion. It does not claim a latency improvement.

Three original final attempts failed `probeImages.report` in a base run: `perf-final-2` and `perf-final-4` at base sample 1, `perf-final-3` at base sample 2 after one complete base/head pair. The logs identify an unfinished/aborted phase, not which individual field was missing. Those lost per-sample fields cannot be reconstructed.

Failure-only diagnostics were tried in three standalone base runs and a full diagnostic pair; all passed. Do not claim these captured the natural failure or uniquely explained every historical failure. A controlled real `ServerResponse` lifecycle did reproduce the same assertion with `aborted:false, finished:false, ended:true, status:undefined`; delivering `finish` alone made that same sample reportable. This confirms a real ordering gap: awaiting the client body is not a receipt for the server's independently observed finish callback.

## Minimal correction

- `test/perf/images.ts`: each observed response has one promise resolved by its existing `finish` or `close` listener. `settled()` awaits those receipts. Resolving on close does not mean success: the unchanged synchronous report still rejects aborted responses, missing end/finish, wrong request counts and non-200 results.
- `test/perf/scenarios.ts`: wait immediately before image reporting, **inside the original measured window**. Requests, concurrency, PNGs, body comparisons, no-inference assertions and counter definitions are unchanged. No work is moved outside the window.
- `test/perf-images.test.ts`: real binary/authorization/range/cache/sensitivity checks remain. Explicitly wait for response settlement before their reports/reset. A controlled end-before-finish case proves the promise stays pending; a close-before-finish case still rejects reporting.
- `test/perf/checkout.ts` already puts this same instrument on both sides; no checkout or base-runtime modification was needed.

No sleep, retry, poll, wider timeout, skipped assertion, ledger/workload/quiet-rule change, production hook or vendor change was added. The controlled test uses one event-loop turn to drain microtasks before checking that an **unemitted** finish remains pending; this is not a benchmark delay.

## Verification

| Check                                                                 | Result                                                                     | Evidence                                                           |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Image/compatibility tests                                             | 4/4 pass                                                                   | `image-fixed-final.log`                                            |
| Negative control: replace receipt wait with `await Promise.resolve()` | 1 expected failure: `settlement must not acknowledge an unobserved finish` | `image-negative-final.log`; real implementation restored afterward |
| Same fixed image tests on isolated D9a runtime                        | 4/4 pass                                                                   | `measurement-d9a-tests.log`                                        |
| `npm run check`, `npm run lint`, `npm run format:check`               | all exit 0                                                                 | `measurement-{check,lint,format-check}.log`                        |
| Default `npm test`                                                    | 723/723, no skips; 249392 ms                                               | `measurement-test.log`                                             |
| Locked final main/head CI                                             | exit 0; all three pairs, gating and ledger guard passed                    | `perf-final-fixed.log`, reports in `perf-final-fixed/`             |

The first negative-control check exposed an insufficient single-microtask test: an async no-op could still appear pending. The test was strengthened to drain an event-loop turn, and the same no-op then failed as required. No product assertion was weakened.

Final command:

```sh
node .agents/skills/rotom-team-performance-climb/scripts/timing-run.mjs D9b-final-fixed -- npm run perf:ci -- origin/main --out /tmp/rotom-review-D9b/perf-final-fixed
```

Node 24.18.0, darwin-arm64, M1 / 8 cores; 656179 ms; load 5.69 → 5.36; highLoad=false. Source runtime is identified by `d9b-source-files.json`; the four native proofs and six archive/rollback probes used byte-identical production source before this measurement-only correction. Raw diagnostic, control and acceptance logs remain under `/tmp/rotom-review-D9b/`.

The corrected-instrument D9a baseline completed three runs under the same lock (334990 ms; load 11.58 → 8.85; highLoad=true). Its counters are retained, but timing verdicts are not valid L2 evidence. Earlier launch attempts correctly exited 75 while another workspace held the timing lock; an event-based wait observed release, and the normal lock acquisition was still required. No lock was removed or bypassed. Earlier pre-cleanup/old-instrument measurements remain diagnostic only. See `d9b-performance.md` for the final comparisons and explicit remaining sampling limits.
