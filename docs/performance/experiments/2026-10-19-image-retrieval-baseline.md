# Image retrieval: a measured baseline, not an optimization

## Question and decision

The October 19 journal snapshot put stored-message images first among HTTP costs: 53 requests, p50 1,271 ms,
p95 4,973 ms, 79.46 s total, about 1.87 MB reported mean wire bytes. They all came from one server session on
`8dcd0a00`; the newest release had no image samples. Does history lookup, base64 decoding, or response sending
reproduce that delay on synthetic data?

**Not in this loopback workload.** Across two batches of five runs, the single-image scenario medians are
37.2 and 38.5 ms, with roughly 1 ms in decoding. Keep the measurement. Do not optimize the database or introduce
an image cache on the assumption that either explains the production seconds. This adds L1 work observations
and controlled timing baselines; it proves no L1 reduction, L2 speedup, or L3 improvement. No work was removed.

## Method

- Branch: `perf/image-retrieval-measurement`, based on `58fa3ce95da4` (also `origin/main` during measurement).
  Reports label the uncommitted measurement-only checkout `58fa3ce95da4-dirty`; no `src/`, `web/`, credential,
  native-boundary, journal-collection, or service change is included.
- Apple M1, 8 cores, `darwin-arm64`, Node 24.18.0, pinned rotom 0.1.25. Fresh temporary checkout and data for each
  full benchmark run. Existing scenarios remain before the new fixture and probe installation.
- Seed a separate kernel-mode session's real Durable mirror with 24 native-format user messages, each with
  6,000 text characters and a distinct valid 1024×640 RGB PNG. Level-zero deflate fixes each PNG at 1,967,083 bytes
  (about 1.88 MiB); 24 images represent 47,209,992 binary bytes, about 63 MB of base64 before record metadata.
  This mirrors the persisted shape that image GET actually reads, rather than adding an upload/model benchmark.
- `image.single`: authenticated GET of image 0. `image.concurrent`: four concurrent GETs of distinct images 1–4,
  after the single scenario. Both consume and compare exact response bytes, MIME and cache headers; both assert
  zero inference and child-process starts. No browser cache. Existing quiet rule is unchanged.
- `test/perf/images.ts` installs benchmark-local wrappers and restores them in `finally`. Request-local
  AsyncLocalStorage separates overlapping requests. The actual lookup, decode, and HTTP handler still execute.
  It never substitutes fixture bytes for the server response or records image contents.
- Lookup time includes the harness mutation queue, SQL, JSON parsing, and any ancestry checks. Decode time wraps
  actual `Buffer.from(..., "base64")` calls inside `entryImage`, excluding lookup scopes. Send/finish time begins
  immediately before the real `response.end()` and ends at server `finish`; this includes buffer/flush waiting,
  not proof that the browser received or painted the bytes. Client time covers GET through full `arrayBuffer()`.
  Scenario wall time additionally includes validation. Concurrent phase times are sums of request intervals,
  **not** batch wall time, and can overlap. Routing/selection overhead is outside the named subphases.

Commands (all timing commands went through the machine-wide lock):

```sh
node .agents/skills/rotom-team-performance-climb/scripts/timing-run.mjs image-baseline-a -- npm run perf:measure -- --runs 5 --out /tmp/rt-image-baseline-a-20261019.json
# Lint/full tests and inspection between the two batches, not concurrent with timings.
node .agents/skills/rotom-team-performance-climb/scripts/timing-run.mjs image-baseline-b -- npm run perf:measure -- --runs 5 --out /tmp/rt-image-baseline-b-20261019.json
npm run perf:compare -- /tmp/rt-image-baseline-a-20261019.json /tmp/rt-image-baseline-b-20261019.json
node test/perf/ratchet.ts register /tmp/rt-image-baseline-a-20261019.json /tmp/rt-image-baseline-b-20261019.json --write
node test/perf/ratchet.ts guard /tmp/rt-image-ledger-before-20261019.json test/perf/ledger.json
node .agents/skills/rotom-team-performance-climb/scripts/timing-run.mjs image-ci -- npm run perf:ci -- origin/main --out /tmp/rt-image-ci-20261019
```

Lock loads: A 1.73→2.95, B 1.65→2.84, CI 0.96→3.05, all `highLoad: false`. Report loads after checkout setup:
A 3.59→2.95, B 1.68→2.84, CI 3.59→2.88, all below 8 cores. These are controlled loopback timings, not a replay
of production load or network conditions.

## Measurements

Medians of five runs per batch, milliseconds:

| Scenario / boundary                   | Batch A | Batch B |
| ------------------------------------- | ------: | ------: |
| Single: scenario wall time            |    37.2 |    38.5 |
| Single: full client body              |    35.0 |    36.1 |
| Single: server handler through finish |    22.8 |    23.5 |
| Single: lookup including queue wait   |    10.6 |     9.2 |
| Single: base64 decode                 |     1.2 |     1.0 |
| Single: end to finish                 |    11.0 |    14.7 |
| Four concurrent: batch wall time      |    83.5 |    80.8 |
| Four concurrent: summed lookup        |    24.0 |    21.9 |
| Four concurrent: summed decode        |     2.7 |     2.5 |
| Four concurrent: summed end to finish |    50.4 |    48.4 |

