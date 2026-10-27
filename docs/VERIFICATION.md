# Verification scope

Private account and deployment records are deliberately excluded from this repository and its published history. Historical source commits are retained, but their sanitized documentation is not a complete record of the original private acceptance runs.

## Local checks

Run from the repository root after installing the declared dependencies:

```sh
npm run check
npm run format:check
npm run lint
npm test
```

The automated suite uses synthetic providers, local fixtures and isolated test data. Do not use real model accounts without explicit authorization. Provider-specific proof scripts are separate opt-in checks; they are not implied by the commands above.

For every check, record the exact source commit, exit status, inspected scope and any failure. Do not treat an older passing result as evidence for the current artifact.

## Performance

`npm test` covers the ratchet, the journal, and the server's journal end to end. The benchmarks are separate: `npm run perf:measure` (real rotom processes, a loopback model, Chromium where present) and `npm run perf:ci -- <base-ref>` for before and after a change. A gating counter failing `perf:check` fails the change; millisecond numbers are evidence only with the machine's load recorded. See [PERFORMANCE.md](PERFORMANCE.md) and [PERFORMANCE-BENCHMARKS.md](PERFORMANCE-BENCHMARKS.md).

`test/perf-send-trace.test.ts` checks opaque-tag isolation, strict envelope bounds, same-clock pairing, incomplete/
ambiguous/hidden/restarted records, and another tab's user entry not confirming this send. `test/perf-journal.test.ts`
checks real HTTP validation, current view access, and raw-identity exclusion. `test/native-mirror.test.ts` checks that
failed and unchanged mirror commits emit no delivery phase with storage worker off and on. The real Chromium/native
loopback send in `test/perf-web-ui.test.ts` must produce one complete paired timeline and no raw request identity or
message content in the journal. None establishes production delay attribution, real-network propagation, or real-account
behaviour. Journal collection changes still require deployment approval.

## D6 move-only review evidence

The review-local `docs/performance/review-2026-10-23/move-equivalence.mjs` reconstructs the original
owners against frozen hashes from `5551a50`, excluding only import/local-export linkage and declared move
boundaries. It also rejoins the two stylesheets in their original order. This is evidence for D6, not a
permanent prohibition on later authorized behavior changes.

`style-move-bench.mjs` in the same directory checks all computed-style properties of controlled native/peek
samples in real Chromium, across desktop/mobile and dark/light states. The frozen golden is scoped to the
recorded macOS/Chromium environment, not a cross-platform visual standard. On a different environment,
collect paired baseline/head traces with `D6_STYLE_TRACE` and compare them; do not overwrite the golden to
make a move pass. `test/mobile-ui.test.ts` and `test/peeks-ui.test.ts` additionally exercise real app interactions.
See [the D6 record](performance/review-2026-10-23/d6-validation.md) for source revisions, full-suite results,
negative controls, stylesheet network cost and every worse performance counter.

## D7 seed-worker evidence

`test/seed-materialization.test.ts` checks both parent/worker paths: attach-before-append, private modes/public-only
history, lease retention, Stop before/after attach and readback, final revocation, file write failure, readback
mismatch, restart fencing, empty history, fork/import and no replay. Exact 8 MiB ±1-byte tests use Unicode,
JSON escapes and oversized private reasoning to distinguish public UTF-8 byte size from raw input or JS length.
[handoff-bench.mjs](performance/review-2026-10-23/handoff-bench.mjs) measures three 1/10/100 MiB handoffs per
fresh process with synthetic native inference; its benchmark-only preload measures actual copy/closure intervals.
[The original D7 record](performance/review-2026-10-23/d7-validation.md) preserves the all-worker measurements.
[The threshold follow-up](performance/review-2026-10-23/d7-threshold-validation.md) records the 8 MiB policy,
both-path tests, size-selection cost and repeated 1/10/100 MiB measurements. Neither is a production or
multi-room capacity claim.

## D8b storage-worker evidence

