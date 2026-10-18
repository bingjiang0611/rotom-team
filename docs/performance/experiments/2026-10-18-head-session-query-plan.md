# Measure the room-state head/session read

First experiment in the seventh climb batch. Question: after same-call session and receipt-row reuse, is one fresh
`roomState` snapshot still paying avoidable storage work before it checks pending/unknown state?

## Baseline

Five fresh runs of commit `b98ad15` under the timing lock, macOS arm64 / Apple M1 eight cores / Node 24.18.0.
Report `/tmp/rt-head-session-base.json`; load 2.42/2.27/2.57 → 3.38/2.76/2.70, `highLoad: false`.

| Scenario       | Kernel SQL | Head reads | Session reads | Kernel rows | Median duration |
| -------------- | ---------: | ---------: | ------------: | ----------: | --------------: |
| Four-tab open  |         84 |         28 |            14 |          56 |         48.5 ms |
| Four-tab paced |        248 |         72 |            36 |         176 |        878.3 ms |

All counts have zero spread. There are 14 and 36 room-state snapshots respectively. Each does three statements before
receipt checks: presence from `kernel_heads`, current head from `kernel_heads`, then the segment and optional model
binding from `kernel_sessions`/`kernel_segment_models`.

## Query-plan check

`EXPLAIN QUERY PLAN` against the current schema shows every lookup uses its primary-key index. The current sequence has
two `kernel_heads` index searches, then one `kernel_sessions` plus one optional `kernel_segment_models` search. A
candidate single `kernel_heads LEFT JOIN kernel_sessions LEFT JOIN kernel_segment_models` statement uses the same three
primary-key indexes, but removes the duplicate head search and two statement/row crossings. `LEFT JOIN` is required:
no head must return “initializing”, while a present head whose segment is missing must keep throwing the existing
corruption error instead of looking absent.

## Decision

Proceed with one fresh optional head-session method and use it in `roomState`. Do not cache it. Decode the same full
model-overridden binding once. Preserve the existing throwing `session` API, member/segment/full-binding checks,
pending/latest receipts and fresh unresolved-command-input fences. Expected L1 movement is head reads 28→14 and
72→36, session reads 14→0 and 36→0, and total kernel SQL 84→56 and 248→176. Receipt counts should be unchanged;
head/session category counts classify the statement's leading `FROM` table, not every table accessed in a JOIN.
The later comparison must therefore distinguish fewer statements from unchanged segment/model lookups.
