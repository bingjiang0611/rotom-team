# Decode only unmirrored native history

## Hypothesis and destination of work

`TeamKernel.#mirrorNow` previously decoded every native journal body/binding before slicing at the durable
`NativeMirrorDoc.count`. Read that watermark first and have `RotomJournal.entries(session, skip)` return only the
remaining records. Offset is applied after the existing conversation/handoff filter and ordering. The first mirror
per conversation per process still inspects the full history for historical branch notices; later mirrors inspect
new entries only. Do not change the execution schema, receipt state, native file ingestion, payer routing, author
rules or original audit history.

Removed work: parent-process JSON decoding and returned SQL rows for entries already mirrored. SQLite still scans
an ordered prefix for OFFSET; this is not an indexed-cursor/O(1) claim. Future cursor work must measure that scan.
First open/restart deliberately retains full history inspection. Mirror append and count advance remain one Durable
commit. A backwards-moving mirror watermark fails rather than silently omitting history.

## Controlled observations

Five fresh runs before and after under the timing lock, macOS arm64 / Apple M1 eight cores / Node 24.18.0; same
existing dirty tree and unchanged workloads. Base is `/tmp/rt-phase1-git-head.json`, head is
`/tmp/rt-phase1-mirror-head.json`. Timing lock reported `highLoad: false` for both (load 4.46→3.16 and 5.34→2.97).

| Work counter            |        Typical base | Head (all five runs or max characters) |
| ----------------------- | ------------------: | -------------------------------------: |
| Warm SQL statements     |                 148 |                                    148 |
| Warm SQL rows returned  |                 120 |                                     91 |
| Warm JSON parses        |                 203 |                                    145 |
| Warm parsed characters  |     559,248–559,258 |                        342,897–342,905 |
| Paced SQL statements    |                 318 |                                    318 |
| Paced SQL rows returned |                 348 |                                    311 |
| Paced JSON parses       |                 353 |                                    279 |
| Paced parsed characters | 1,070,155–1,070,170 |                        822,679–822,690 |

The base warm fourth run also had extra asynchronous work (169 statements/216 parses/609,805 characters and two
view pushes). Do not count its disappearance as a mirror optimisation: use the ordinary 148/203/559k comparison.
Warm parse characters decrease about 39%; paced characters decrease about 23%. Cold parse characters also decrease
(874,083 worst→729,074). Native subprocess counts, warm/paced push bytes and statements do not increase.

Comparison output `/tmp/rt-phase1-mirror-compare.txt`: every timing is `noise` (warm medians 84.7→81.2 ms; paced
885.9→881.1 ms). Keep for L1 only; no L2 or L3 improvement claimed.

One unrelated Git stringify maximum is 35 characters above the previous report. Its body is one character longer
(variable mtime formatting), plus the unchanged Room 3-second branch timer serializes `{branch:"main"}` twice
(34 characters, `room.ts` HEAD_MS/#readHead). The same 34-character contribution appears in diff windows with no
JSON body. It is not suppressed, tolerated away, or traded for the mirror gain. The Git response content assertions,
process counts and SQL/parse counters remain unchanged. Existing candidate warnings remain visible.

## Tests and controls

- Journal suffix test: order/body/binding equality, incremental append, exact end/beyond-end empty results, restart
  with unknown receipt unchanged, invalid offsets rejected. `node --test test/rotom-journal.test.ts`: 19 passed.
- `npm run test:kernel:app`: passed with synthetic loopback model (82 requests, no real provider). Added repeated
  mirror assertions: no duplicate/replaced entries, unchanged authors after payer handoffs, no model dispatch.
  The printed configuration-staging error is the intentional fixture, followed by `status: passed`.
- `node test/native-commands-proof.ts`: passed, 19 synthetic inferences. Added branch-flag/repeated mirror/restart
  assertions. This is not browser or physical-device validation.
- Negative control: replace the first-read decision with unconditional `skip = mirrored`; the same proof fails
  exactly at the restored branch-notice assertion. `/tmp/rt-phase1-mirror-negative-control.log`. Restore source and
  rerun: passed (`/tmp/rt-phase1-mirror-positive-control.log`). No native operation is replayed by the optimisation.
- Restored final code: `npm run check && npm run lint && npm test`: 439 passed, zero failures/skips.
- Current ratchet passed; `perf:propose --write` tightened only lower existing candidates; guard passed. No promotion,
  raise or tolerance change. The old five-process Git baseline now correctly fails the tightened gate with exit 1
  (`/tmp/rt-phase1-old-git-control.log`).

Decision: retain L1 reduction. No production service, account, journal collection or external effects were changed.
Next measurement-only work: explicit cold/warm command discovery and a prompt on that prepared native segment.
