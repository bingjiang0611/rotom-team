# Program 1 remainder: TLS/HTTP2, pasted screenshots and original-image caching

## Approval and scope

The owner selected all three local implementations: opt-in TLS/HTTP2 **and** HTTP/2 journal coverage; shrink large
pasted images and upload only the chosen representation (do not retain/upload a second original); cache originals
with ETag/Range. This updates the earlier original-preserving paste proposal. No push, production restart, listener
change, real account or native trust/payer/unknown-outcome change was authorized or performed.

Three hypotheses close this batch. Programs 2 and 3 have not started.

## Changes and where the work went

1. `listener.ts` and `main.ts`: paired `--tls-cert`/`--tls-key` PEM paths enable TLS with HTTP/2 and HTTP/1.1 fallback.
   Without them the listener remains plain HTTP/1.1. Read/validate before taking the port and opening the app.
   Server shutdown closes both protocol types, including open views. The old tunnel launcher explicitly refuses TLS
   flags rather than printing wrong URLs. Auth/link construction understands `:authority`, retaining the same token,
   Secure/HttpOnly cookie and permission checks. This removes the browser's six-HTTP/1.1-connection bottleneck when
   TLS is enabled; nothing enables TLS in production by default.
2. Separate measurement commit `f851972`: HTTP/2 diagnostics reach the same journal schema. Requests are attributed
   to this server, ids/queries remain redacted, HELD views/polls remain excluded, and shared-connection wire bytes
   are **null**, not zero or another stream's bytes. Collection change was explicitly approved. HTTP/1.1 coverage
   stays intact.
3. `web/pasted-image.js` and composer/store integration: static PNG/JPEG clipboard images over 2000 px are prepared
   before uploading, retaining aspect ratio/transparency and using a PNG only if smaller. No upscaling or second
   upload. Small/animated/unknown/unsupported/failed/unhelpful cases retain the input. GIF/WebP are left alone, and
   APNG control chunks short-circuit before decoding. Ordinary file selection is not modified. The destination
   session is captured before asynchronous decoding so switching sessions cannot retarget an upload.
4. `media.ts`: the same bounded cache now also holds byte-identical originals. Durable remains authoritative, and
   session/fork visibility is checked on every hit/restart. Source parse/base64 decode happen once, rather than on
   every Open/conditional request; source lookup is never replaced with permissionless hash access. Quotas include
   originals, not an additional unbounded store; oversized originals bypass disk caching. Corrupt copies/records
   are rebuilt; cache failure falls back to the previous source path. Derived-file behavior is preserved.
5. `http/stored-image.ts`: strong content ETag; weak/list/wildcard If-None-Match; single closed/open/suffix byte range;
   matching strong If-Range, unsatisfiable 416, full response for stale If-Range or unsupported units/multipart;
   read-only HEAD. Authorization precedes validators and Range, including 304 and HEAD. Only image HEAD is exempt
   from the API write-header guard, not arbitrary HEAD routes.

## Instrument and controls

- Measurement commits `432d2dc` and `a92074e` add scenarios; no existing workload or assertions are weakened.
  `image.paste.network`: real Chromium, deterministic opaque 3000×1500 xorshift PNG, prepare + upload + decode on
  an emulated 4 Mbit/s uplink / 40 ms link. It checks actual uploaded File bytes against server attachment readback.
  Fixture construction and loading the algorithm are outside timing, but **preparation is inside**. In revisions
  without the helper, the same original is uploaded, matching their actual unchanged paste behavior, not a skip.
  This tests upload only, not model submission; the 5 MiB per-model-image limit is unchanged.
- New `image.original.again` and `.validated` use the exact original images already retrieved by `image.concurrent`.
  Repeated full responses must match every byte. Conditional responses are either the same bytes (old version) or
  304, matching ETag and zero body. No inference is permitted.
- Measurement-only commit `238fa1f` scopes the shared `storedImage` decoder, called by both old `entryImage` and the
  new cache miss path. This prevents the new path from disappearing from decode accounting. The existing duplicate
  decode sensitivity control remains effective: after deliberate cache eviction, the unchanged response has two
  measured decodes, and its one-decode work assertion fails. Same three concurrent HTTP requests now need only two
  source decodes for two distinct images; their exact binary assertions are retained.

## Results and load

`timing-run.mjs p1b-ci -- npm run perf:ci -- 19f2ad5 --runs 3 --out /tmp/rt-p1b-ci` passes work checks and ledger guard.
Base is first-batch `19f2ad544d1f`, runtime head `0f411eb7716b`, both installed **rotom 0.1.25** (installer output in
`/tmp/p1b-ci.log` lines 14/24). Same-length temporary checkouts, alternating base/head, Node 24.18.0, darwin-arm64,
8-core Apple M1. Machine load 7.99→23.86: **highLoad: true**. Timing classifier output is not valid L2 evidence.

