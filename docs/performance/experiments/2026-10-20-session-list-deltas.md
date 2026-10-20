# Program 2, step 3: send session-list changes, not the whole catalogue

## Owner approval and scope

The owner selected session-list deltas, recent browser-cached views cleared on sign-out, and paged history. This
step implements only the first. It does not change personal model accounts, native execution, the journal, or stored
Durable document schemas. No production service, real model account, push or deployment was used.

## Measurement first (`efba41f`)

`sessions.rename.tabs`: after all established scenarios, four SSE tabs without a selected conversation opt into
`sessions=delta` and receive their initial full lists outside the window. Rename the History session twice through
HTTP, waiting for each title in every tab. Every reconstructed list must exactly equal `app.sessions(owner)`.
Count both renames, their pushes, correctness readback and the final quiet period. Fixture-side parsing uses the
unwrapped parser, as other synthetic tabs do; it is not counted as server work. Older servers ignore the opt-in and
send full lists, so the same fixture measures both protocols without shortcuts.

One initial quiet run: 43,288 pushed bytes, 8 events, 44,386 stringified characters, 823.8 ms. Initial snapshots are
not free or claimed removed: they happen before the rename window on **both** sides, and `web.open` still measures
initial loading.

## Implementation (`06dc3ba`)

- `src/server/session-lists.ts`: a new opt-in connection receives `sessions {version, items}`; later updates send
  `sessions-delta {from, version, upsert, removed}`. Unchanged lists send nothing. Each version is scoped to the
  connection's UUID; reconnect starts with a fresh full list. Comparison baselines retain at most 2048 rows and 2 Mi
  JSON characters per connection; larger lists fall back to full snapshots without retaining their baseline.
- `app.ts`: filter the catalogue with the current member's permissions on every refresh. Within one refresh,
  compute/prepare it once per member, not per tab. The comparison still scans/serializes all visible rows once per
  member: it is not an incremental server-side index or catalogue pagination. Detaching forgets the baseline;
  permission refreshes force a filtered full snapshot. Finished-read markers remain member-specific.
- `http/events.ts`/`room.ts`: opt-in is per connection and works on both SSE and long polling. Tabs without the flag
  retain the full-array protocol unchanged. `GET /api/sessions` remains the legacy full list.
- `web/session-list.js`/`web/store.js`: apply deltas only when `from` matches the installed version. Sort by updated
  time, then id (matching server tie order). On a gap, stop applying deltas and ask `POST /api/sessions/sync` to send
  a full list on the **same ordered stream**, rather than race an out-of-band HTTP snapshot against more deltas.
  The endpoint targets only that member's own opted-in connection. An expired connection causes a reconnect/full
  snapshot. Old-server full arrays still work. No browser transcript persistence is introduced here.

Where the removed work went: unchanged row bodies no longer cross the wire or get serialized separately for every
tab; member-specific catalogue queries/preparation are shared within a refresh. There is a bounded in-memory
comparison baseline, a small version envelope, and one additional browser module request on cold open. The two
400 ms coalescing waits remain: byte savings do not imply a shorter rename-to-list delay.

## Results — L1, not L2

Immediate-base alternating comparison:

`timing-run.mjs p2-list-ci -- npm run perf:ci -- efba41f --runs 3 --out /tmp/rt-p2-list-ci`

Base `efba41f`, head `06dc3ba`, rotom 0.1.26 on both; load 2.47→2.87, **highLoad: false**, guard passed.

| `sessions.rename.tabs` | Base (3 runs)            | Head (3 runs)            | Result                                   |
| ---------------------- | ------------------------ | ------------------------ | ---------------------------------------- |
| pushed bytes           | 43,288 / 43,288 / 43,288 | 4,296 / 4,296 / 4,296    | −90.1%, L1                               |
| stringify characters   | 44,386 / 44,420 / 44,420 | 16,162 / 16,162 / 16,162 | −63.6% median, L1                        |
| SQL statements         | 49 / 49 / 49             | 43 / 43 / 43             | −6, L1 (same-member tabs share readback) |
| events                 | 8 / 8 / 8                | 8 / 8 / 8                | unchanged                                |
| median action time     | 822.9 ms                 | 820.4 ms                 | noise, no faster claim                   |

