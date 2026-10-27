# Anonymous send correlation and bounded responsibility modules — 2026-10-27

## Result and limits

This is measurement and responsibility extraction, not a speed optimisation. It supplies the missing join between
native admission/dispatch, the committed sender mirror entry and that request's browser confirmation. Production's
previous unpaired 1.554 s median is still unattributed. No L1 reduction, L2 latency gain or L3 production gain is claimed.

Final runtime acceptance: 725/725 tests, zero failures/skips; typecheck, formatting/lint and the authoritative staged
20,000-byte checker pass. Corrected performance CI passes against both the immediate parent `5cfc7769f769` and local
`origin/main` at `c379bb7cfb57`, one pair each, both `highLoad: false`. A production account, restart, deployment and
push were not used. The owner must separately authorise deployment/collection before this can explain production.

## Correlation contract

- Six native milestones: `entered`, `admitted`, `reserved`, `dispatch`, `mirrored`, `returned`. `wait:false` return
  means reservation, not successful delivery or completion. Mirror timing follows a successful changed commit.
- Process-local HMAC-SHA256 tags use a fresh 256-bit secret and truncate to 128 bits. Inputs are the existing native
  session/member-prefixed request identity. No request lookup/cache is added; a restart changes tags.
- The private `/api/perf` send envelope accepts only conversation/request identity under the authenticated member's
  visibility check. It cannot supply a trace or member. Raw identity and message content are excluded from published
  observations. Only `send.*` browser observations are tagged; aggregate reply timings are not falsely attributed.
- Browser waits match their own new user entry's exact `requestId`. Another member/tab's entry or inbox update cannot
  confirm them. Existing queue/batch bounds (100/20), no-retry behaviour, native safety and 90 ms push coalescing remain.
- `analyseSends()` joins server-session plus opaque tag. It subtracts only same-clock server timestamps or browser
  durations, and reports missing/duplicate/hidden/mixed-transport/invalid records as exclusions, never success or zero.

## File-size extraction and review repairs

The shared hook required the exact mainline `scripts/check-staged-file-size.mjs`, missing on this older branch.
That checker is copied byte-for-byte; no shared Git setting, exclusion, limit or hook bypass was used.
Touched oversized files were split into cohesive domains:

- TeamKernel: stored document definitions, home/execution setup, submission/model/history, access/request/catalog,
  mirror/room/runtime and lifecycle/export. The stable facade retains runtime-private `#` state. Domain capabilities
  have explicit types; broad owner `any`, prototype-stub weakening and facade runtime cycles were rejected.
- Rotom executions: contracts, launch/run/native-operation handling, session/lifecycle and seed context.
- HTTP: administrative routes. Journal: bounded file-store operations. Browser: shared state, views/projection,
  events, connection ownership and navigation; the public facade keeps its original exports.
- Performance/verification guides: benchmark, resource and UI guides. The 55,800-byte opportunity log is separated
  by approved-program, journal and early-climb responsibility; moved bodies are preserved, and old headings remain
  link redirects. No historical plan is promoted into a current requirement.

Parent acceptance found real extraction regressions, not merely test-path problems:

1. Missing JS import bindings and attempted writes to an imported connection variable. Transport now owns its mutable
   connection; leaf helpers receive explicit recovery callbacks. Added name/export/import-assignment diagnostics and
   an ownership import-cycle test. Existing VM tests now execute the corresponding production module bodies.
2. A copied primitive `closing` flag stopped lifecycle, authorization and execution gates sharing state. They now share
   a runtime-private holder; a composition test checks identity and a close-state update through both domains.
3. Accidental removal of `#` changed resume identity/mirror filtering. Original `#resume-`/`#resume` markers are restored;
   the real mirror restart tests now also preserve a normal request containing the word `resume`, worker off and on.
4. Independent source review found a copied `extensionError` value lost later native events across an await. The
   operation domain now reads the live binding through a getter. Three checks use the real executeRun and durable
   journal with only RPC synthetic: discovery, prompt and active Goal failures stay `unknown`, evict and close the
   failed process. Capturing the old value again makes all three fail with `handled` instead of `unknown`.
5. Corrected counters exposed a duplicated builtin-command lookup introduced by extraction. The operation domain now
   consumes the already-read catalog, as before the split. The extra native-resolver/pin/read work is removed; no
   trust check, original query or error handling was deleted. Unused lifted operation parameters were also removed.

Stored document initializers (seven) match the pre-split snapshot under the TypeScript AST printer. Runtime literal
inventory of TeamKernel, Rotom executions and browser store loses no original literals. Independent read-only review
also inspected authorization, ownership, gate/seed semantics, API/journal seams and store side effects. Review and
these structural checks supplement, but do not replace, the parent-owned suite and real Chromium/native cases.

