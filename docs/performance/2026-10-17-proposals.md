# Three performance programs — 2026-10-17

## Recommendation and scope

Treat these as three cumulative programs, not three unrelated micro-optimisations:

1. **Eliminate repeated work:** make current paths operate on new data, not history.
2. **Rebuild native readiness:** reduce cold startup and amortise verified static work within an exact session binding.
3. **Replatform the read path:** versioned projections, repository services, bounded history and incremental clients.

Recommend committing to program 3 as the destination, delivering program 1 first, and running program 2's native
feasibility work alongside it. Each phase earns its continuation with measurements; a large program is not permission
to keep an ineffective optimisation. The user subsequently approved phased work on all three programs. This is not
approval for deployment, account use, altered native boundaries, or a speedup claim.

The investigation followed Git/transcript/storage, native startup/admission, and server-to-browser call chains, with
three independent read-only scouts and a skeptical review. It is not a full line-by-line audit of every dependency.
Original reviewer finalization hit a provider error; its saved review was read and its continuation completed.

## First implementation batch

On branch `perf/phased-climb`, two independent optimisations are retained for L1 work reduction:

- [Fresh Git metadata batching](experiments/2026-10-17-git-metadata-batch.md): ordinary listing 5→3 processes;
  diff 4→3. Unusual/unborn HEAD falls back to scalar queries (one extra attempted command); no freshness cache.
- [Incremental native mirror decoding](experiments/2026-10-17-native-mirror-suffix.md): ordinary warm parses
  203→145, parsed characters about 559k→343k; paced characters about 1.07m→823k. Initial branch-history inspection
  after restart is retained and has a failing negative control.
- [Native readiness measurement](experiments/2026-10-17-native-readiness-measurement.md): cold/warm explicit
  discovery and the first prompt on its retained segment are registered as candidates, not promoted gates.

These are the batch's three experiments; no fourth hypothesis is started in this session. Full runtime tests pass
(439), as do the synthetic kernel and native-command proofs. All latency comparisons remain noise; no L2/L3
improvement is claimed. Stage 1 is partial, stage 2 has measurement coverage only, and stage 3 is not implemented.

Next authorised action: add controlled native startup phase measurements to separate resource resolution/materialisation,
bootstrap and RPC/registry costs; then select one measured stage-2 optimisation. Do not automatically prewarm on GET
or weaken pin verification. The larger projection/protocol work remains sequenced behind these measurements.

## Evidence

### Fresh controlled baseline

Command:

```sh
node .agents/skills/rotom-team-performance-climb/scripts/timing-run.mjs base -- \
  npm run perf:measure -- --runs 5 --out /tmp/rotom-team-proposals-base.json
npm run perf:check -- /tmp/rotom-team-proposals-base.json
```

Environment: `cecd9865d1a7-dirty`, current on-disk tree copied into a temporary checkout; macOS arm64, Apple M1,
eight cores, Node 24.18.0. Five fresh-process/fresh-data runs, loopback synthetic model and headless Chromium.
Workload: 13 sessions, 12 seeded turns, 6,000-character answers, 30 stream chunks, 20 changed files. Load before/after
was 1.97/6.24 on eight cores; timing lock reported `highLoad: false`. This includes existing user changes, not a clean
commit and not necessarily the deployed release. The benchmark removed its temporary checkout and run directory.

| Scenario          | Median duration | Work observed                                                                                   |
| ----------------- | --------------: | ----------------------------------------------------------------------------------------------- |
| `startup.restart` |         67.7 ms | 848 SQL statements; 528–529 JSON parses                                                         |
| `session.open`    |         25.1 ms | 67 SQL statements, 183 rows; 165 parses, about 618k parsed characters; 87k push bytes           |
| `turn.cold`       |      1,730.1 ms | One subprocess; about 871–874k parsed characters                                                |
| `turn.warm`       |         80.6 ms | No subprocess; 148 SQL statements; about 559k parsed characters                                 |
| `turn.paced`      |        883.1 ms | 318 SQL statements; about 1.07m parsed characters; 52.6k push bytes, including 43.7k view bytes |
| `git.changes`     |        258.1 ms | Five Git processes; 30 rows/JSON parses; about 122k parsed characters                           |
| `commands.list`   |         43.6 ms | Cached GET only; 31 parses, about 171k parsed characters; no native launch                      |
| `web.open`        |        125.4 ms | Script 39.2 ms; 99.9k push bytes; 74 HTTP requests; 971 DOM nodes                               |

