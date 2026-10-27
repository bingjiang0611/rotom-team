# Performance opportunities: approved programs (historical)

Archived from `opportunities.md` to keep edited files within 20,000 bytes. Bodies below are unchanged.

## Program 3, step 2 — 2026-10-21

The team validator each **subagent** start runs (`rotom-child.ts`, its own Node process) now loads only the resource
policy and the pin check, not the native process client and eleven native modules: 964.3 → 669.4 ms (−31%, **L2**,
`highLoad: false`). Same checks. Correction to the proposal: the member's main native process never ran this validator,
so `turn.cold` is unchanged (it parses 4,540 characters fewer). Node's own start, about 0.36 s, remains.
[Experiment](experiments/2026-10-21-light-validator.md).

## Program 3, step 1 — 2026-10-21

Focusing the message box of one's own idle native session starts its native process before the send, with a gate that
admits nothing until the send is admitted. The first prompt after a warm start: 2,063 → 123.1 ms (−94%, **L2**,
`highLoad: false`). The start moved, not vanished: `native.warm` takes 2,095 ms and one rotom process when the box is
focused. One warm process is about 327 MiB RSS; at most one unused per member, three in all, retired after five
minutes, on account change or loss of driving rights. Open: a timing-dependent second view push in `session.reclaim`
(seen in 2 of 3 head runs, within its registered tolerance), cause unknown. 541 tests pass in a clean worktree.
[Experiment](experiments/2026-10-21-native-warm.md).

## Program 2, step 5 — 2026-10-20

A session's view now sends its newest 240 entries and the whole order; the browser reads earlier entries 200 at a time
as the reader scrolls up, and in full for find, Outputs and jumps. On a 600-entry native history, open push bytes
422,380 → 179,320 (−58%); the server open got faster, 24.7 → 17.3 ms (**L2**, `highLoad: false`). The browser's time to
the newest answer on loopback did not change (134 → 135 ms, **L1**). The moved work is visible in
`session.history.earlier`: 2 requests, 243,098 bytes to read everything. The server still projects the whole history
once per room. 533 tests pass in a clean worktree. Measurement fix on the way: `perf:ci` silently skipped comparing once
the ledger passed 1 MiB (`a0c54ee`). [Experiment](experiments/2026-10-20-paged-history.md).

## Program 2, step 4 — 2026-10-20

The browser keeps a per-person copy of the 10 most recent sessions and shows it marked "checking" until the server
confirms it. Every connecting tab claims the entries it holds, so the server sends only the rest. Reopen and reconnect
push bytes: 90,581 → 10,297 and 95,597 → 9,808 (−89%). **L1 only**: the confirmed open on loopback did not get faster
(136 → 142 ms, load 5–7); the copy shows about 15 ms sooner. Copies clear on sign-out, a change of person or access,
`missing`, or a session leaving the list. 530 tests pass in a clean worktree. Slow-link benefit is unmeasured. Next:
paged history. [Experiment](experiments/2026-10-20-saved-views.md).

## Program 2, step 3 — 2026-10-20

Session-list refreshes now send versioned changed/removed rows to opted-in tabs, with a full snapshot on first
connect, reconnect, permission refresh or a missed version. Four same-member tabs, two single-session renames:
pushed bytes 43,288 → 4,296 (−90.1%), stringify characters 44,420 → 16,162, SQL statements 49 → 43. **L1 only**;
rename latency is unchanged (~823 ms). Immediate-base and origin/main three-run comparisons passed with
`highLoad: false`. 525 final tests pass; an earlier unchanged native-watch burst test failed and its cause remains
open. Next: browser view cache, then paged history, as the owner chose.
[Experiment and compatibility-probe correction](experiments/2026-10-20-session-list-deltas.md).

## Program 2, step 2 — 2026-10-20

Open Changes tabs are told when the repository moves (macOS/Windows watch) instead of re-reading after every entry.
Chromium: a person's new file shows in ~0.5 s (was not within 8 s); six non-edit entries cause 0 reads (was 1, and
one per 4-8 s while Pi works). Cost: one small event per attach, one read per 30 s per visible open panel. L1, not
measured on a model turn. Next, as the owner chose: session-list deltas, browser view cache, paged history.
[Experiment](experiments/2026-10-20-changes-watch.md).