`test/storage-worker.test.ts` runs the public Durable conformance suite on the real proxy and databases.
It injects commit-before-crash, held/late ACK, proven rejection versus ordinary error, close failure, full queues,
queued versus dispatched cancellation, double writers and permission revocation during an outstanding read.
It also checks atomic head conflicts, multi-MiB transport pages, unknown restart/no replay and lease retention.
`test/storage-worker-app.test.ts` covers omitted/false/true switching, invalid mode, partial startup cleanup,
startup-continuation drain and the final app lease. `test/native-mirror.test.ts` runs both switch settings with a
real child-process restart and a Durable commit whose local completion is lost; it forbids duplicate mirrored entries.

```sh
node --test test/storage-worker.test.ts test/storage-worker-app.test.ts test/storage-worker-counters.test.ts test/native-mirror.test.ts test/perf-room-part.test.ts
node --import ./test/fixtures/storage-env-guard.ts --test test/storage-worker-app.test.ts
node test/team-kernel-proof.ts --storage-worker
node test/native-commands-proof.ts --storage-worker
```

The pinned application proof kills the actual storage thread during an active native prompt, then verifies native
PID termination and both retained leases after rejected shutdown. The command proof retains permissions, fixed
payer, large readback and unknown/no-replay checks. They use loopback models and synthetic credentials, not real accounts.
The environment guard rejects ambient environment or extra startup fields in the production storage worker.

The counter driver runs inside the worker too; missing counts fail rather than becoming zero. The real-counter test
compares local/worker SQL and JSON work, original room/table attribution and the historical-entry observer. V8 byte/call
counts include both threads; parent/worker serialization timings remain separate. FIFO wait/ACK timings overlap worker
and serialization time, so they must not be summed as disjoint phases. Transfer byte counts expose copy volume; ACK
round-trip includes page copying/scheduling rather than claiming an isolated structured-clone cost. `startup.restart`
records app-close and app-open phases without changing the workload or quiet window.

`ROTOM_PERF_STORAGE_WORKER=1 npm run perf:measure -- --runs 1 --out <report>` enables the same workload and installs
its worker counter preload automatically. Normal `perf:ci` stays worker-off for comparison with older revisions.
Compare on/off reports from the same product source; do not call a one-run timing difference a stable speedup.
[The D8b record](performance/review-2026-10-23/d8b-validation.md) contains results, limits and runtime-only negative controls.

## Event subscriptions

`session-subscriptions.test.ts` exercises authenticated HTTP SSE/poll: connection ownership, ACK/full-view order,
queued generation preservation, stale intents, home, legacy wire format, invalid input/sequence ACKs, and asynchronous
open cancellation on A→B→A, revocation and disconnect. `transport-reprobe.test.ts` runs the production transport and
saved-copy code with controlled network/time: stale/future ACKs, late views/missing, access-key changes, poll expiry,
unknown POST results, stalled auth probes and older servers. It does not simulate native inference.

`session-subscriptions-ui.test.ts` uses real Chromium and a temporary Team service for both transports: rapid switches,
Back/Forward, home, actual server-side disconnection, current-route recovery and no user-send requests. These checks
skip explicitly if Chromium is unavailable. `session-switch-bench.mjs` under the 2026-10-23 review measures six sequential
switches after initial attach; handshake/full-list counts are work evidence, not production latency claims.

## Rotom 0.1.25 auxiliary inference

`node test/rotom-reducer-proof.ts` launches the pinned product through Team with synthetic loopback models. It checks
that Team's default same-model SoL-Pi evidence reducer passes the payer gate, records its 14-token usage alongside both assistant
responses, falls back to raw output on invalid evidence, and never redispatches a duplicate request. An owner-selected
foreign reducer cannot reach the provider; its mismatched native usage leaves the operation unknown and fenced.
`node --test test/rotom-journal.test.ts` checks auxiliary usage attribution, deduplication and atomic rollback of
foreign provider/model entries. The new regression fails without auxiliary usage import. No real model accounts are used.

## Existing-member sign-in recovery