| Scenario / measured work                        |           Base |      Head | Level / decision                                                                 |
| ----------------------------------------------- | -------------: | --------: | -------------------------------------------------------------------------------- |
| Pasted PNG upload bytes, all three runs agree   |     15,482,499 | 6,772,807 | L1: 56.3% less upload; browser does resize/encoding first                        |
| Repeated four originals, SQL statements         |              4 |         0 | L1: no repeated source query                                                     |
| Repeated originals, parsed chars                |     10,516,266 |       114 | L1: large base64 entries no longer parsed; residual global metadata work remains |
| Conditional four originals, response body bytes |      7,868,332 |         0 | L1: validated 304; no body transferred                                           |
| Conditional originals, SQL / parsed chars       | 4 / 10,516,152 |     0 / 0 | L1: source work not repeated                                                     |
| Paste prepare/upload/decode median ms           |       31,397.9 |  13,890.4 | Loaded-machine observation only, **not L2**                                      |
| Conditional originals median ms                 |           57.0 |      19.0 | Loaded-machine observation only, **not L2**                                      |

A preceding isolated transport diagnostic (`/tmp/h2-diagnostic/run.ts`, timing lock `h2-diagnostic`) used synthetic
105,000-byte objects, not decoded images, with 22 parallel downloads and one/five held event streams. Three
alternating runs, load 1.66→2.00, `highLoad: false`: at 50 Mbit/s / 40 ms, five streams: 1460→425 ms; at 4 Mbit/s:
5710→4735 ms. HTTP/1.1 was plain, HTTP/2 used a self-signed test TLS identity. This motivates transport work; it is
not an application L2 claim. Actual application tests separately prove TLS negotiation (`h2` in Chromium), one
connection for five active views plus 22 API requests, gzip flush, auth and HTTP/1.1 fallback.

## Costs / counters that grew

- First original retrieval writes a private blob and manifest: `image.single` stringify chars 0→383 and concurrent
  originals 34→1430. The first call pays disk write/hash costs; concurrent server time is higher on this loaded run.
  Repeated requests avoid original SQL/base64 work but still read/hash the file. No universal first-read speed claim.
- Web open loads one new helper module (+1 HTTP request). A +24 DOM-node variation also appears; no UI-work reduction
  is claimed, and its precise cause is not attributed without another controlled snapshot comparison.
- Large paced views emit 40 instead of 36 views in worst runs (one more four-tab coalescer flush), with +29 SQL,
  +149 parses / 108,512 chars, +48 field serializations / 11,988 chars, +4 heads / +8 attempts / +8 command-input
  queries and +5028 pushed bytes. The workload's unchanged 90 ms coalescer is timing-sensitive. These are retained
  real intermediate-view costs, not canceled against image savings or removed from counting. Program 2 is where
  repeated projections/history work will be addressed; no fix is claimed here.
- Small global JSON character variations (+9/+28) and +34 stringify chars in repeat originals are not assigned to
  an optimization. All work checks pass, but exact attribution and quieter retiming remain owned follow-up work.
  No ceiling/baseline/tolerance is raised to accommodate them.

## Verified artifact

At runtime commit `0f411eb`, before the concurrent pin update:

- `npm run format`, `npm run check`, `npm run lint`, `npm test`: **510 pass, 0 fail, 0 skipped** (`/tmp/p1b-tests.log`).
- `npm run test:kernel:app`: `status: passed`, `realProvider: false`, synthetic loopback provider only
  (`/tmp/p1b-kernel.log`). No real account, external upload or deployment.
- Real Chromium tests both HTTP/1.1 and negotiated TLS HTTP/2: thumbnail/preview/original links, actual clipboard
  event/composer/upload, 2000×1000 output, smaller bytes, transparency, small/animated/failed/unsupported/inefficient
  conversions and canvas fallback; exactly one uploaded copy to the expected session.
- Original-file tests include restart/fork visibility, corruption/traversal and quota bypass. HTTP tests cover exact
  full/range bytes, validators, HEAD, 416 and denied/foreign conditional/HEAD requests. Duplicate decode sensitivity
  control is still asserted to fail its work check when injected.

## Current limits and owned next action

During the last benchmark, another task changed `runtime/rotom` and configuration documentation to **0.1.26**.
The head report's late revision label has `-dirty`, but both frozen measured checkouts installed 0.1.25, as the
saved installer log proves. Those concurrent edits are preserved and not staged as part of this work. These tests
and numbers **do not verify the combined 0.1.26 tree**.

