# Reuse complete native entries inside one room-info projection

Third experiment of the ninth climb batch. The targeted ancestry shortcut was rejected first; this change keeps the
full-decode/error contract and only removes duplicate reads of the same exact segment during one synchronous call.

## Change and safety boundary

`TeamKernel.roomInfo` projects the public agent line and native Goal together. It memoizes complete decoded entries by
exact segment ID only until that method returns. Goal is still read before agent info, preserving error/live precedence.
`nativeGoal`, `agentInfo`, executions thinking and journal thinking accept an optional injected full-entry reader; their
standalone defaults remain fresh and unchanged. `Room.push` and `pushAll` each lazily create one roomInfo result for that
standalone push/fanout. Every next call creates a new map and reselects the fresh head/binding.

This does not share viewer-specific roomState, commands, receipts, input fences, member ownership, quota or private
catalog data. Different segment IDs do not share, including empty segments. All entry bodies still parse; malformed
unused/abandoned entries still throw. Existing parent links, selected branch Goal and thinking reducers are unchanged.
Live Goal and retained-process thinking still take precedence and avoid unnecessary journal entry reads.

A dedicated test covers selected versus abandoned thinking, Goal active/clear, appended state, live precedence,
different and empty segments, returned state after restart, and malformed abandoned JSON. It counts one full read for
same-segment Goal+thinking and two for different segments. Removing the local entry map fails `2 !== 1`
(`/tmp/rt-room-info-no-entry-reuse-control.log`). Existing native-command controls detect per-field double reads,
next-fanout staleness, Goal active/waiting/clear, errors and three-role privacy; all pass.

## Five base/head runs

Base `/tmp/rt-goal-target-base.json`; head `/tmp/rt-room-info-head.json`. macOS arm64 / Apple M1 eight cores /
Node 24.18.0 / rotom 0.1.25. Load base 1.91→4.43, head 3.24→2.75; timing locks `highLoad: false`. Relevant counters
have zero spread. `/tmp/rt-room-info-compare.log` labels every duration noise.

| Scenario       |          Total JSON calls/chars | Thinking-scope calls/chars |          SQL / rows | Kernel safety SQL |             View pushes/bytes |
| -------------- | ------------------------------: | -------------------------: | ------------------: | ----------------: | ----------------------------: |
| Dormant open   |         165/617,961→109/377,164 |         58/241,880→2/1,082 |       61/177→59/121 |               8→8 |                 2/77,054→same |
| Four-tab open  |         860/606,357→842/596,607 |                        0→0 |     163/912→118/867 |             56→56 |               14/112,462→same |
| Four-tab paced | 1,766/1,332,101→1,712/1,302,865 |                        0→0 | 647/1,702→512/1,567 |           176→176 | 36/same 183,616–190,016 range |

Dormant open removes one duplicate 28-entry read per push: 56 rows/decodes and about 240.8k characters. Two binding
parses remain in thinking scope. Large histories already use live thinking, so their segment-entry decode count is
unchanged; the L1 there is one shared public agent read per fanout, removing 18/54 binding parses and 45/135 SQL/rows.
No work moved outside measurement. Push and per-viewer kernel safety counts remain unchanged.

`perf:check`, propose and ledger guard pass. Only candidates tightened; incidental CDP/count/character tightenings are
not credited. Full type/lint/format, **452 tests**, synthetic kernel proof (82 loopback requests), and native command /
Chromium proof (28 synthetic inferences) pass. Browser proof covers Goal and thinking UI, restart, handoff, branch,
waiting/wake/clear and phone layouts. Full log `/var/folders/gq/gr5v20ss57550_3x_vbk9tpw0000gn/T/pi-bash-5ed9db1b95a49e0c.log`.
The visible configuration-staging fixture exception is intentional; proof status is passed.

Keep as **L1 only**. All timings are noise; no L2/L3, real account, physical-device, production, push/deploy or service
restart claim. Existing unrelated working-tree changes remain outside the performance files.