## Program 2, step 1 — 2026-10-20

Changes no longer folds a session's whole history per listing: each session's Pi-edit log is kept and caught up
from the last entry id, and concurrent listings share a Git run that started after they arrived. On
`changes.poll.images` (four tabs, two rounds, 24 image entries) parsed characters fall 504.8 M → 63.1 M, Git
processes 24 → 12, and time 633.6 → 388.2 ms (`faster`, `highLoad: false`): **L2**. Remaining leads here: the first
fold after a restart (Durable parses whole image records), and the client-protocol items, which wait for the
owner. [Experiment](experiments/2026-10-20-changes-edit-index.md).

## Program 1 accepted — 2026-10-20

On the combined rotom 0.1.26 tree, against a base of the first batch plus only the pin commit, a quiet alternating
three-run comparison (`highLoad: false`) gives **L2**: pasted-screenshot prepare+upload 31,365→13,837 ms (−56%) and
conditional originals 55.4→18.4 ms (−67%); repeated full originals are L1 only. 510 tests and the synthetic kernel
proof pass. 98 new counters registered as candidates from two reports. One unexplained `turn.warm` extra-flush
run (2 of 23 head runs, 0 of 15 base) stays open for Program 2. Details: [experiment](experiments/2026-10-20-bytes-remainder.md#acceptance-on-the-combined-rotom-0126-tree).

## Approved programs: second implementation batch — 2026-10-20

Program 1's selected local features are implemented; performance acceptance remains pending. Added opt-in TLS/HTTP2
(default HTTP listener unchanged), approved HTTP/2 journal coverage with unavailable wire bytes, single-copy browser
paste resizing, and byte-identical original caching with ETag/Range/HEAD. Both real Chromium protocol paths and
**510 tests** pass at runtime commit `0f411eb` / rotom 0.1.25; the synthetic kernel proof passes too.

Alternating three-run comparison vs `19f2ad5`: upload 15,482,499→6,772,807 bytes, repeat-original SQL 4→0, conditional
original response bodies 7,868,332→0 bytes. These are **L1**, not L2: `highLoad: true`, 8-core load 7.99→23.86. New
counters remain unregistered pending an independent report; no threshold or journal retention is loosened. Timing
observations on this loaded machine are not a speed claim. First calls add cache writes; Range still reads/hashes the
whole cached file. See [second-batch experiment](experiments/2026-10-20-bytes-remainder.md) for costs and open items.

Another task updated the native pin to 0.1.26 during the benchmark. Preserve those changes; this batch does not verify
the combined new-pin tree. Coding-agent next action: after that upgrade completes, revalidate and quietly remeasure,
register candidates from two reports, propose tightening and guard, then enter Program 2. Programs 2/3 remain not
started. No push, live restart, real account or deployment.

## Approved programs: first implementation batch — 2026-10-19

Program 1 is **partial**; Programs 2 and 3 have not started. Four transcript thumbnails send 7,868,332→422,503
bytes (94.6% less). Final alternating three-run comparison on a quiet-enough machine (`highLoad: false`) gives
repeated loopback retrieval 53.1→9.3 ms, and previously unrequested thumbnails through Chromium's emulated
4 Mbit/s / 40 ms link 15,808.2→989.1 ms, including generation (`faster` in both comparisons). First loopback
retrieval instead slows 46.9→233.3 ms: eight probe/resize subprocesses and private cache-record writes are new work.
This is L1 plus scenario-scoped L2, not L3 or universal first-image improvement.

Derived files are bounded and verified on read; originals and permission/fork checks remain authoritative. SSE/large
poll answers use gzip with q-aware negotiation, immediate event flush and bounded stream backlog. Full checks,
503 tests, 82-request synthetic kernel proof and real Chromium thumbnail/preview/original selection pass. The final
ratchet and ledger guard pass; new counters are candidates only. See
[experiment, costs, limits and exact next actions](experiments/2026-10-19-thumbnails-and-stream-compression.md).

Stop this batch after three experiments. Next coding-agent action, under the existing approval: finish Program 1's
remaining TLS/HTTP2, original-preserving paste and original-file delivery work before starting Program 2. No service,
account, native product, journal collection or deployment was changed.