Stop after these three experiments / the session time budget. The coding agent must, once the pin upgrade finishes,
revalidate that combined tree, repeat benchmarks on a quiet machine, collect an independent second report, register
new counters as candidates, run `perf:propose --write` and guard. No ledger edit/promotion is made from this single
loaded report. Then finish Program 1 acceptance and move to Program 2, before Program 3. Existing local approval
covers that continuation; deploying TLS still needs the owner's real certificate/address and deployment approval.

Other limitations: no real phone/tunnel/TLS deployment; only static PNG/JPEG clipboard inputs are resized; some noisy
2000 px PNGs still exceed the unchanged model 5 MiB limit. Original Range/304 currently read and hash the **whole
cached file** before slicing/sending; this removes Durable/base64 work and transferred bytes, not all file I/O or
hash CPU, and is not a zero-copy streaming-file implementation. Originals share the cache quota with previews.
The existing metadata reader does bounded files only; multipart ranges are intentionally not implemented.

Owned test servers/Chromium instances are closed. Reports/logs remain in `/tmp/rt-p1b-ci`, `/tmp/p1b-*` and the
transport diagnostic under `/tmp/h2-diagnostic`. No push, install into the live service, restart or deployment.

## Acceptance on the combined rotom 0.1.26 tree

Another task committed the native pin upgrade as `28d410e` (rotom 0.1.26). The combined tree `39edcda` was revalidated
with `npm run install:kernel` (0.1.26 identity verified), `format:check`, `check`, `lint`, `npm test` (**510 pass,
0 fail, 0 skipped**) and `npm run test:kernel:app` (`status: passed`, `realProvider: false`).

To isolate this batch from the pin upgrade, the base was a temporary local branch: first-batch end `19f2ad5` plus only
the cherry-picked pin commit (`ffe763a`). Both checkouts installed rotom 0.1.26. The first attempt started at load
16.86 (`highLoad: true`, discarded as timing evidence). After the machine settled, the repeat
`timing-run.mjs p1c-ci2 -- npm run perf:ci -- perf-tmp-pinbase --runs 3` ran at load 1.72→2.39, **highLoad: false**.
Work checks and the ledger guard passed.

| Scenario                                                   |             Base median |             Head median | Comparison     | Level                                               |
| ---------------------------------------------------------- | ----------------------: | ----------------------: | -------------- | --------------------------------------------------- |
| `image.paste.network` (prepare + 4 Mbit/s upload + decode) |             31,365.3 ms |             13,836.8 ms | `faster`, −56% | **L2** (with L1: 15,482,499→6,772,807 upload bytes) |
| `image.original.validated` (four conditional originals)    |                 55.4 ms |                 18.4 ms | `faster`, −67% | **L2** (with L1: SQL 4→0, body 7,868,332→0 bytes)   |
| `image.original.again` (four repeated full originals)      |                 64.8 ms |                 58.2 ms | noise          | L1 only (SQL 4→0; parsed chars ~10.5 M→114)         |
| `image.thumbs.network`, `.first`, `.again`                 | 968.4 / 245.9 / 12.0 ms | 954.4 / 263.2 / 11.0 ms | noise          | unchanged by this batch                             |

An independent five-run head report taken later (`timing-run.mjs p1c-repeat`, load 1.90→2.19, `highLoad: false`)
agrees: paste 13,800.8–13,889.8 ms, conditional originals 13.6–18.3 ms, repeated originals 48.8–72.7 ms.
These two reports registered the 98 new counters as **candidates** (none gating) and `perf:propose --write`
tightened three existing candidate baselines. Guard passed; nothing was raised, widened or promoted. No L3 claim:
nothing is deployed.

Counters that grew, besides the first-write cache costs already listed above:

- `turn.warm`: one of three head runs (538.6 ms) had a second coalesced view flush. That run did 158 instead of
  143 SQL statements, +50,226 parsed characters and +5,715 pushed bytes. The other two head runs equal base exactly.
  Across every saved report so far, 2 of 23 head runs and 0 of 15 base runs show this extra flush. The five-run
  repeat had none. `turn.warm` does not touch the changed image/listener/paste paths, and its timing classifier says
  noise; the cause is **unexplained**, not proven noise. It is not counted against or for this batch. Owner: the
  coding agent will watch `turn.warm/push.view.count` in Program 2's measurements, which work on that projection
  path.
- `commands.discover.warm/json.stringify.chars` +34 in every head run and `web.open/cdp.Nodes` +24 in two of three
  runs. Small, not attributed, not optimised away, and within candidate tolerance.

Program 1 is now complete locally, with the limits stated above: whole-file reads for Range/304, macOS-only
thumbnails, static PNG/JPEG paste resizing only, and TLS left opt-in and not deployed. The temporary base branch was
deleted after measurement. Next: Program 2, starting with a measurement commit.
