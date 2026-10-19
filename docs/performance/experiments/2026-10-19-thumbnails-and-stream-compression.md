# Program 1, first batch: thumbnails and compressed views

## Scope and decision

Keep thumbnails/previews, a bounded derived-file cache, and gzip for event streams and large long-poll answers.
This is **part** of [Program 1](../2026-10-19-proposals.md), not completion of the three approved programs.
No live service, journal collection, account, credential routing, native product, or deployment was changed.

Three experiments close this batch: loopback thumbnail generation/reuse, streaming compression, and first-image
transfer on an emulated constrained link. Stop here before starting another optimization hypothesis.

## Method

macOS arm64 / Node 24.18.0. The original image scenarios remain unchanged, including exact binary readback and
lookup/decode sensitivity controls. Separate measurement commits add `image.thumbs.first`, `.again`, and `.network`.
All use the same synthetic native-format Durable mirror (24 images, each a distinct 1024×640, 1,967,083-byte PNG).
Four images per thumbnail batch. Existing scenarios run before these new ones.

`.first` includes source lookup, generation, disk writes and response; `.again` repeats without a browser cache.
`.network` downloads **previously unrequested** thumbnails in real Chromium, cache disabled, then decodes them with
`createImageBitmap`. CDP emulates 4 Mbit/s and 40 ms latency; resizing is inside the measured wait. This is a fixed
synthetic link, not a production-network replay. No sleeps, real accounts or workload/assertion weakening.

Final verification uses `npm run perf:ci -- origin/main --runs 3 --out /tmp/rt-p1-final`, alternating base/head on one
instrument. Base `58fa3ce95da4`; runtime head `4cbe56d`. The timing lock reports `highLoad: false`, load 4.43→2.80 on
8 cores. Earlier independent reports: `/tmp/p1-base.json`, `/tmp/p1-head.json`, `/tmp/rt-p1-ci/`,
`/tmp/rt-p1-network/`, and `/tmp/p1-repeat.json` (also all `highLoad: false`).

## Final numbers

| Scenario / counter                                      |           Base |    Head | Interpretation                                                             |
| ------------------------------------------------------- | -------------: | ------: | -------------------------------------------------------------------------- |
| Four first thumbnails, body bytes                       |      7,868,332 | 422,503 | L1: 94.6% fewer bytes                                                      |
| Four first thumbnails, subprocesses                     |              0 |       8 | Necessary new work: probe + resize per image, at most two images at a time |
| Four first thumbnails, JSON stringify chars (worst run) |             34 |   1,406 | Necessary new work: small private cache records                            |
| Four first thumbnails, median loopback ms               |           46.9 |   233.3 | **Slower**: first generation costs time on loopback                        |
| Four repeated thumbnails, SQL statements / parsed chars | 4 / 10,516,152 |   0 / 0 | L1: source read/decode is not repeated                                     |
| Four repeated thumbnails, median ms                     |           53.1 |     9.3 | L2: comparison says `faster` (82% lower)                                   |
| Four first thumbnails on emulated link, body bytes      |      7,868,332 | 421,949 | Separate images from loopback scenarios                                    |
| Four first thumbnails on emulated link, median ms       |       15,808.2 |   989.1 | L2: comparison says `faster` (94% lower), includes first resize            |

The earlier constrained-link comparison was 15,798.9→996.8 ms; independent head repeat was 966.4 ms.
No L3 improvement claim: the new code has not run in production.

## Where the work went

- Originals remain in Durable and the original URL still returns identical bytes. The transcript requests a 480 px
  thumbnail; the full-screen viewer requests a 1600 px preview, and **Open** opens the original. macOS `sips` runs
  asynchronously. GIFs keep animation, small images are not enlarged, PNG keeps transparency, larger outputs are
  discarded. Unsupported platforms and failures return the original.
- Copies and small owner records live under `<data>/media/`. Every request retains session authorization and fork
  ancestry checks. Cache hits do not deserialize the original entry. They **do** stat/read/hash a derived file;
  `fs.read.*` currently counts synchronous reads only, so zero there does not mean zero file I/O. Source SQL/parsing
  and payload-byte reductions are the L1 claims, not elimination of all storage work.
- Disk is capped at 256 MiB / 8192 files; in-memory records and failed-resize markers at 4096; pending generation jobs
  at 16; only two original bodies are held for active resizes. Overload falls back to originals. The first use after
  restart streams the cache directory, trims old files, and removes stale temporary files. Source images remain
  authoritative and evicted copies are regenerated. Cache failure cannot turn a readable original into a 500.
- Metadata is validated, cache reads do not follow symlinks, sizes are checked before reading, and derived bytes are
  checked against their stored digest. Missing/truncated/modified copies are regenerated rather than sent with a
  one-year immutable lifetime. Private derived files are still included by the existing offline backup tool; this
  batch does not change backup collection or restore semantics.
- SSE gzip uses an asynchronous compressor per stream and `Z_SYNC_FLUSH`, so every event is available immediately.
  `gzip;q=0` is respected, including alongside a wildcard. Large polls are compressed asynchronously. Stream backlog
  is capped at 8 MiB; overflow disconnects/detaches the tab for a fresh view, never silently drops a delta. Raw logical
  push counters are unchanged by compression; they are not compressed wire-byte measurements.