Every image timing comparison is `noise`, as expected for repeated measurements of the same code. Medians of
separate phases must not be added into an invented median total. Across the ten runs, single scenario wall time
ranges 29.5–44.7 ms; the concurrent batch ranges 60.8–99.7 ms. Neither reproduces the journal's seconds.

Stable work across all ten registration runs, also unchanged in the later CI base/head control:

| Counter                                     |    Single | Four concurrent |
| ------------------------------------------- | --------: | --------------: |
| SQL statements / rows                       |     1 / 1 |           4 / 4 |
| JSON parse calls (all Durable storage)      |         1 |               4 |
| JSON characters parsed                      | 2,629,033 |      10,516,152 |
| History lookups / base64 decodes            |     1 / 1 |           4 / 4 |
| Base64 characters decoded                   | 2,622,780 |      10,491,120 |
| Decoded / received body bytes               | 1,967,083 |       7,868,332 |
| HTTP requests                               |         1 |               4 |
| Child processes / native RPC notify records |     0 / 0 |           0 / 0 |

This path reads one requested row per image, not all 24 image records. Do not interpret the zero Node `readSync`
counter as zero SQLite I/O: that counter does not instrument SQLite's native reads. Background stringify work
varies 0–34 characters even in these quiet windows; it remains a candidate with its observed spread.

## Verification and ledger

- `npm run check`, `npm run lint`, `npm test`: pass (487 tests, including two new image tests).
  One full-suite attempt passed all test cases but failed the unmodified `session-attention-ui.test.ts` after-hook:
  `ENOTEMPTY` while removing its Chromium profile (a TransportSecurity temporary file remained). Its isolated
  rerun with the image tests passed 5/5; the unchanged full-suite rerun passed 487/487. The failed profile had no
  remaining matching process and was removed afterward. No cleanup retry, timeout, assertion, or production
  behavior was weakened; a recurring browser-shutdown race belongs in a separate test-maintenance change.
- New tests validate PNG chunks/CRC/pixel layout, exact concurrent binary readback, image indexing across text
  parts, unchanged MIME/cache headers, missing/invalid image indices, unrelated-session rejection, and no-token
  rejection. They also verify hook restoration and request-scope isolation from unrelated base64 calls.
- Negative controls: an extra requested sample fails observation-count validation; 401/404 responses cannot be
  reported as successful retrieval; unfinished/close-before-finish lifecycle controls are unavailable, not zero.
  A deliberate duplicate decode preserves response bytes but changes calls 1→2 and decoded bytes ×2, failing
  the single-decode assertion. This tests counter sensitivity, not timing correlation or gate promotion.
- Register added **102 darwin-arm64 candidates**, 51 per new scenario. Every existing ledger entry is byte-for-byte
  equivalent after JSON parsing; no ceiling/baseline/tolerance was raised and no counter was promoted.
- Both baseline ratchet checks and the ledger guard pass. Alternating CI against `origin/main` (three base and
  three head runs using the same new instrument) passes ratchet and guard. Image counters do not change.
- CI prints five upward changes outside images: `turn.warm` parse characters +7 and stringify characters +2;
  `turn.paced` parse characters +10; `turn.prepared` Durable-scope parse calls +2 and characters +298. These are
  A/A variation, not necessary new runtime work: base/head product source is identical, and the common benchmark
  plus image instrumentation is identical on both sides. Warm parse/SQL call counts stay fixed; one prepared
  head run also has extra SQL/parse work. Exact metadata/background-event attribution was not traced. Existing
  candidate warnings against historical baselines are not silently tightened or raised. The unrelated CI
  `web.paced/eventParseMs` label `faster` is not a causal improvement claim from this measurement-only change.

## Limits and next action

The fixed mirror is recently written; this is not cold OS cache, native import/upload/resize, active-task queue
contention, a slow receiving client, remote network/proxy/TLS, browser decode/painting, or the exact production
history. Permission/ancestry behavior is not changed; these new tests do not replace the existing fork tests.
Server `finish` is not end-user completion. No production data or raw image was copied into fixtures.

The next useful measurement is one controlled capture on the actual slow access path: pair the existing server
request duration with browser request timing and response completion for an approved session, distinguishing
waiting-for-response from receiving bytes. The coding agent should ask the owner to select/authorize that session
before accessing private browser history/content or collecting a new trace. Do not alter journal collection or
restart the service to fill this gap. If real-path capture is not authorized, retain these baselines and do not
claim a root cause or implement a speculative cache.

Raw reports and the previous ledger copy remain under `/tmp`; temporary benchmark checkouts/data are removed by
the runners. No push, installation into the service, or deployment is part of this experiment.