## Benchmark provenance repair

`prepareCheckout()` previously used `git ls-files --modified --others`, which compares the working tree with the
index. After staging, it silently omitted staged modifications/additions; staged deletions were omitted too. A clean
CI exit therefore did not prove the candidate had run. Pre-copy-repair correlation reports are not acceptance evidence.

The helper now compares the full working tree with HEAD using `--no-renames`, carries untracked files and explicit
both-end moves/deletions, and creates new parent directories. One fixture verifies fully staged, partially staged,
unstaged, new, removed and renamed paths while preserving the source index/status. Reinstating the old selector fails
on `staged.txt` (`base` rather than `staged change`). A prepared candidate checkout was also checked by SHA-256 against
all 62 then-changed/new files. All final accepted runs use the repaired helper with all runtime changes staged.

## Final commands and evidence

All checks ran locally on Node 24.18.0, darwin-arm64, synthetic/loopback workloads only. Tests and performance runs unset
all six proxy variables and set `NODE_USE_ENV_PROXY=0`. Every timing run used the skill's timing-lock wrapper.

| Check                                                             | Result                                                    | Evidence                                                                                 |
| ----------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `npm run format:check`, `npm run check`                           | pass; format check also runs ESLint                       | final runtime revision, before documentation-only records                                |
| `npm test`                                                        | 725 pass, 0 fail/skip; 229,151 ms                         | `/tmp/rt-send-trace-final-725-suite.log`                                                 |
| Exact confirmation, envelope/privacy, real native/browser pairing | pass within full suite                                    | `perf-send-trace`, `perf-journal`, `native-mirror`, `perf-web-ui` tests                  |
| Extension-error capture control                                   | 3 expected failures; restored live getter passes          | `/tmp/rt-send-split-extension-negative.log`                                              |
| Staged-checkout selector control                                  | expected failure; repaired selector passes                | `/tmp/rt-send-split-checkout-negative.log`                                               |
| `perf:ci -- 5cfc776 --runs 1`                                     | gates and ledger guard pass; 263,712 ms, `highLoad:false` | `/tmp/rt-send-trace-accepted-parent/{base,head}.json` and `.log` sibling                 |
| `perf:ci -- origin/main --runs 1`                                 | gates and ledger guard pass; 264,419 ms, `highLoad:false` | `/tmp/rt-send-trace-accepted-main/{base,head}.json` and `.log` sibling                   |
| Parent A/A control, same benchmark                                | pass; 260,695 ms, `highLoad:false`                        | `/tmp/rt-send-trace-aa-control/{base,head}.json`, `/tmp/rt-send-trace-aa-control-r2.log` |
| Staged file-size checker                                          | pass without exemptions                                   | `node scripts/check-staged-file-size.mjs`; exact mainline checker                        |

The A/A driver verified empty production `src`/`web` diffs at `5cfc776` before measuring that revision on both sides.
Its first setup failed before measurement because nested prepared checkouts expose the generated node_modules symlink
as untracked. The successful retry used a process-local Git exclude for `node_modules` only, not a repository config or
size-check exclusion. The first failed setup is not a result; all temporary benchmark worktrees were removed.

## Costs, remaining counters and next evidence

The module split adds six resource requests on first open and revalidation. `assets.first` grows from 54 to 60 requests
and from 408,479 to 412,119 gzip body bytes (+3,640). This is a required cost of the accepted source decomposition,
not an optimisation. Conditional requests remain conditional; no new polling or push cadence is introduced.

Every larger measured counter is retained in the [61-row immediate-parent record](2026-10-27-send-correlation-parent-counters.md)
and [71-row mainline record](2026-10-27-send-correlation-main-counters.md). Beyond asset loading, these include extra
sampled projection/push work, browser rendering/DOM samples and payload-width differences. The A/A pair also changes
47 counters, including a turn with one more view, nine SQL statements/eight rows, render counts and small JSON records.
That control supports a scheduling/measurement explanation, but does not prove every candidate delta harmless.
They remain leads; no workload, existing ledger entry, tolerance or ceiling was relaxed. The owner can choose a named
scenario for repeated isolated measurement before proposing a specific optimisation.

One pair per base is not adequate latency evidence. Browser and server clocks are not compared, shaped response
latency still does not establish per-chunk SSE propagation, and normal perf CI has no active journal subscriber:
production journal-write overhead is not measured here. An earlier pre-extraction cold synthetic capture found a
complete trace, not a production attribution; the final real-browser test again requires a complete trace rather
than asserting a hard-coded duration. The next authorised production collection must retain server-session plus
opaque tag and the report's exclusions; only then can the 1.554 s wait be partitioned without guessing.