## Costs and counters that grew

Every counter is considered separately; smaller images do not cancel out unrelated increases.

- Initial thumbnail generation adds eight subprocesses and 1372 worst-case stringify chars per four-image batch.
  This work is done once and the loopback wait is explicitly worse; the link scenario measures when fewer bytes
  outweigh generation. No claim that first retrieval is universally faster.
- The final warm-turn head run was 245.9 ms with two view pushes, versus 52.5/80.3 ms with one. The extra 90 ms
  coalescer flush adds one live/inbox/kernel projection: +14 SQL statements, +17 rows, +12 parses / 50,009 chars,
  +12 field serializations / 117 chars, +1 head query, +2 attempt queries, +2 command-input queries, and +1 view push /
  1,249 bytes. These are real extra work for an intermediate view, not hidden or offset against the image savings.
  Coalescing/freshness behavior is unchanged; no turn-performance improvement is claimed.
- Paced and prepared pushes carry different-sized live messages depending on where chunks meet that same coalescer:
  final worst view bytes grow by 2400 and 4625 respectively, with corresponding stringify growth. Counts are not
  weakened, timing is not retuned, and no push optimization is claimed. Earlier 3-run comparisons also showed one
  prepared run with two extra 149-character Durable document metadata decodes (already present before gzip).
  A diagnostic-only scoped trace confirms 149-character document metadata is read by `checkDocumentActions` and
  `applyDocumentActions`; it did not reproduce that extra pair and is not a ratchet baseline.
- An earlier comparison showed +34 global stringify chars in large open; this was not reproduced in the final
  comparison (large-open push count/body are identical: 14 / 112,462). A scoped diagnostic did not reproduce the
  extra 34 characters. This variation is not an optimization claim or justification for weakening a counter.
- Large four-tab open changes from median 42.1 to 52.4 ms; the final comparison calls it noise (one earlier comparison
  called it slower). Compression adds per-stream setup/worker scheduling and has a latency cost. Likewise session
  open/list and Changes timing regressions from an earlier 3-run comparison were not consistently reproduced.
  The final comparisons call those noise; no improvement is claimed. Native helper timing is 0.3→0.8 ms, classified
  slower; the helper path was not changed in this batch, and the absolute sub-ms difference is not assigned to images.

## Verification

- `npm run format`, `npm run check`, `npm run lint`, `npm test`: pass; **503 tests**, no skips/failures.
- New coverage: cached/first/fork/foreign lookup, resize failures, concurrent request sharing, queue limits, disk quota,
  restart, malformed records/traversal, corrupted bodies, small/GIF/transparent images and real macOS `sips`.
- HTTP coverage preserves exact original bytes, immutable headers, index validation and authentication. The existing
  duplicate-decode sensitivity control still fails its work assertion when deliberately enabled.
- Real Chromium follows the complete UI path: a 2048×1280 stored image becomes a 480×300 transcript image,
  a 1600-wide full-screen preview, and the original URL on **Open**. No real provider call.
- Gzip tests use real HTTP: identity/gzip/refused-gzip produce identical decoded SSE/poll events; every SSE event is
  delivered without waiting for stream end; a repetitive fixture's compressed bytes are under one tenth of identity;
  sustained pushes disconnect and detach an overflowing reader. Four tests.
- `npm run test:kernel:app`: pass, 82 synthetic loopback requests. The logged configuration-staging exception is an
  intentional injected recovery control; the final report says `status: passed`, `realProvider: false`.
- Final alternating `perf:ci` passes ratchet and ledger guard. Two independent 3-run head reports register 102 new
  counters as candidates only; `perf:propose --write` lowers 55 existing candidate baselines. That automatic tightening
  is **not** a claim that this code reduced work in 55 places. No gate promotion, ceiling raise or tolerance widening.

## Limits and next action

No production/device/tunnel/TLS verification. `sips` resizing is macOS-only; other platforms serve originals. A stream
initial view over the 8 MiB buffer cap disconnects and uses the existing browser fallback; long-history pagination
is still pending. Browser-local caching has its existing private-data implications.

The coding agent owns the next approved batch, still in Program 1: optional TLS/HTTP2 integration with compatibility
and journal-coverage verification, then browser paste resizing **with an original retained**, and reconsider original
file serving / ETag / Range with dedicated measurement. Those are not implemented here. Deployment or changing the
running listener still needs owner approval and the actual certificate/address configuration. After Program 1, proceed
to Program 2 (Changes indexing/deltas/subscriptions/browser cache/pagination), then Program 3; neither has started.
No new permission is needed for local implementation/tests under the existing approval; no native trust check may be
removed or patched around to finish them.

Raw benchmark, diagnostic and test artifacts remain under `/tmp/p1-*` and `/tmp/rt-p1-*`; all test servers and Chromium
children are closed, and benchmark temporary checkouts/data are cleaned by the runners. Nothing is pushed or deployed.
