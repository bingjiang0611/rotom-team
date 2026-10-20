# Program 3, step 1: warm a member's own native process before they send

## Owner choice and scope

The owner accepted Program 2 and approved the two Program 3 items that needed explicit approval: the Durable worker and
pre-warming the native process. This step is the pre-warm. The Durable worker is not started. Credential routing, the
payer/model gate, unknown outcomes, Durable stored data and the journal format are unchanged. No production service,
real model account, push of this branch or deployment was used.

## Measurement first (`790495c`)

Two scenarios, appended after all others so earlier inputs stay unchanged:

- `native.warm`: a new native session with one tab watching; its member posts `/api/c/:id/warm`, as focusing the
  message box does, until the answer. A server without warming refuses the route for a native session (409, no Durable
  fallback), which is no work. A warm start shows as one `subprocess.rotom`.
- `turn.prewarmed`: the first prompt of that session, until settled and quiet. On a server without warming this is a
  cold first prompt, the same work as `turn.cold`.

## Implementation (`3924e86`)

- **Server** (`src/server/rotom-executions.ts`): the launch of a native process (its spending gate, gate file, frozen
  context file, `startRotomKernel`, `get_state` and the HOME check) moved unchanged into `#launch`, which the send path
  and the new `warm()` both use. `warm()` starts a process only for an idle session on the pinned kernel, after the same
  `admission` authorization a send makes, and enters it in the retained processes. Its gate has nothing active, so it
  admits no inference until a send is admitted; every inference is still authorized there. Limits: one unused warm
  process per member (warming another session retires the first), three in all, and an unused one retires after five
  minutes. A send for a session whose warm start is on its way waits for that start instead of starting a second one;
  shutdown waits for warm starts, then retires everything.
- **Who may warm** (`src/server/team-kernel.ts`, `POST /api/c/:id/warm` in `src/server/http/conversation-routes.ts`):
  the member whose account the session runs on now, if they can see, steer and drive it (take turns), after the native
  setup is ready, while it is idle. Anyone else gets `{ warmed: false }` or the usual 403. It is not in the native
  `shared` read-only list, so a viewer link cannot use it.
- **Revocation**: changing a member's account (`accountIdle`) retires their unused warm process before the change;
  `revoke()` (role or session access changed, projects changed) retires any unused warm process whose member fails the
  send checks.
- **Web** (`web/store.js` `warmSession`, `web/composer.js`): focusing the message box asks, at most once per session
  every four minutes, only for one's own idle native session with steering allowed. Nothing waits for the answer or
  shows it.

A first version awaited the warm-start map on every send, even when empty. That extra microtask moved an existing push
race: `turn.cold` showed +5 SQL statements and 2 more journal parses in all three runs. It now waits only when a warm
start is on its way, and `turn.cold` is back to 195 statements (`/tmp/rt-p3-warm-head2.json`).

## Results

`npm run perf:ci -- 790495c --runs 3 --out /tmp/rt-p3-warm-ci3` from the clean worktree, `highLoad: false`, load 3.3 →
4.4 on 8 cores, rotom 0.1.26:

| Scenario         | Base (`790495c`)        | Head (`3924e86`)         | Verdict                    |
| ---------------- | ----------------------- | ------------------------ | -------------------------- |
| `turn.prewarmed` | 2,063 ms, 1 rotom start | 123.1 ms, 0 rotom starts | **faster −94% (L2)**       |
| `native.warm`    | 4.7 ms (refused)        | 2,095 ms, 1 rotom start  | moved work, before sending |
| `turn.cold`      | 1,700.9 ms              | 1,729.5 ms               | noise                      |
| `turn.warm`      | 78 ms                   | 78.2 ms                  | noise                      |

The work moved, not removed: the native start (about 2 s here, 3.65 s p50 in production) runs when the member focuses
the message box instead of when they send. A send soon after focus waits only for what is left of that start. Moved
counters: `native.warm` got 13 SQL statements, 248,201 file bytes, 215,010 parsed characters and one rotom process;
`turn.prewarmed` lost them (fs bytes 391,869 → 242,540, one process fewer).

Memory: one warm process is about 327 MiB RSS (`pi`, a one-off `ps` reading after a warm start in the test
environment). With three warm processes allowed in all, an idle server can hold about 1 GiB more than before until they
are used or retire after five minutes.

Counters that moved elsewhere: the worst run of `session.reclaim` showed a second view push (2 of 3 head runs; 0 of 3
base runs), and one `turn.cold` head run showed the +5 statements again. Both are candidates, not gating, and both
scenarios already registered this spread when their tolerances were set (`session.reclaim/sql.statements` 14 with
tolerance 5, `push.view.count` 1 with tolerance 1; `turn.cold/sql.statements` 193 with tolerance 15). Base runs of
`session.open` showed the same bimodal second flush. The cause of this push race is not found; it is on the watch list.

## Verification

- `node --test test/native-warm.test.ts` (7 tests, real rotom kernel, loopback model): a warm start makes no model
  request and the first send reuses its process; a send during a warm start reuses it (one gate); warming a member's
  second session retires the first; another member cannot warm; account change and losing driving rights retire it; a
  retired one starts again on send.
- `node --test test/native-warm-ui.test.ts` (Chromium): focusing the message box warms once; focusing again soon asks
  nothing.
- Negative controls: without the wait in the send path the race test fails; without retirement in `accountIdle` or
  `revoke()` those tests fail; without the `onFocus` call the Chromium test fails.
- `npm test` 541/541, `npm run check`, `npm run lint`, `npm run format:check`, `npm run test:kernel:app` passed in the
  clean worktree at the implementation commit.
- Ledger: 2 scenarios registered from `/tmp/rt-p3-warm-ci3/head.json` and `/tmp/rt-p3-warm-head2.json`; `perf:propose`
  lowered 11 baselines; `ratchet guard` passed against `/tmp/rt-p3-ledger-before.json`.

## Not verified / limits

- Real people: whether members focus the box long enough before sending is unmeasured. The daily journal's
  `process: "reused"` share of first sends would show it after deployment.
- Untested: the five-minute retirement timer (the tests call the function it calls) and the cap of three in all (the
  tests use one member at a time).
- Safari, Firefox and touch devices: focus on touch opens the keyboard; untested.
- The `image.single` measurement once failed its own check ("unfinished/aborted image phases are unavailable, not
  zero") on the base side; unrelated to this change, not investigated.
