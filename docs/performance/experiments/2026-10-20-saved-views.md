# Program 2, step 4: saved session copies and reconnect claims

## Owner choice and scope

The owner chose a browser copy of about the 10 most recent sessions: show it marked as checking, fill in by version,
and clear it on sign-out or a permission change. This step implements that. It does not page history (next step),
change the journal, Durable stored data, credentials, native execution, or permission checks. No production service,
real model account, push or deployment was used.

## Measurement first (`19f575f`)

Two scenarios, appended after all others so earlier inputs stay unchanged:

- `session.reclaim`: an unmeasured SSE tab loads the 12-turn session's full view. A new tab then connects claiming
  every entry it held. The rebuilt transcript must equal the held one, entry for entry. Old servers ignore the claim.
- `web.reopen`: headless Chromium opens the session in one tab until shown (and, where the page keeps copies, until it
  saved one), closes it, then opens it in a fresh tab of the same profile. `ms` runs until the last answer is on screen
  **without** a saved-copy marker, i.e. the server's own view. `firstShownMs` is when the answer first appears, from any
  source. On a page with no copies, both are the same.

The benchmark carries its own copy of the claim digest (`test/perf/view-claim.ts`), because older checkouts lack
both product copies. A test keeps the three copies equal.

## Implementation (`d595dfb`, test import fix `bbe43e2`)

- **Claim protocol** (`src/server/view-claim.ts`, `web/view-claim.js`):
    - A connecting tab may send `have=<server run>.<first id>.<count>.<digest>`. It names the newest run of its order,
      at most 400 entries, whose entries it holds.
    - The digest is two FNV-1a 32-bit passes over the ids. It is not a secret and not an authorization: a claim can only
      make the server send that tab _less_.
    - The server run is its start time, so a restart, and with it any projection change, invalidates every claim.
    - Each connection's first full view checks the claim against its exact order. On a match, those ids count as already
      sent and the view says `kept: {first, count}`. Anything else (another run, gap, other ids, malformed, over 64
      characters) is ignored: the whole view comes as before.
    - The claim is used once; later full views send everything.
    - Permission and visibility checks are unchanged: a tab that may not see the session gets `missing`, not a view.
- **Browser** (`web/store.js`):
    - A full view with `kept` starts from exactly that run of what the tab held, then adds the sent entries.
    - If any id in the order is still missing (for example an EventSource auto-retry reusing an old claim URL), the tab
      reconnects once claiming nothing.
    - Ordinary reconnects claim from the tab's in-memory view.
- **Saved copies** (`web/view-cache.js`, IndexedDB `rotom-views`):
    - After a confirmed view stays unchanged for 1 s, the tab saves its newest 400 entries, title/conversation info and
      authors, when idle. Copies over 4 M JSON characters are dropped instead. Only the 10 newest sessions are kept.
    - Each copy records the person and their access (`[id, role, session grants]`). A copy for anyone else, or for other
      access, clears every copy.
    - Copies are removed on sign-out: Settings stops saving and clears before the logout request, and any `me: null`
      (a 401) clears too. A change of access clears them, `missing` drops that session's copy, and a full session list
      drops copies of sessions no longer listed.
    - Opening a session reads its copy (in parallel with `/api/me` on page load; at most 150 ms on a switch) and shows it
      marked `saved copy · checking for changes…`, then connects claiming it.
    - Live state, approvals, inbox and kernel/payer state are **not** saved. While checking, the message box is replaced
      by that marker, so nothing can be sent from a copy.
    - The previous session's stream closes before the copy is read, so its events cannot land on the new session.
    - Where IndexedDB is missing or fails, nothing is saved and the old path runs.
- **Journal meaning kept** (`web/perf.js`): `open.session` and `switch` still end at the confirmed view, not the copy.
  Reporting copy-shown time would mean changing journal collection, which needs the owner's approval. Not done.

Where the removed work went: unchanged transcript entries are no longer projected to JSON, sent or parsed for a tab
that holds them. The server still builds the projected sequence once per room. It checks claims in O(order) per full
view: one `indexOf`, a slice and a digest. The browser does new work: an IndexedDB read when opening a session, a
debounced write after changes (structured clone plus one JSON length check), a Map copy of the kept run, and two more
module requests on a cold load.

## Results — L1 bytes, no L2 time claim

`timing-run.mjs p2-cache-ci-clean -- npm run perf:ci -- 19f575f --runs 3`. It ran from a **clean worktree of
`bbe43e2`**. An earlier run from the main checkout was discarded: its head included another task's uncommitted kernel
files, which `perf:ci` copies into the head side. Load was 5.04→7.29 on 8 cores, `highLoad: false`. Rotom 0.1.26 on
both sides. Guard passed.

