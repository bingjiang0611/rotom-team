# Attribute unclassified parent parsing to pinned identity, resolver and settings

Twelfth batch, experiment two; measurement only, no removed work.

The constant turn `other` count (24 calls / 103,190 chars) is partitioned with three new exclusive subscriber-only
scopes: Team pin/package/lock parsing, the pinned `resolveInstalledPi` call, and local resource settings JSON. The
remaining `other` is unchanged; the aggregate JSON count includes all new scopes exactly once. No parser, filesystem,
identity check or credential route is changed. No raw content, IDs, paths, stacks or credentials enter the counters.

An initial one-run synthetic probe classified call sites locally; `/tmp/rt-other-probe.log` contains source-relative
code locations and counts/chars only. It is not a timing baseline. The temporary stack classifier was removed before
the two final reports; production has no stack collection or source-attribution state without a subscriber.

Final reports `/tmp/rt-identity-sources-a.json` and `/tmp/rt-identity-sources-b.json`, five fresh runs each, commit
`281ebbf` plus measurement and unchanged user edits. Node 24.18.0, macOS arm64, Apple M1 eight cores, rotom 0.1.25.
Timing locks highLoad false, A 1.59→3.36 and B 3.36→2.12. Both reports measure the same code, not before/after.

| Scenario                                   | Pin calls/chars | Resolver calls/chars | Settings calls/chars | Remaining other calls/chars |
| ------------------------------------------ | --------------: | -------------------: | -------------------: | --------------------------: |
| Cold turn                                  |     18 / 38,004 |         39 / 252,024 |           6 / 10,304 |                      2 / 92 |
| Warm / paced / prepared / large-paced turn |      9 / 19,002 |          13 / 84,008 |               1 / 90 |                      1 / 90 |
| Warm command discovery                     |     12 / 25,336 |         26 / 168,016 |               1 / 90 |                      1 / 90 |
| Command list                               |       3 / 6,334 |          13 / 84,008 |                0 / 0 |                       0 / 0 |

Calls/chars match across both times. In every scenario/run, global parsing equals the sum of durable storage, journal,
journal history/thinking/segments, native readback, pin, resolver, settings, HTTP and other. The former ordinary-turn
`other` is exactly 9 + 13 + 1 + 1 = 24 and 19,002 + 84,008 + 90 + 90 = 103,190. This reclassifies work; it does not
reduce total parsing. New counters registered as candidates only; ledger guard/check pass.

## Decision: do not cache verification to lower this counter

`verifyRotomKernel` checks canonical paths, package pin/lock identity and bootstrap digests. `nativeBuiltinCommands`
and `nativeSessionManager` then call the pinned product's `resolveInstalledPi`, whose distribution verifier validates
ordinary/canonical files, fork-build digest, package/lock identities, dependency archive integrities and transitive
source rules; resolution checks installed fork package metadata, executable/public export paths and native version.

The 13 resolver parses are inside the installed, hash-verified product snapshot, not a Team data projection. Its build
manifest is read in distribution verification and again in resolution, but changing that implementation changes the
pinned native product contract. Caching resolver results across calls would also bypass later replacement/corruption
checks. Team cannot treat the shared runtime as immutable merely because it was verified earlier. Neither shortcut is
justified or authorized by these measurements; no resolver/native code, schema, protocol, trust or unknown semantics
were changed. The remaining one 90-character event-control parse is too small to justify a cache of event objects.

Conclusion: RPC/JSONL residuals and formerly unclassified turn work have a deciding explanation; no safe meaningful
optimization found in this batch. No L1 reduction, L2 or L3 claim. Next worthwhile measurement is startup scaling at
60 sessions under a distinct workload key (existing fixture is small), rather than another cache in trust checks.
