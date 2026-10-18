# Join the fresh room-state head/session snapshot

Second experiment in the seventh climb batch. The baseline and query-plan hypothesis are recorded separately in
[the measurement](2026-10-18-head-session-query-plan.md), commit `e666b14`.

## Change

`RotomJournal.sessionIfPresent` reads the head, segment and optional current-model binding in one indexed LEFT JOIN.
`TeamKernel.roomState` uses it instead of presence → head → segment. No snapshot is retained across calls. The ordinary
throwing `session` API and direct historical `segment` reads are unchanged; both paths share the existing row decoder.

A missing head returns initializing. A head pointing at a missing segment still throws `Unknown kernel session`.
Invalid binding JSON still throws. Model overrides win over the immutable original segment binding exactly as before.
Pending/latest receipts, input fences, cutoff/resume, membership and exact catalog binding checks remain fresh.

## Safety controls

The new journal test covers absent head, one statement, full parity with `session`, current model/thinking override,
file/native-session identity, returned-object mutation, uncommitted/committed handoff, old-segment readability, new payer,
restart, malformed JSON and a dangling head. The native-command proof still checks viewer/other-member privacy and
same-member/segment-but-different-binding rejection against the fresh snapshot.

| Deliberate regression           | Result                              | Evidence                                       |
| ------------------------------- | ----------------------------------- | ---------------------------------------------- |
| Extra presence query            | Fails `2 !== 1`                     | `/tmp/rt-head-session-duplicate-control.log`   |
| Inner JOIN masks dangling head  | Fails expected corruption exception | `/tmp/rt-head-session-corruption-control.log`  |
| Restore old roomState read path | Fails expected fresh optional read  | `/tmp/rt-head-session-second-read-control.log` |

Restored fix passes all 21 journal tests and `node test/native-commands-proof.ts` (synthetic accounts, 19 inferences).

## Five base/head runs

macOS arm64, Apple M1 eight cores, Node 24.18.0, pinned rotom 0.1.25. Base `/tmp/rt-head-session-base.json` is
`b98ad15` plus pre-existing user changes; head `/tmp/rt-head-session-head.json` is `e666b14` plus this fix and the same
user changes. Load base 2.42→3.38, head 3.19→3.28; both timing locks report `highLoad: false`.
Comparison `/tmp/rt-head-session-compare.log` reports every duration as noise.

| Scenario       | Kernel SQL | Kernel rows returned | Binding decodes | Input fences |        Median duration |
| -------------- | ---------: | -------------------: | --------------: | -----------: | ---------------------: |
| Four-tab open  |      84→56 |                56→28 |           28→28 |        14→14 |   48.5→47.4 ms (noise) |
| Four-tab paced |    248→176 |              176→104 |         104→104 |        68→68 | 878.3→882.8 ms (noise) |

All these counters have zero spread. Each snapshot removes two statement/result crossings and one redundant head index
lookup; segment/model index lookups remain within the JOIN. Category counters classify the leading `FROM` table:
`sql.sessions` becoming zero does **not** mean segments are no longer read. No work moved outside the measurement window.

Total scenario SQL also falls 227→199 and 827→755. Full JSON decode calls, pushed view counts (14/36) and pushed view
bytes (112,462/190,016) are unchanged. There is no protocol or payload improvement claim.

`perf:check`, `perf:propose --write` and ledger guard pass. Only candidates were tightened; no tolerance, gate or
workload change. Final `npm run check`, `npm run lint`, `npm run format:check`, all **449 tests**, and
`npm run test:kernel:app` pass. The synthetic kernel proof reports 82 loopback requests, including restart, permission,
handoff, pending/unknown and clean-stop recovery. Its configuration-staging fixture exception is expected;
final status is passed. Real Chromium benchmark open and streamed-final-answer paths are available and pass.
Verification log: `/var/folders/gq/gr5v20ss57550_3x_vbk9tpw0000gn/T/pi-bash-f1bafe6f7db2c24e.log`.

Keep as **L1 only**. L2 remains noise; L3, real accounts, physical devices, long-history browser scaling and polling
fallback are not verified. No service restart, push, install into the deployment or deployment was performed.