| Counter                                     | Base (3 runs)             | Head (3 runs) | Result                         |
| ------------------------------------------- | ------------------------- | ------------- | ------------------------------ |
| `session.reclaim` push bytes                | 95,597 / 95,597 / 93,470  | 9,808 ×3      | −89.7% median, L1              |
| `session.reclaim` stringify characters      | 97,207 / 97,173 / 101,497 | 12,025 ×3     | −87.6%, L1                     |
| `web.reopen` push bytes                     | 90,581 ×3                 | 10,297 ×3     | −88.6%, L1                     |
| `web.reopen` browser event-parse characters | 89,795 ×3                 | 9,511 ×3      | −89.4%, L1                     |
| `web.reopen` confirmed `ms` (median)        | 136.1                     | 141.9         | not faster; noise at this load |
| `web.reopen` `firstShownMs` (median)        | 136.1                     | 121.6         | earlier copy; not L2           |
| `session.reclaim` `ms` (median)             | 16.1                      | 12.1          | not claimed (L1 only)          |

On loopback, 80 KB less does not shorten the confirmed open. The copy appears about 15 ms sooner because it still
waits for `/api/me`. Slow links (mobile, tunnels) should gain more, but no network-emulated reopen scenario exists:
**unverified**.

### Counters that grew

- `web.open/http.requests` 77→79: `view-cache.js` and `view-claim.js`, the necessary cold-load modules (traced URL
  log).
- `web.reopen/http.requests` 77→78: the same two modules, minus one `POST /api/c/<id>/seen`. The traced head run shows
  the earlier tab already sent it; that tab lives longer on head because the fixture waits for its save. This is a
  fixture-timing effect, **not** a saving of the change.
- `web.reopen/web.view.base.entry.copies` 0→26: the kept run is copied into the new entry Map. Necessary, small.
- `web.reopen/cdp.Nodes` 1068/1092 → 1090 and `web.open/cdp.Nodes` 971/995 → 972/996: both bimodal already. The +1
  in `web.open` is **not explained**; registered as candidates.
- Noise outside the changed path: `cdp.RecalcStyleCount`, `turn.prepared` push/stringify (one run with an extra flush),
  ±34 stringify characters in `commands.discover.warm` and image scenarios (bimodal in base too), and
  `session.open` durable parse ±2 characters.

## Verification

- `npm run format:check`, `npm run check`, `npm run lint`: pass, in the clean worktree. The main checkout's `check`
  fails only on the other task's in-progress `test/team-kernel-proof.ts`.
- `npm test` in the clean worktree: **530/530 pass, 0 skipped** (Node 24.18.0, macOS arm64, rotom 0.1.26).
- `npm run test:kernel:app`: `status: passed`, `realProvider: false`.
- `test/view-claim.test.ts` (4 tests):
    - the three digest copies agree
    - strict parsing and exact-run matching (another run, other ids, missing first id, past end, count, malformed)
    - the browser claims its newest held run, bounded, and keeps only the named run
    - a room sends only the missing entries once, deltas afterwards as before, everything on a later full view, and
      everything for every bad claim
- `test/view-cache-ui.test.ts`, real Chromium:
    - The copy shows marked, with no message box, before the held server view is applied.
    - The URL carries the claim. The server keeps 3 and sends 0 entries.
    - The confirmed transcript is exact.
    - A new entry while away gives `kept 3`, `entries 1`.
    - A deliberately incomplete kept run reconnects with no claim and gets the full view.
    - Another person's copy is refused and clears all copies.
    - `me: null` clears copies, and Settings' `forgetSavedViews` clears them.
- Negative controls, each reverted afterwards:
    - With the server claim disabled, the browser test fails at "the server kept the whole claimed run".
    - With clearing on sign-out disabled, it times out at "cleared on sign-out".

## Not verified / limits

- Shared-device risk: copies are readable by anyone using the same browser profile until sign-out. A tab closed without
  signing out keeps up to 10 sessions' recent transcript at rest. This is the chosen trade-off; sign-out and access
  changes clear them.
- A permission removed while the person is away is detected only when the server answers (`missing`) or sends a new
  list. Until then their own copy may show for one check, never actionable.
- Only one tab's and one profile's behaviour is tested. Safari, Firefox and private modes are not; they should fall
  back to no copy, but that is unverified.
- No slow-network reopen measurement; no L2.

## Ledger and next work

Candidates for `session.reclaim` and `web.reopen` are registered from two clean head reports taken at different times,
and baselines tightened with `perf:propose`. No ceilings or baselines were raised, and nothing was promoted to gating.
Next: paged history, the last owner-chosen item in Program 2.
