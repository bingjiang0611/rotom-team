# Reject targeted Goal ancestry readback under the current error contract

First experiment of the ninth climb batch. Hypothesis: a fresh indexed ancestry read might avoid decoding unrelated
messages in `TeamKernel.nativeGoal`, without a cross-call cache or schema change.

## Evidence and negative parity

Probe `/tmp/rt-goal-target-probe.mjs`, output `/tmp/rt-goal-target-probe.log`; Node 24.18.0 built-in SQLite against an
in-memory fixture with the same entry indexes. Current full-segment and latest-leaf lookup both scan `kernel_entries`:
there is no session_id index. An exact parent lookup can use the `(kernel_session_id,entry_id)` primary key. That alone
does not prove a smaller total path, especially when no Goal exists or a leaf must first be found.

A latest Goal fixture plus a malformed unrelated body gives a decisive difference: current `segmentEntries` decodes all
rows and throws SyntaxError, whereas a selected-ancestor/early-leaf reader returns the latest Goal. Testing only valid
native history would hide this error change. An extraction-only query has another parity failure: duplicate
`customType` keys use the last value in `JSON.parse` and the first in SQLite `json_extract`. SQLite JSON work would also
need a separate counter; transferring parsing into an uncounted engine is not a reduction claim.

## Decision

Do not implement targeted ancestry or SQLite JSON extraction under this contract. Full-message parsing and malformed
history errors remain unchanged. No source code, schema, protocol, state or ledger is changed by this probe. This is a
rejected experiment, not L1/L2/L3. Supporting different corruption semantics or metadata storage would need a separate
user decision and migration design; do not ask merely to force this optimization through.

Five fresh baseline runs `/tmp/rt-goal-target-base.json` at `5c3d2f7` plus existing user changes confirm the retained
fanout path: large open 860 calls / 163 SQL; paced 1,766 calls / 647 SQL, zero spread. Report load 1.91→4.43 on Apple M1
eight cores, timing lock `highLoad: false`.

Next checkable lead: `session.open` (a dormant 12-turn session) decodes 56 full-segment entries for Goal and another 56
plus two binding decodes for thinking. Both are synchronous room-wide reads over the same current segment. Share full
entries only inside the same fanout so the full decode/error contract remains intact; retain per-client safety reads.