These are baseline measurements, not L1 reductions or L2 improvements. Native-child JSON parsing is not counted by
the parent-process instrument. Paced answer time includes intentional fixture streaming; do not remove that pacing.
Scenario milliseconds stop when the requested result is reached; work counters continue through the unchanged quiet
window. SQL totals do not alone show which queries dominate milliseconds.

Ratchet passed both current Git gates (5 and 2). It also reported **21 candidate counters worse than the ledger**,
including session-open SQL 48→67 and parsed characters 374k→618k. Candidate warnings are not gating failures, and this
single tree-versus-ledger check is not a controlled regression attribution. Do not raise the ledger to hide them.

### Real-use journal

Read-only snapshot `/tmp/rt-journal-20261017T013410Z`: October 16 15:42–October 17 01:33 UTC; 1,650 parsed records,
972 HTTP requests, four server sessions/releases, no cut-off lines. See [opportunities.md](opportunities.md).

- Changes diff/listing together account for 8.58 seconds, about 33% of summed HTTP durations. Diff has 35 samples.
- Four settled prompts total 94.9 seconds. Time with at least one tool running totals 54.1 seconds; the longest task
  is 55.5 seconds, including 45.2 seconds tool-active. Tool identity is not collected.
- Started-process dispatch takes 2.67/3.45 seconds, versus 48/52 ms for reused processes. Dispatch-to-first native
  `message_update` takes 2.84–4.17 seconds; this is not necessarily a first visible token or pure provider time.
- Discovery usually takes 58–154 ms but has a 3.8-second tail; POST prompts reaches 4.09 seconds. Discovery phases
  are not recorded, so cold startup is a hypothesis for that tail.
- View/session-list traffic averages 70k/65k bytes per active minute across tabs. Main event-loop utilization median
  is 0.4%; longest stall is 607 ms. Whole-machine, child-process and browser load are not established by that metric.
- Browser measurements are mostly unavailable because tabs were hidden. No evidence establishes a rendering bottleneck.

Small groups are leads, not findings. HTTP/native/tool times overlap; do not add them or predict total savings by
summing overlapping phases. There is no earlier journal in the snapshot and no post-change release comparison.

## Proposal 1 — Eliminate repeated work throughout the current architecture

**Ambition:** a cross-cutting performance refactor, preserving storage and wire contracts. Best evidence-to-risk ratio.

### Work packages

1. **Batch Git facts, not stale Git results.** Combine root/prefix discovery; use porcelain-v2 branch/status headers
   for branch and HEAD, retaining numstat for line counts. Target five→three ordinary listing processes and
   four→three ordinary diff processes. Path-limited status can avoid enumerating unrelated changes if rename,
   conflict and literal-path parity tests prove equivalence. Share facts within one request; no TTL freshness claim.
2. **Index edit attribution.** Changes currently projects all transcript entries and scans them for edits. Maintain
   a rebuildable path→latest-edit index, with a committed entry watermark and the same fork/public-history semantics.
   Catch up or fall back synchronously if behind. Resolve paths under current permission/symlink rules, not old cached
   canonical paths. Historical reads disappear from repeated Changes requests; original audit records stay intact.
3. **Make native mirroring truly incremental.** `mirrorNow` first loads every journal entry and parses its body and
   payer binding, then slices at `NativeMirrorDoc.count`. Query only the committed suffix using a stable journal
   cursor; detect branch markers with a separate exact query/index. Advance cursor with the Durable mirror commit.
   Crash replay must remain exactly-once for the mirror, without settling or replaying native operations.
4. **Reuse entry projection and derived facts.** Project immutable entries once; incrementally maintain tool-result,
   row, usage and latest-assistant indexes. A byte-bounded cache may survive room eviction if keyed by body/version
   identity and privacy scope. Keep repair and branch/reset invalidation explicit. Serialize large tool details once
   rather than repeatedly to test clipping limits.