`node --test test/member-recovery.test.ts test/settings-ui.test.ts` uses synthetic members and isolated data.
HTTP checks cover owner-only issuance, invalid targets, immutable member identity/permissions/tunnel/primary
credential, confirmation-only redemption, cross-site POST rejection, concurrent single use, fixed expiry,
hashed persistence, restart readback, cancellation, member deletion, owner-token rotation, device revocation
and the 32-device capacity limit. Chromium checks the real People action, recovery link replacement,
confirmation, same-member login after refresh, hidden non-owner controls and phone-width containment.
Browser checks explicitly skip if Chromium is unavailable; no real member/model accounts are used.
This does not establish delivery to the intended person or diagnose a real browser's missing Cookie.

## First-message session names

`test/sessions.test.ts` checks atomic first-message naming, whitespace normalization, the 80-character limit,
empty text, and preservation of explicit names. `npm run test:kernel:app` checks native admission rejection,
first-text naming without a separate inference call, later-message preservation, and persistence after restart.
`npm run test:kernel:ui` checks that the generated name appears in the sidebar.

## Per-member finished markers

`test/sessions.test.ts` checks that two members independently receive the same finished marker, one member can clear
only their own marker, and a client cannot acknowledge a future run it has not viewed. `npm run test:kernel:ui`
checks the sidebar marker renders for a finished native session and clears after that member opens the session.
The marker means the run ended and a result is available to inspect; it does not assert task success.

## Native attachments and Qoder context budgets

`npm run test:kernel:app` verifies upload → native RPC → loopback model image bytes, attachment paths,
image-only input, receipt idempotency, permission/path rejection, mirrored image readback, restart and handoff.
`npm run test:kernel:ui` additionally dispatches a browser clipboard image into the composer and sends it without
text, then checks the answer and image in the transcript. These use synthetic credentials, not real model accounts.
`node --test test/rotom-qoder-unit.ts` checks exhausted-context refusal before HTTP dispatch and valid explicit
one-token requests. The adapter preserves the pinned native context estimator and the verified model window;
it does not enlarge that window. Native automatic compaction/retry can recover the context using the same payer/model gate.

Uploads are limited to 50 MiB each and 10 files per message. Direct model images are limited to 5 MiB each and
20 MiB total before resizing; native RPC records are bounded to 64 MiB. Larger input must be compressed or split.
The fixtures do not establish image understanding on every real provider, image-specific interrupted-run recovery,
or an OS sandbox between trusted members.

## Legacy read-only archives (D9a / D9b / D9c)

See [LEGACY-ARCHIVE.md](LEGACY-ARCHIVE.md) for the product boundary, migration scope, 256 MiB atomic-operation limit and rollback procedure.

`node --test test/legacy-archive.test.ts test/legacy-archive-ui.test.ts test/spend.test.ts test/sessions.test.ts`
checks real saved pre-D9 data, whole-root quarantine, deep ownership, pre-commit failure, lost-ACK reopening,
private recovery records, immutable archive writes, access/history/export and stream/poll controls.
Default tests materialize the pinned JSON through public Storage; they do not execute the historical producer or require Git history.

Historical read fixtures, native metadata-only fixtures and native loopback execution are separate.
`test/team-kernel-proof.ts` additionally checks actual worktree-backed fork cwd/file sharing, foreign-member
steer/follow-up/model/thinking refusal during a held native run, login refusal while that account is busy,
and native compact USD-budget rejection without receipts or model calls.
These are not inferred from Durable-path 409s. Run native application and command proofs with storage worker off and on.
The migration map and D9a evidence live under `docs/performance/review-2026-10-23/d9a-*`.
D9c deletes nine repository extension modules and twelve exclusively coupled tests, not independent approvals,
Lancet/parser, native, archive or user-source-preservation coverage. Its [inventory](performance/review-2026-10-23/d9c-inventory.md)
lists every removed test and helper. The archive suite also runs the real CLI help against synthetic drop-in files
and switch records, checking the removal/preservation guidance and unchanged files without application startup.
D9c adds no migration; rollback probes reopen the same retained synthetic data with D9b rather than using a fresh copy.

## Further verification topics

The complete resource, native-command, delivered-file, UX, tree-selector, adapter, Goal, and context-map evidence is split into:

- [VERIFICATION-RESOURCES.md](VERIFICATION-RESOURCES.md)
- [VERIFICATION-UI.md](VERIFICATION-UI.md)

These files retain the original commands, fixture boundaries, limits, and open acceptance notes by topic.
