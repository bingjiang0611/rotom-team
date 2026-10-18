# Skip already-seen projected entries per client

Second experiment in the fourth climb batch. Hypothesis: most streaming updates keep the same entry sequence, so a
client that already saw that sequence has no missing entries to search. A direct strict append adds only a tail.

## Implementation and safety

Each projected Room sequence gets an opaque in-memory revision token and, only for strict append, its predecessor's
token and visible tail offset. A WeakMap remembers each client's last token. Same sequence: no scan. Direct append:
scan the projected tail. Full resend, head reset, unseen/missed revisions or unknown relationship: full active scan,
still filtering through that client's independent `sentEntries` set. Wire payloads, order keys, docs and permissions
are unchanged. Tokens reference no old arrays or revisions, avoiding retained history chains.

Strict append uses the pinned Durable contract: entries are immutable, append creates the old prefix plus new entries,
and head reset inserts a new head at the front and drops a prefix. Source length plus first/old-tail entry reference
checks distinguish these operations. This is not a general mutable-array cache. Any dependency change to the Durable
entry-publication contract needs this optimization revalidated. Source projection still rebuilds conservatively and is
fully counted; append recognition adds only two identity checks to work already traversed.

Tests cover no-scan same sequence, independent tabs, full resend, direct tail, hidden append, multiple missed revisions,
head-self reset, retained-suffix reset, post-reset append, fork and restart. Missing cursor control fails `2 !== 0` for
unchanged client scans. Missing full override fails `0 !== 2` on full resend. Logs
`/tmp/rt-client-no-cursor-control.log` and `/tmp/rt-client-full-control.log`.

## Base/head, five fresh runs each

macOS arm64 / Apple M1 eight cores / Node 24.18.0 / pinned rotom 0.1.25. Base
`/tmp/rt-stats-cache-head.json`, timing-lock load 1.50→4.12; head `/tmp/rt-client-cursor-head.json`, 2.63→2.76.
Both timing locks `highLoad: false`.

| Scenario             | Client visible-entry scans base → head | Duration median base → head |
| -------------------- | -------------------------------------: | --------------------------: |
| Four-tab open        |                            1,792 → 512 |      49.6 → 47.0 ms (noise) |
| Four-tab paced reply |                              4,648 → 8 |    884.1 → 881.6 ms (noise) |
| Session open         |                                48 → 24 |      25.7 → 27.4 ms (noise) |
| Warm turn            |                                  4 → 2 |      82.4 → 75.9 ms (noise) |
| Paced turn           |                                 46 → 2 |    885.4 → 887.1 ms (noise) |

Counts have zero spread. Four-tab reductions are 71.4% at open and 99.8% on the paced reply (only two visible entries
per tab). Web open stays 24: a new browser still needs its full entry set. Large-scenario pushes and bytes are identical
across base/head. Prepared-turn push bytes vary independently in this benchmark; no payload reduction is claimed.

`perf:check`, `perf:propose --write`, ledger guard, type/lint and targeted tests pass. Propose also lowered three unrelated
prepared-turn candidates, not credited as cursor wins. No gates were promoted. Full verification is recorded at batch
close. Keep as **L1 only**, no L2/L3 claim. Removed work is not done; source rebuilding, stats and every full reconnect
remain on the same measured path. Next measurement should quantify slow-field JSON serialization before adding more
state caches or changing protocol pagination.