5. **Bulk committed document reads.** Startup loops through six documents per conversation; Room.open separately
   snapshots about twelve documents. Add a supported bulk read seam at one committed revision, not uncoordinated
   `Promise.all` over mixed revisions. Preserve document kinds/scopes/fork rules and the read/subscription handoff.
6. **Compute room/session projections once per revision and privacy cohort.** Entry deltas already exist; do not
   invent them again. Remove per-tab full entry/order scans, repeated field serialization and repeated session-list
   sorting. Common fields can be shared; per-member permissions, unread state, prompts, approvals and presence cannot.
7. **Stop blocking unrelated requests on directory IO.** Replace synchronous directory/symlink metadata reads with
   bounded asynchronous reads, retaining deterministic sorting, result caps, permissions and symlink checks.
8. **Improve production delivery.** Content-hashed deployment assets with immutable caching, a small production
   module bundle where useful, and safe cached compression for suitable JSON. Keep live-edit mode reload-safe and
   HTML revalidated. Measure cold/warm requests and bytes; avoid secret/reflection compression leakage and buffering
   streaming frames. Compression comes after eliminating duplicate payloads.

**Sources:** `src/server/changes.ts:255-356`, `workspace.ts:486-510`, `transcripts.ts:97-148`,
`team-kernel.ts:2373-2440`, `rotom-journal.ts:1213-1240`, `app.ts:445-497,1323-1403`,
`room.ts:179-243,352-490`, `projection.ts:100-247,498-548`, `http/api.ts` directory handler,
`http/assets.ts:130-177`, `web/store.js:352-374`, `web/transcript.js:1031-1270`.

**Removed work:** repeated history decoding, process launches, scans, projections and identical serialization. New
work is incremental commit processing and bounded indexes, not work silently shifted outside measurement.

**Biggest risk:** cache/index watermarks or Git parity changing freshness, path visibility or attribution.

**Acceptance:** separate measurement commits for diff (tracked/untracked/rename/unborn/detached/conflict/literal paths,
invited folders), list→five-diffs, 12/24/100-turn histories, room eviction, and 13/60/500-session startup. Measure query
families, old versus new rows parsed, FS operations, projection visits and fanout by tabs. Test crash/catch-up, repairs,
external edits, symlink replacement and permission removal. Target Git counts are design goals, not measured wins.

**Rollback:** indexes are disposable and rebuildable; retain scalar/query fallbacks. No authoritative history rewrite.

## Proposal 2 — Rebuild native readiness, not merely keep more processes

**Ambition:** a native-runtime engineering program spanning Team, the pinned product launcher and resource loading.

### Work packages

1. **Measure every cold phase before redesign.** Split attestation, resource checks/resolution/writes, helper probe,
   spawn/module load, session reconstruction, extension/MCP startup, state/registry readiness and dispatch. Add
   cold/warm POST discovery, discovery→prompt reuse, configuration and child-agent readiness scenarios. Native
   child counters and parent counters must both be reported; moving work into the child is not a reduction.
2. **Exploit exact-segment retention already present.** Verify that explicit successful discovery followed by prompt
   has one process total. Retention is already keyed by segment; there is no free extra pooling win. Consider an
   explicitly member-authorized preparation action, with bounded RAM/process residency and demand eviction of
   provably idle/closed workers. Never start native from ordinary GET/session viewing, focus, or metadata refresh.
3. **Cache pure resource derivations, not admission.** Resolve unchanged package/resource graphs once; skip identical
   managed-file writes. Keys must cover the dependencies actually cached. Keep member-private collision checks,
   integrity, account gates and current native registry validation. The current bounded resource fingerprint is a
   freshness hint, not a complete dependency attestation; do not pretend it is stronger or weaker than its contract.
4. **Build a lean, phase-aware native bootstrap.** Explore compiled/static module startup or a dedicated launcher
   that amortises verified static metadata. A worker remains dedicated to its immutable HOME/workspace/session/
   payer/model binding, with no shared extension memory, MCP clients or credentials. Retain launcher verification;
   memoizing hashes is unacceptable while runtime files can change without detection. An actual immutable/attested
   deployment would be a separate prerequisite, not something mtime caching establishes.
