# Three programs — 2026-10-19

The owner approved local implementation in this order: Program 1, then 2, then 3. Deployment/restarting the live
service remains separate approval. Each program removes work instead of tuning it, and each is larger than the
previous climbs. The evidence is the journal snapshot `/tmp/rt-journal-20261019T125200Z` (see
[opportunities](opportunities.md)), code reading at `aaaba3e`, and a few local timings on a loaded machine (load
average 1.4–3.8: hints, not L2). Nothing here is measured as faster yet.

## Implementation status — first batch

| Program                      | Status                                                                                                                                 | Next owner/action                                                                                                          |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1. Bytes diet                | Partial: thumbnails/previews, bounded recoverable media cache, SSE/poll gzip, constrained-network measurement and browser verification | Coding agent: finish TLS/HTTP2, original-preserving paste resizing and original-file delivery evaluation in the next batch |
| 2. Incremental everything    | Not started                                                                                                                            | Coding agent: start after Program 1                                                                                        |
| 3. Main thread / native warm | Not started                                                                                                                            | Coding agent: start after Program 2; preserve the native trust and payer checks                                            |

[First-batch evidence and costs](experiments/2026-10-19-thumbnails-and-stream-compression.md). This checkpoint is not
completion of any whole program. No push, production restart, or deployment.

## What the deeper look found

| Finding                                                                                                                                                                                                                                                                                                            | Evidence                                                                                                                                        | Status            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Images are full-size originals, even as transcript thumbnails. 53 requests sent 99.1 MB; one 12 s burst sent 49.2 MB in 22 requests (about 4.1 MB/s overall). The event loop was 3–6% busy then.                                                                                                                   | journal `wireBytes`, process samples 07:04–07:09; `web/ui.js` `Thumb` loads `entryImageUrl` as-is                                               | measured / code   |
| So the image seconds are most likely transfer time, which a loopback benchmark cannot show (37 ms there).                                                                                                                                                                                                          | inference from the two rows above and the image baseline                                                                                        | unverified        |
| Every Durable read and write in the server runs on one global queue: `SessionImpl.#tail` in pi-durable, one `Harness` per app. Image lookups, history pages, and commits for every session wait behind each other.                                                                                                 | `pi-durable/dist/session/session.js` `#enqueue`, `readOnLine`; `src/server/app.ts` `Harness.open`                                               | code              |
| All SQLite is `DatabaseSync` on the main thread; there are no worker threads. Longest stalls: 979, 704, 685, 643 ms.                                                                                                                                                                                               | `pi-durable/dist/storage/sqlite/node.js`, `src/server/rotom-journal.ts`; journal process samples                                                | code / measured   |
| Each Changes request re-reads and projects the whole history (`allEntries`), including image entries carrying megabytes of base64, then runs Git. Every tab polls it every 4–8 s while the agent works. There is no server-side join or cache. 139 requests, 26.7 s in 24 h.                                       | `src/server/workspace.ts` `changes`, `transcripts.ts` `allEntries`, `web/diff.js` `useChanges`; `git.changes` parses 122,458 chars for 12 turns | code / measured   |
| A session switch closes the event stream and opens a new one: sign-in check, hello, the full session list, and the full view again (76 KB for 12 turns). The session list is resent whole to every tab, at most every 400 ms, on any change (458 KB per active minute).                                            | `web/store.js` `connect`, `src/server/app.ts` `#scheduleSessions`; ledger `session.open/push.view.bytes`                                        | code / measured   |
| A cold native start boots Node twice in a row: `rotom-child.sh` runs the validator `rotom-child.ts`, then execs Pi. The validator alone took 588–667 ms here, 186 ms of it importing `rotom-resources.ts` (which pulls in `rotom-kernel.ts`). Production cold dispatch is p50 3,651 ms; a reused process is 79 ms. | local timings; journal prompt phases; native initialize was 1.6 s in the 2026-10-17 benchmark                                                   | measured (loaded) |
| Pi's unbundled `dist/cli.js` takes about 485 ms for `--version`, the bundled one about 168 ms; Node's compile cache did not help. The launcher picks the entry point; it is product code.                                                                                                                          | local timings                                                                                                                                   | measured (loaded) |

## Program 1 — Bytes diet: stop shipping originals

Make the browser fetch about 1–2% of the image bytes it does now, and stop parsing JSON to serve an image.

1. **Media store.** The first time an image is requested, write its bytes to `data/media/<sha256>` with a small
   index from (conversation, entry, index) to the hash. Stored entries never change, so the index never needs
   invalidating. Later requests stream the file with `ETag`, `Range`, and the current immutable caching: no Durable
   queue, no 2.6 M-character JSON parse, no base64 decode. Permission checks (`visibleEntry` fork ancestry) stay on
   every request; only the bytes are served from the store. Pi Durable's stored data is not changed.
2. **Thumbnails and previews.** On macOS, `sips` makes a 480 px JPEG thumbnail and a 1,600 px preview into the same
   store, off the request path (no new npm dependency). The transcript shows the thumbnail; the full screen sheet
   shows the preview and offers the original. Pasted images are shrunk in the browser before upload, and the original
   is kept.
3. **One connection for many requests.** Serve HTTP/2 over TLS where the address is TLS (Tailscale certificate or a
   configured certificate) so 22 images do not queue behind the browser's six HTTP/1.1 connections and the event
   stream.
