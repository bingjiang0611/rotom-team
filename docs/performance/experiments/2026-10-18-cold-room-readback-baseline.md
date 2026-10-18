# Measure duplicate full-history readers in cold room projection

Second experiment of the ninth climb batch: a safer alternative to the rejected targeted-query hypothesis.

Five fresh runs `/tmp/rt-goal-target-base.json`, macOS arm64 / Apple M1 eight cores / Node 24.18.0 / rotom 0.1.25,
report load 1.91→4.43, timing lock `highLoad: false`. Baseline `5c3d2f7` plus unchanged existing user edits.

| Scenario             | Total decodes | Thinking decodes | Direct segment decodes |  SQL / rows | View pushes |
| -------------------- | ------------: | ---------------: | ---------------------: | ----------: | ----------: |
| Dormant session open |           165 |               58 |                     56 |    61 / 177 |           2 |
| Four-tab large open  |           860 |                0 |                    660 |   163 / 912 |          14 |
| Four-tab large paced |         1,766 |                0 |                  1,198 | 647 / 1,702 |          36 |

Counts have zero spread. For dormant session open, two pushes each perform a 28-entry Goal read and another 28-entry
thinking read plus binding decode. Together they decode about 482.7k of the scenario's 618k JSON characters.
`agentInfo` is viewer-independent (public model/current thinking/workspace/payer name) but still computed per client.
Its thinking fallback and nativeGoal both select the fresh current segment. Live thinking takes precedence when the
process is retained, which explains zero journal-thinking scope in large-history scenarios.

## Candidate implementation boundary

Add a room-wide `roomInfo` projection that calls the unchanged native Goal and agent readers synchronously, with a
local map of full parsed entries keyed by exact segment ID. No session/binding is cached; the existing fresh session
reads select each consumer's segment. The entry map lasts only for that one fanout and is created anew on standalone,
full/reconnect and next fanout. Share the public agent projection with Goal across tabs, not roomState, commands,
member/private quota or receipt/input fences. Do not omit any full JSON decode/errors or change the existing branch
and thinking reducers.

Expected L1: dormant open avoids two duplicate 28-entry decodes; large fanouts avoid per-client repetition of agent
metadata reads. Source attribution should still partition every parse exactly. Prove dormant/current live thinking,
Goal clear/wait/branch, malformed unused entries, different segment IDs, three-role privacy and independent next-call
freshness before retaining. No targeted SQL parsing, schema change or cross-call cache.
