# Round 2: Git latency phases and the deferred native reload

## Question and scope

Continue after the executor split at `710b0d3`: first investigate the repeated `git.branches/ms` slowdown, then find
what can safely be removed from the approximately 780 ms operation following the earlier fast model switch.

Work happened on `perf/model-reload-round2`, based on `710b0d3`. Only this report, its evidence JSON and an archive of
the one-off instruments were added.
No production code, threshold, workload, ledger, credential routing, installed runtime or running service was changed.
The prior model-switch implementation remains separately at `21bd757`; it is not integrated by this investigation.
The 780 ms number is previous evidence, not a new measurement in this round.

## Experiment 1: split HTTP and Git child lifetime

Used equal-length disposable checkouts of `c379bb7` and `710b0d3`, the same instrument and the existing complete
41-scenario workload. In those disposable copies only, the branch action enables a probe around its existing request.
The probe adds HTTP diagnostics and Git spawn/exit/callback timestamps; it does not add a request, replace either Git
command, skip quiet periods or alter a scenario's action window. Output phase metrics are outside the work counters.

Six fresh processes ran in counterbalanced order: old, split, split, old, old, split. Every run completed all 41
scenarios, with none unavailable. Each branches request still started exactly two Git processes and returned 208 bytes.
This is diagnostic evidence, not a new official ratchet run or a new speed claim.

```sh
node .agents/skills/rotom-team-performance-climb/scripts/timing-run.mjs round2-git-diagnostic -- \
  node /tmp/round2-git-diagnostic-run.mjs
```

Wrapper: exit 0, 716788 ms, 8 cores, load 3.31 → 7.93, `highLoad:false`. The wrapper did not collect per-scenario load.
Node 24.18.0, darwin-arm64, synthetic loopback providers, localhost proxy bypass set on both sides.

| Metric, median ms                  | Before split | After split |
| ---------------------------------- | -----------: | ----------: |
| Whole branch request               |         59.1 |        71.1 |
| Git status invocation to callback  |         55.7 |        66.0 |
| Git refs invocation to callback    |         45.1 |        50.5 |
| Request start to server arrival    |         0.69 |        0.63 |
| Last Git callback to server finish |         0.33 |        0.34 |

Whole-request samples: old `[59.1,53.5,76.9]`, split `[75.9,65.5,71.1]` ms. The median slowdown persists; do not replace
it with a claim of universal latency parity. Most of the repeated difference is in the Git child lifetimes, not in the
post-Git HTTP work. Spawn calls themselves take approximately 0.6–2.3 ms. The two commands run concurrently, so their
lifetimes must not be added as sequential work.

`git.ts`, `branches.ts`, `workspace.ts` and the branch route are byte-identical between the two revisions (`git diff
c379bb7 710b0d3 -- <these files>` is empty). The branch route invokes no native-execution method. These facts give no
additional parent-side work to remove; they do not prove that every source change is causally unrelated to scheduling.
No production patch is justified merely by these samples.

## Experiment 2: native Git Trace2 versus observed process lifetime

To distinguish Git's own measured execution from process-lifecycle time, created a separate disposable repository
with the same branch fixture: `AGENTS.md`, the same number and contents of changed files, and `main`/`feature` refs.
Each query calls the existing production `branchesIn`, preserving both commands and asserting the head, both local
branches and exact changed-file count. The probe adds `GIT_TRACE2_EVENT` only to these test children. No live repository
or account is involved.

The control counterbalances `git` selected by PATH (`/usr/bin/git`) against the developer Git selected by
`/usr/bin/xcrun --find git` (`/Library/Developer/CommandLineTools/usr/bin/git`): shim, developer, developer, shim, shim,
developer. This is a diagnostic intervention, **not** a proposed production executable override or a comparison of the
two product revisions.

```sh
node .agents/skills/rotom-team-performance-climb/scripts/timing-run.mjs round2-git-native-trace -- \
  node /tmp/round2-git-native-trace.mjs
```

Wrapper: exit 0, 1078 ms, load 6.05 → 6.05 on 8 cores, `highLoad:false`. Git 2.50.1 (Apple Git-155).

| Status process    | Wall lifetime ms | Native Trace2 exit time ms | Outside native interval ms |
| ----------------- | ---------------: | -------------------------: | -------------------------: |
| PATH, first       |             49.0 |                       4.34 |                       44.7 |
| Developer, first  |             85.2 |                       4.70 |                       80.5 |
| Developer, second |             58.6 |                       4.71 |                       53.9 |
| PATH, second      |             28.7 |                       5.01 |                       23.7 |
| PATH, third       |             27.3 |                       4.35 |                       22.9 |
| Developer, third  |             63.0 |                       4.51 |                       58.5 |

Most observed lifetime falls outside Git's Trace2 interval. Both launch paths exhibit it; selecting the developer
binary is not demonstrated to fix the problem and was not kept. This identifies process-lifecycle/initialization or
post-native-exit time as the next systems-profiling scope, not slow ref enumeration or a newly expensive branch JSON
parser. It does **not** attribute a specific macOS loader, scheduler, security check or file-system mechanism. Trace2
starts inside Git and ends before the OS reports process exit; it is not an OS profile or CPU-time measurement.
The exact historical cause of the earlier two-version difference remains unproven. Further attribution would require
an OS-level process-start/exit profile; no such access or trace was taken. This does not block correctness of the split,
but it prevents an end-to-end latency-parity assertion.

