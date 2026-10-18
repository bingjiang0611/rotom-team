# Share fresh native Goal readback within one fanout

Second experiment of the eighth climb batch. The separate source-attribution commit identified native Goal history
readback as the dominant large-history parent parser.

## Change and safety boundary

`Room.pushAll` now lazily reads one native Goal snapshot and supplies it to every client projection in that one
synchronous fanout. Timer-driven updates and initial attach (the new tab plus already attached tabs) use `pushAll`.
The standalone `push(client, full)` API still performs its own fresh read for reconnect/tests and any call outside a
fanout. Nothing is retained after the method returns. An object wrapper distinguishes “not read” from a legitimate
undefined/cleared Goal.

Only `nativeGoal` is shared. Per-client roomState still runs for every viewer, including live member/catalog binding,
pending/latest/input fences, cutoff/resume, dialogs/status/widgets and `yours`. Existing sent-field comparison remains
per client. Live Goal state retains precedence; the durable fallback still selects the current segment and branch.
A read error still throws before any fanout client is sent a view, rather than becoming an empty Goal.

The native command proof uses Alice, Bob and a view-only member to assert one Goal read, three fresh roomState calls,
member-private command revisions, full/new-tab versus incremental/existing views, active→waiting→cleared updates,
next-fanout freshness, two independently fresh standalone/full reads, empty client set laziness and error propagation.

| Deliberate regression      | Result                      | Evidence                                   |
| -------------------------- | --------------------------- | ------------------------------------------ |
| Read Goal per client       | Fails `3 !== 1`             | `/tmp/rt-goal-fanout-no-reuse-control.log` |
| Retain Goal across fanouts | Fails next-fanout `1 !== 2` | `/tmp/rt-goal-fanout-stale-control.log`    |

## Five base/head runs

Base `/tmp/rt-parse-source-b.json`, head `/tmp/rt-goal-fanout-head.json`; macOS arm64 / Apple M1 eight cores /
Node 24.18.0 / rotom 0.1.25. Load base 2.86→3.61, head 2.76→4.14; both timing locks report `highLoad: false`.
All relevant work counters below have zero spread. Comparison `/tmp/rt-goal-fanout-compare.log` labels every duration
noise.

| Four-tab scenario | Total JSON calls | Segment-entry decodes |    Total SQL / rows | Kernel safety SQL |           View pushes / bytes |
| ----------------- | ---------------: | --------------------: | ------------------: | ----------------: | ----------------------------: |
| Open              |        2,057→860 |             1,848→660 |   199/2,127→163/912 |             56→56 |               14/112,462→same |
| Paced             |      5,387→1,766 |           4,792→1,198 | 755/5,377→647/1,702 |           176→176 | 36/183,616–190,016→same range |

Decoded characters fall 1,454,637→606,381 at open and 3,902,088→1,332,145 paced. Each four-client paced fanout
removes three redundant full-segment reads; one fresh read remains. The sequential-open scenario also sends existing
tabs incremental views as each new tab attaches, so it removes fewer reads per call. No work moved outside the measured
window. Stable source counters, the explicit proof and unchanged safety counters are the attribution evidence.

`perf:check`, propose and ledger guard pass. Only candidates tightened; no tolerance, gate or workload change. A few
unrelated candidate character counts tighten by single digits and are not credited. Full type/lint/format, **451 tests**,
synthetic kernel proof (82 loopback requests) and native command/browser proof pass. Browser proof made 28 synthetic
inferences and verified Goal active/waiting/paused/clear UI, plain wake and mobile containment. Full log artifact:
a private local session artifact.
The logged `GitError: spawn git ENOENT` is an intentional/handled test fixture; the full suite ends 451/451 and both
proof JSON records pass.

Keep as **L1 only**. Timings are noise; no L2/L3, real account, physical-device, production, push/deploy or service
restart claim. The user's unrelated working-tree changes remain outside this experiment.