5. **Progressively initialize only explicitly optional facilities.** Investigate lazy Computer Use connection,
   command-description hydration and optional MCP setup through supported native APIs. Hooks that alter prompts,
   tools, auth or trust must be ready before dispatch. Extension initialization is executable behavior: silently
   skipping it or returning success before its errors are known changes semantics. This may require upstream work.
6. **Expose an authoritative registry generation.** Cache command catalogs per process generation; revalidate the
   generation at dispatch and refresh after native mutation/reload. Without native authoritative invalidation, keep
   full registry checks. Never let an unknown/protected slash name fall through to model input.
7. **Optimise the actual tools and children, not just the launcher.** First use deterministic tool/child fixtures to
   distinguish module start, IO, inference and integration. Reuse inert child bootstrap metadata; never recycle live
   child authorization across receipts. Parallelize only operations proven independent by the execution contract,
   not arbitrary side effects. Parent completion still waits for proven supported child/controller closure.

**Sources:** `rotom-executions.ts:900-1230,1360-1500,1593-1608`, `rotom-kernel.ts:193-229,270-309,370-504`,
`rotom-resources.ts:93-319`, `rotom-rpc.ts` settlement/child lifecycle, `docs/CONFIGURATION.md:155-191`.

**Opportunity envelope:** measured cold dispatch contains roughly 2.6–3.4 seconds absent from reused dispatch; the
synthetic cold/warm scenarios are 1,730/81 ms. Neither comparison is a predicted speedup. Preparation moves work
before demand and must be measured end-to-end including preparation CPU/IO/RSS. It does not reduce provider/tool time.
Tool-active time is the larger observed task component, but the real tool is unidentified.

**Biggest risk:** altered startup side effects, resource freshness, immutable identity or child closure. A shared
credential-bearing Agent pool is expressly excluded, even if it would be fast.

**Acceptance:** phase counters first; current retained-path controls; extension/registry mutation; permission revocation;
reload, handoff/model changes; MCP failures; child/Goal/Stop/unknown races; cold, prepared and evicted paths. Include
process/RSS budgets and preparation costs outside the foreground path, and delayed/failed optional dependencies.

**Rollback:** feature flags and old verified launcher/initialization path; new native pin/provenance and compatibility
checks before release. No production startup, helper action, account use or deployment is authorized by this proposal.

## Proposal 3 — Replatform the read path into incremental, bounded services

**Ambition:** the boil-the-ocean option. Replace the read architecture, not the durable execution/audit authority.

### Work packages

1. **Versioned materialized read models.** Derive compact session summaries, transcript pages, edit facts and usage
   from existing committed publications. Consume commits once; use a watermark, version and body digest. Build in
   shadow mode and compare output with current projections. Do not create a competing execution journal or rename
   stored document kinds. Consistency/catch-up fallback is required before serving a projection.
2. **Repository read service.** Explore a per-repository service retaining immutable object/index metadata and
   content-addressed diff results. Use native Git accelerations such as supported fsmonitor/untracked caches first;
   benchmark a Git/libgit2-style engine only if launch/scan work remains important. Watchers invalidate candidates,
   not certify truth. Cover external tools, index/HEAD/ref replacement, linked worktrees, overflow, filters, conflicts,
   submodules and byte paths. Keep fresh command-line fallback; arbitrary filesystem state cannot be made exact by
   a TTL or a watcher alone. No mutation of production repository config without approval.
3. **Revisioned live/session protocol.** Negotiate v2 alongside v1. Send keyed session upserts/removals and live text
   append/segment-replace operations with base revision, sequence and explicit reset. Share authorized serialized
   payloads across tabs. Bound replay by bytes/count; a gap or overflow causes authoritative resync, never guessed
   state. Durable entries already use deltas; eliminate full live-message replacement and full session arrays.
4. **Bounded server hydration and client memory.** Start with the newest transcript page, with revision-bound older
   cursors. Do not build the entire Durable ConversationView just to discard most of it afterward. Preserve full
   export, audit history, branch/tree/fork access, tool-result pairing, jump-to-entry and cross-page search.
5. **Fine-grained client updates.** Normalize entities; subscribe components by slice. Avoid copying the complete
   entry Map for a live-only event and avoid transcript-wide scans before viewport filtering. Existing DOM windowing
   already caps visible history; add anchored variable-height virtualization only where larger fixtures prove value.