## Native reload: concrete correctness dependency

Read-only tracing of the pinned native implementation at `21bd757` found a real model-dependent capture. The
following references use `N` for
`runtime/rotom/node_modules/@bingjiang0611/rotom/runtime/pi/node_modules/@earendil-works/pi-coding-agent/dist`, and `S`
for `runtime/rotom/node_modules/@bingjiang0611/rotom/extensions/third-party/node_modules/sol-pi/src/sol-pi`.

```text
fast Team model change
  → rotate payer/model gate token
  → private rebind → native setModel/model_select
  → return actual native readback, mark needsReload
next admitted non-switch operation
  → native ctx.reload()
  → shutdown(reload): regenerate derived model config
  → reload settings/providers/resources/extensions
  → session_start: capture fresh SoL-Pi reducer configuration
  → catalog/barrier → requested operation
```

Evidence inspected directly:

- `src/server/rotom-resources.ts:284-300` derives member `sol-pi.json` with the admitted provider/model, only when the
  shared configuration does not supply that file.
- At `21bd757`, `src/server/rotom-skills.mjs:37-50` regenerates that derived view during reload shutdown using the new
  gate identity. `src/server/rotom-executions.ts:1255-1286` marks and consumes `needsReload`.
- `S/index.ts:13-35` reads configuration once on `session_start`, with an `initialized` guard. It passes reducer model
  and provider as registration options. `S/extensions/evidence-preserving-reducer/index.ts:182-200` additionally
  retains per-root reducer configuration. `provider.ts:99-120,142-145` resolves that configured model for inference.
- `N/core/agent-session.js:2007-2023` changes the main model and emits `model_select`; it does not rebuild those
  captures. The inspected SoL-Pi initialization has no model-select handler or public capture-update operation.
- `N/core/agent-session.js:3025-3058` shows that `reload` emits shutdown, reloads settings/providers/resources, rebuilds
  the runtime and emits session start. That is broader than updating the one known reducer capture, but preserves
  arbitrary trusted project extension lifecycle behavior.
- `S/config.ts:47-68` gives trusted project configuration precedence. Explicit project/shared auxiliary-model choices
  are not silently overwritten; even a full reload can retain a choice rejected by the payer/model gate.

Therefore simply deleting the deferred reload is not a valid optimization. The main agent can select the new model
while the reducer still resolves an old one. Re-emitting session start would not bypass the initialization guard and
would not update the per-root cache. Loosening the immutable inference gate to accept the old model is also invalid.
This is a source-supported correctness dependency, **not** a runtime reproduction of stale reducer inference in this
round. No new full-reload phase timing was collected; its approximately 780 ms internal breakdown remains unmeasured.

The scout also found a narrow redundant case at `21bd757`: explicit `/reload` after model switching can run the
preliminary pending reload and then the requested reload again (`rotom-executions.ts:1266-1280,1379-1381`). Coalescing
those calls may be a safe separate optimization if barrier, catalog, extension-error and clearing order are retained.
It would not remove the single reload before an ordinary next prompt, and it does not exist on this round's base as
an integrated fast-switch path. It was not patched or benchmarked here.

## Decision, limits and next authorized action

No L1 reduction or L2 speedup is claimed. Both experiments were diagnostic, with no ledger/gate changes. No application
code changed, so the earlier 724-test suite is not represented as a new run; this round executes the six full scenario
runs and the six asserted native-Git fixture queries above. Readable source hashes, samples, timing wrappers and
instrument hashes are in [2026-10-27-round2-git-reload.json](2026-10-27-round2-git-reload.json). Exact executed instrument
text, the two disposable scenario edits and the removed checkout paths are archived in
[2026-10-27-round2-git-instruments.json](2026-10-27-round2-git-instruments.json). To reproduce, use `prepareCheckout` from
`test/perf/checkout.ts` for the two recorded revisions, regenerate `/tmp/round2-diagnostic-paths.json`, copy the archived
phase module into both `test/perf/` directories and apply the two archived edits there. The native-only script's `repo`
constant must point to the current checkout; it does not choose production data. These path-bound, one-off probes are
not installed test infrastructure.

Stop after two experiments because the next ordinary-next-operation optimization needs an owner decision, not an
unauthorized native patch. Proposed next action: design a supported native dynamic model/config-update contract that
refreshes SoL-Pi reducer options and per-root state, distinguishes derived from explicit config, and keeps full reload
for extensions without a demonstrated dynamic-update capability. It must preserve payer authorization, freshness,
Stop, unknown fences and actual model readback. There is no promise that arbitrary extensions can switch in
milliseconds. Design approval would not itself authorize deployment, replacing the pinned runtime, using real accounts
or weakening lifecycle semantics.

Alternatively, port the already verified fast-switch implementation while accepting its one subsequent full reload.
That integration still must obey the 20,000-byte staged-blob rule, including any additional large file it actually
modifies. No broad size exception is assumed.

The two diagnostic checkouts and the generated trace fixture were removed after successful completion. Logs, raw
scenario reports, Trace2 events and one-off instruments remain under `/tmp/round2-git-*` for audit. No benchmark child
is intentionally left running. The owner subsequently approved publication of this investigation branch and preparation
of the [native live-model resource proposal](../native-model-resource-contract.md). That approval covers design only,
not native implementation, a pin update, deployment or a speed claim.