4. **Compress the event stream.** Gzip the event-stream response with a flush per event (views and session lists are
   repetitive JSON).

Expected effect, not measured: about 99 MB becomes about 2–4 MB for the same 47 images. On the same link, a thumbnail
should take tens of milliseconds instead of 1.3–5 s. First step: add a test that sends a thumbnail and the original
in one request burst through a throttled link, so L2 can see transfer time.

Risks: thumbnail quality and colour profiles; `sips` is macOS-only (fall back to the original elsewhere); disk use
(capped, oldest first, and rebuilt on demand); HTTP/2 changes the network setup for every device. Needs the owner to
decide: new `data/media` storage, TLS and HTTP/2, and resizing pasted images in the browser.

## Program 2 — Incremental everything: never re-read history to answer a question

Replace "rebuild from the whole history on each request" with indexes updated once per append, and replace polling
with pushes.

1. **Changes, event-driven.** Keep a per-conversation index of Pi's edits, updated as entries are appended (each entry
   is read once instead of once per poll per tab). Watch the worktree (`fs.watch` on the folder and `.git/index`,
   `HEAD`) and run Git once per change, shared by every tab through one in-flight request. Push a `changes` event
   instead of the 4–8 s browser poll, and keep a slow poll only as a fallback. Per-viewer filtering (`onlyHere`) is
   applied to the shared result.
2. **Session list as deltas.** Send one row when one session changes, not the full list to every tab every 400 ms.
   Sort and page on the server, with a version so a tab that missed a delta asks for the whole list.
3. **One stream, many sessions.** A tab keeps one event stream and subscribes to or unsubscribes from a session with a
   POST. No reconnect, sign-in, hello, or session list on switch.
4. **Instant switch from a local copy.** Keep recent views in IndexedDB with their version. On switch, paint the cached
   view at once, marked as checking, then apply what changed since its version (or the full view if too old).
5. **Paged transcript.** Send the last N entries on open and older ones on scroll. The 2026-10-18 notes already put
   this behind long-history browser evidence.

Expected effect, not measured: Changes server work goes from O(history × tabs × polls) to O(new entries + Git per real
change). Session-list bytes drop by the share of rows that did not change. A switch to a recent session paints
without a server round trip (today p50 482 ms, p95 1,562 ms). First step: add `changes.poll.large` (long history with
images, four tabs) and `switch.repeat` (Chromium, ten switches) scenarios, measurement-only.

Risks: this is a client protocol change (deltas, subscriptions, resume versions). Freshness bugs show stale data, so
every cached view needs an explicit version check and a visible "checking" state. `fs.watch` misses events on some
file systems, so keep the fallback poll. Permissions must stay per viewer on every push. Needs the owner to decide:
the protocol change, browser-side storage of transcript content (privacy on shared devices), and pagination.

## Program 3 — Free the main thread and keep native warm

Move waiting off the one thread and the one queue, and start Pi before people send.

1. **Storage in a worker.** Run Pi Durable (its SQLite and the mutation queue) and the heavy projections in a worker
   thread. The main thread only routes HTTP and pushes. Next, give reads that need no single committed snapshot (image
   bytes, history pages) a separate read-only SQLite connection, which WAL allows alongside the writer, so they no
   longer wait behind commits. This needs upstream support in pi-durable or a well-defined read API; the global queue
   is its consistency rule.
2. **Pre-warm the member's own native process.** Start the session's native process when its owner focuses the
   composer or opens the session, under that member's HOME, with the same pin, policy, and resource checks. Stop it
   after an idle timeout. A send then finds a ready process (today 3,651 ms cold vs 79 ms reused at p50).
   Authorization and the payer/model gate still run on every inference, so credential routing is unchanged.
3. **A light validator.** Make `rotom-child.ts` import only what validation needs (no `rotom-kernel.ts` graph), or
   bundle it once at install, with the same checks. Up to about 0.2–0.5 s of every cold start, measured on a loaded
   machine.
4. **Upstream product startup.** Ask the native product to load its bundled entry point (168 ms vs 485 ms for
   `--version` here) and to report its own startup phases. This is a request to the product, not an edit to the pinned
   copy.

Expected effect, not measured: cold sends that were pre-warmed lose about 3 s. Stalls caused by synchronous SQLite and
large JSON on the main thread stop delaying every tab; the cause of the 979 ms stall is still unknown and needs a
controlled profile. First step: a measurement commit that records Durable queue wait per request kind, plus a cold-start
split of validator, Pi load, and first state.

Risks: highest of the three. A worker changes how every Durable call is made, and errors, unknown outcomes, and
shutdown must cross the thread boundary exactly. Pre-warming costs memory (RSS already peaks at 777 MiB) and starts
processes no one may use. A pre-warmed process must never serve another member. Needs the owner to decide: pre-warming
policy and limits, a worker architecture, and asking pi-durable and the native product for changes. This is near the
trusted-native boundary, so it needs explicit approval before any code.

## Suggested order

Program 1 first: it targets the largest measured cost (53% of HTTP time), has no protocol change, and its risk is
contained in one route and new derived files. Program 2 next, starting with the Changes index and its server-side join,
which need no client protocol change. Program 3 last, starting with the light validator and the queue-wait measurement.