6. **Main-thread budget and backpressure.** Move sufficiently large diff/Markdown/highlighting/index work to workers
   after measuring transfer/startup costs. Preserve sanitization and rendering semantics. Keep synchronized hidden
   tabs with bounded/coalesced revisions; never omit approval, unknown, terminal or authorization transitions merely
   because a tab is hidden. Slow clients resync explicitly rather than building unbounded buffers.
7. **Separate heavy reads from execution control.** Consider workers/processes for projection, repository reads and
   expensive parsing so they cannot stall admission, Stop or account gates. Use existing committed state plus a
   watermark, not a second writable execution authority. Count total CPU/IO/RSS across processes; isolation alone
   improves contention behavior, not necessarily total work.
8. **Native/tool and hardware scale tests.** Combine program 2 with this architecture; profile deterministic tools
   and only parallelize proven-independent reads. Test long answers, large repos, many sessions/tabs and reconnect
   storms. Faster cores/SSD or more RAM are optional evaluated capacity choices, not assumed fixes: current main-loop
   utilization does not justify buying hardware. Linux needs its own measurements/baselines, not copied Mac numbers.

**Sources:** `room.ts:352-490`, `app.ts:1323-1403`, `web/store.js:352-374`, `web/app.js:531-542`,
`web/transcript.js:1031-1270`, `web/diff.js` parse/render path, `http/events.ts`, and Durable's existing
`dist/harness/view.js:77-168` commit-publication/operation flow. The installed dependency already produces operations;
Team currently reconstructs much of the final projection afterward. Use that seam rather than rebuilding durability.

**Removed work:** history-scaled foreground hydration and repeated fanout, copying, parsing and rendering; repeated
repository discovery/scan on validated hits. First-time/index work still exists, bounded and observable. New overhead:
watermarks, invalidation, replay, shadow checking and worker communication. Measure all of it.

**Biggest risk:** missing revision/cursor or wrong privacy partition makes the UI show incomplete or private state.
This is a serious protocol/storage-adapter migration, not a quick cache patch.

**Acceptance:** measure 60/500 sessions, large histories, 6k/60k answers, multiple tabs and variable-height/mobile
layouts separately under new workload keys. Validate large page/search/jump/fork/export behavior, byte-bounded memory,
patch loss/duplication/reordering, reconnects, history resets, permission changes, slow/hidden tabs, unavailable workers,
watcher overflow, external Git edits, and shadow parity. Track visible completion and cumulative CPU/bytes as well as
first paint; showing a placeholder earlier is not evidence the same requested information became faster.

**Rollback:** dual protocol and old client/server fallback for a release; disposable read models/indexes; current Git
fallback; unchanged authoritative transcript/receipts. Pin/deployment/data migration planning is separately approved.

## Shared delivery rules and decisions

- Measurement and optimisation are separate commits. Register candidates from two times; promotion needs stability,
  deliberate regression sensitivity and millisecond correlation plus user approval. Tighten only from passing evidence.
- Keep code only when relevant work counters decrease without offsetting another regression. Claim faster only with
  same-instrument quiet before/after comparisons (`faster`, `highLoad: false`), then separately verify a release in real
  use with at least 30 comparable samples across at least two server sessions.
- Small fixtures can prioritise Git/cold startup but do not establish large-session scaling. Explain candidate warnings
  before attributing them, and never remove fixture pacing, quiet checks, assertions or counted work to improve a number.
- Do not use weaker fsync/durability, shorter audit retention, truncated history, delayed unknown outcomes, stale caches,
  automatic write replay, cross-member credentials/context, or skipped native trust/hooks as performance shortcuts.
- More measurements in tests and controlled benchmarks are allowed. Changing production journal collection/records,
  reviewing private tool traces, paid account experiments, hardware purchases, service/repository config changes,
  native-boundary changes, deploy/restart, push/PR or ratchet relaxation require the appropriate explicit approval.

**Decision recorded:** the user approved phased implementation of all three. The first batch above is committed
locally with separate measurement and optimisation commits. No repeat approval is needed for the next isolated
measurement/optimisation batch. Deployment, push/PR, journal changes, gate promotion/relaxation and real-account work
still require explicit approval. The running service and its data remain untouched.