A separate `perf:ci -- origin/main --runs 3` against `5b5c40d`, head `14b455c`, also passed. Both used rotom 0.1.26;
load 2.74→6.47, `highLoad: false`. The same catalogue scenario again pushed exactly 43,288 versus 4,296 bytes in
every run. Reports: `/tmp/rt-p2-list-origin-fixed`. This is cumulative branch evidence, not attribution of earlier
image/Changes improvements to this step; their experiments describe those changes and first-use costs.

### Measurement compatibility correction (`14b455c`, separate commit)

The first attempt against origin/main failed before reaching the catalogue scenario: image decode calls were zero
rather than one. Its older route decodes in `entryImage`, while the newer probe scoped only `storedImage`.
`test/perf/images.ts` now scopes both when present, and counts only actual `Buffer.from(base64)` calls, not wrapper
calls. Nothing is added to an old implementation that has no `storedImage`. Two new tests exercise the old-only and
nested/shared paths and require exactly one lookup and one decode. Existing image probe tests (including duplicate
actual decode sensitivity) still pass. Workload/counter definitions and assertions were not weakened. The initial
failed run is retained in `/tmp/rt-p2-list-origin.log`, not reported as a successful baseline.

### Counters that grew in the immediate comparison

- `web.open/http.requests` 76→77: the new `session-list.js` module, necessary cold-open cost. In the same scenario
  pushed bytes fell 99,928→83,441 and event-parse characters 90,841→82,646; no cold-open timing gain is claimed.
- `web.open/cdp.Nodes` 971→995 is the pre-existing 971/995 bimodality, not a new list element in this change.
- `turn.warm` parse +7 chars / stringify +2, and `turn.paced` parse +10: the same small unattributed drift recorded
  in the previous experiments. Those synthetic tabs stay on the legacy protocol; this step does not change their
  turn path. Not counted as a gain or explained away as zero.
- `session.open` changed from the two-flush to the one-flush median again. Its counters falling are not a claimed
  optimisation; the second-flush issue remains open.

## Verification

- `npm run format:check`, `npm run check`, `npm run lint`: pass.
- Final `npm test`: **525/525 pass, zero skipped** on Node 24.18.0, macOS arm64, rotom 0.1.26.
- `npm run test:kernel:app`: `status: passed`, `realProvider: false`; not a real-account/UI acceptance claim.
- Six new session-list tests cover: one-row changes, removal, unchanged suppression, version mismatch/duplicates,
  deterministic tie order, old full arrays, oversized-list fallback, independent member scopes, permission
  revocation, detached/foreign-connection resync rejection, Chromium gap recovery **without reconnecting**, a fresh
  namespace on reconnect, long-poll replay with the same delta version, and full resync over polling.
- Deliberate regression control: removing the `from`-version check makes the browser-helper test fail. Restoring it
  passes. In Chromium one delta is deliberately dropped; a later delta triggers exactly one resync and a full list
  containing the missed row, on the same connection.

An earlier whole-suite run passed 522/523: the unchanged native file-watch burst test got two notifications rather
than one. It also failed once in isolation; a trace run and a separate unmodified-base worktree run passed. The final
whole suite passed without changing that implementation, the test, or its assertions. The cause is **not resolved**,
not declared fixed by a retry. Owner: the coding agent should investigate native event delivery/debounce timing
separately before changing this assertion. Logs: `/tmp/rt-p2-list-all.log`, `-watch-isolated.log`, `-watch-trace.log`,
`-watch-base.log` (all with the same `/tmp/rt-p2-list` prefix).

## Ledger and next work

50 new `sessions.rename.tabs` counters registered as candidates from two head reports taken at different times;
18 existing baselines tightened by `perf:propose --write`. Guard passed. No ceiling, tolerance or baseline raised;
no counter promoted to gating.

Browser-cached views with version checking and sign-out/permission invalidation, then paged history, remain next.
One stream per tab was not selected by the owner. No changes here claim offline correctness, server-side list
pagination, a deployment, or L3 benefit.
