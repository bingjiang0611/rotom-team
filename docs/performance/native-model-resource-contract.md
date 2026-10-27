# Proposal: native live-model resource contract

**Status: design only. Not implemented, not an enabled Team capability.**

The owner approved designing a minimal native update contract after the
[round-2 investigation](experiments/2026-10-27-round2-git-reload.md). This approval does not replace the pinned runtime,
authorize a native release/deployment, use real accounts, or permit weaker payer/model authorization. Current product
behavior remains defined by [CONFIGURATION.md](../CONFIGURATION.md) and [AGENT-CONFIGURATION.md](../AGENT-CONFIGURATION.md).

## 1. Goal, supported scope and non-goals

Remove the full resource reload caused **only** by a same-account, same-provider/model-API model change, where the
native runtime can demonstrate that its loaded resource profile reads the current model correctly. Keep actual native
model application/readback before successful selection. Keep the following operation's work visible in measurement.

Do not promise a millisecond transition for arbitrary trusted extensions. A custom/shared/project extension with
unproven model captures still requires the existing full reload. Explicit `/reload`, actual resource changes, account
replacement, unknown outcomes, process retirement and cold startup retain their current semantics.

The earlier fast switch was developed at `21bd757`; the session integration ports it onto main's current modules,
retaining one deferred full reload. This proposal builds on its reviewed same-account authorization rotation; it does
not invent a replacement journal/gate protocol or implement the proposed reload removal.

## 2. Why a smaller design is sufficient for the known capture

The initial idea was an update event plus cache invalidation. The inspected native code supports a smaller solution:

- SoL-Pi registers reducer options once in `sol-pi/index.ts:13-35`.
- Its reducer `config.ts:31-66` retains provider/model strings, limits and a runtime-directory-derived journal ID.
- `evidence-preserving-reducer/index.ts:182-200` caches that configuration and journal per root.
- `provider.ts:99-120` resolves the model at each reducer invocation, using those retained strings. Its token limit
  already derives from the selected model at the call site.

**Keep the policy cached, not the selected model.** For Team-derived settings, resolve `context.model` at that existing
call site once per auxiliary inference. The cache then holds the selector policy and journal, not model A. A later
B → A transition in the same root must work without rebuilding the cache or re-registering handlers.

No new epoch-indexed cache, generic extension-update registry, two-phase commit, background reload queue or additional
inference is needed for this known dependency. If implementation finds another genuinely model-dependent cached value,
it must identify that value and its owner before adding targeted invalidation; this design does not authorize clearing
unrelated state speculatively.

## 3. Proposed native configuration delta

Add one SoL-Pi input, in a new supported native release:

```json
{
    "version": 1,
    "evidencePreservingReducer": true,
    "evidencePreservingReducerUseSessionModel": true
}
```

This field name is proposed, not accepted by native 0.1.26 today. Its exact semantics:

1. Omitted/false preserves existing fixed/default model selection. No existing user configuration changes meaning.
2. True means the reducer resolves the current session model at inference time and uses normal native registry
   completion. It never reads an old provider/model literal as a fallback.
3. True together with explicit reducer provider/model literals is invalid configuration, not precedence guessing.
   Validate presence in the input object before default expansion: the current parser materializes default literals,
   which must not falsely conflict with selector-only input.
4. Missing session model takes the existing observable reducer-unavailable path: no auxiliary request, no default
   provider, no manufactured success. Preserve original tool output and the existing diagnostic/receipt behavior.
5. Resolve one model for the complete request. An asynchronous await must not silently replace its model midway.
   Parent admission still rejects unsupported live model mutation while inference/compaction/subagents are active.
6. Registry completion must continue through the Team gate. Reading the current model does not grant credentials or
   bypass authorization. Usage and errors remain attributed through the existing receipt.

Team's `prepareTeamResources` would emit the new input **only for its auto-generated SoL-Pi configuration**, without
embedding model literals. It must still preserve explicit shared and trusted project configuration and its native
precedence. It must not rewrite an existing unmanaged member file. The current private/atomic write and digest records
remain authoritative for derived files.

The native SoL-Pi parser and wrapper remain the authority for configuration precedence; Team must not copy their parser
or override project choices to obtain a faster benchmark. An explicit older configuration remains fixed, even if the
gate rejects its auxiliary model. V1 may conservatively leave all explicit SoL-Pi configurations on the reload path.

The Team-generated selector is invariant across model A/B. Therefore model-only changes no longer require rewriting
that derived file. Resource preparation/policy checks for other reasons stay intact.

## 4. One positive native capability, not a new command protocol

The native RPC `get_state` already returns actual model/thinking/session readback. Propose one optional field:

```json
{
    "modelResourcePolicy": "live-model-v1"
}
```

This is a **capability of the current loaded runtime profile**, not an acknowledgment that a write succeeded. Its
absence (including native 0.1.26) means retain the current pending full reload. No new RPC round trip, secret, model
write, paid probe or negotiation retry is required.

Only the verified native runtime may emit the positive value. It means all of the following are established:

- Every active model-sensitive extension/dependency in the actual loaded profile either reads the current model on
  use or has another reviewed equivalent model-update behavior.
- The effective SoL-Pi mode is supported, including the reducer's per-root state. A handler merely existing for
  `model_select` is not evidence of correctness.
- Resource/configuration loading completed without errors. Unresolved sources, unknown inline/dynamic registrations
  or an unreviewed extension mean no positive capability.
- The capability describes the current loaded profile only. Rebuild/invalidate it whenever that profile changes.

**Bounded v1 implementation:** use the native product's existing resource descriptors/provenance and reviewed fixed
release profile. Audit the complete shipped extension/dependency graph and Team adapters, not just the top-level
`third-party` descriptor. Initially permit only the exact reviewed profile/configuration. Unknown shared/project
extensions do not opt in by name, path prefix, a setting, or a self-declared flag. They keep the old reload behavior.
Do not add a parallel Team-maintained extension allowlist or a general extension registration system for v1.

The native owner must bind eligibility to actual verified loaded sources and configuration, not merely package version
or declared extension names. Team adapters live outside the native package and must be included in that reviewed
profile/provenance check; otherwise capability stays absent. This is an implementation acceptance gate, not a claim
that all currently shipped builtins are already safe.

This bound deliberately leaves custom extension support out. Upgrade it only after a real external extension needs
the fast path and a tested native capability mechanism exists. The upgrade belongs in the native loader, not a Team
loader restored under `src/server/extensions/`.

The native runner currently reports extension handler errors rather than necessarily rejecting `setModel`. Existing
Team extension-error observation, barrier and actual model readback remain mandatory. The capability must never
replace those checks or convert an extension failure into success.

## 5. Parent transition and failure semantics

Reuse the existing journal reservation, authorization rotation and native model application order. The split modules
are the implementation locations, not new state owners:

```text
admit model B / reserve immutable receipt B
  → same-account/provider/API eligibility + no active child work
  → rotate gate identity; native rebind
  → native setModel(B); wait for native callbacks/barrier
  → read actual model/thinking + capability; inspect extension errors
       ├─ verified B + live-model-v1 + existing resource freshness checks pass
       │    → clear model-only pending reload; settle selection
       ├─ verified B + no supported capability
       │    → keep model-only pending reload; settle as existing fast-switch behavior
       └─ failed/unknown/mismatched readback or extension error
            → preserve existing failure/unknown fence; no replay or implicit recovery
next operation
  → same authorization/Stop/head checks
  → any genuine resource change or pending reload: full reload before inference
  → otherwise dispatch with actual current model through its immutable gate
```

Conditions are conjunctive. Same payer is not sufficient if account generation, provider/API, process state or other
existing eligibility checks fail. This proposal does not broaden which credentials/processes can be reused.

A missing capability is a known compatibility decision **before using the optimized next-operation path**, not a
fallback after an uncertain write. An unknown model operation may already have taken effect; do not retry it, reload
to conceal it, roll back the preference optimistically, or release its lease without proven closure.

The resource revision remains the existing bounded freshness hint, not proof that every nested source byte is current.
Do not expand its promises. Preserve explicit user reload and the documented resource-edit contract. Readiness from a
previous process/session must never be persisted as permission for a new process. The capability does not discharge
pending child closure, usage draining or active-run cleanup.

Use existing actual state readback, rather than adding a second success token. Per-execution RPC correlation and
immutable gate identity already carry operation ownership. Model A → B → A must not reuse old authorization merely
because the final model string matches A.

## 6. Code ownership and integration sequence

| Owner / repository                | Smallest authorized implementation after separate implementation approval                                                              |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Native rotom / bundled SoL-Pi     | Parse the selector; resolve the reducer model at point of use; keep fixed config; test one-root A → B → A                              |
| Native rotom core/loader          | Compute the positive capability from the actual reviewed profile and expose it in existing `get_state`; invalidate it with the runtime |
| Team resource preparation         | Emit selector only for derived configuration, after pinning the supporting native release                                              |
| Team `rotom-executions/launch.ts` | Retain existing authorization rotation and per-attempt gate checks                                                                     |
| Team `run.ts` / `operations.ts`   | Consume existing actual state readback and the positive capability; preserve all reload/error/finalization paths                       |
| Team verification/performance     | Exercise real native captures with loopback providers; measure switching **and the following operation**                               |

First land and verify the native change in its source repository, release the verified artifact, then update Team's
runtime lock/pin using the normal integrity check. Do not patch installed `node_modules`, broaden a trust exception,
change `vendor/qoder` or claim that a Team-only shim implements this native feature. Native 0.1.26 must keep working
on its existing behavior until an intentional pin update; Team must never emit an unknown new config key to it.

When actual implementation starts, keep measurement changes separate from optimization. All changed staged blobs
must remain ≤20,000 bytes. Cohesively split any additional affected policy, configuration, workload or ledger file;
this proposal is not a size-hook exemption or approval to reintroduce legacy loaders.

## 7. Acceptance gates: required before enabling

| Scenario                                                                           | Required observable result                                                                                                                                        |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Same-root reducer A → B → A                                                        | Real auxiliary requests use A, then B, then A after each actual native switch; main and reducer request capture agree                                             |
| Existing config cache already populated under A                                    | Switching to B still selects B without clearing journals, duplicating handlers or rebuilding extension runtime                                                    |
| Explicit project/shared fixed reducer model                                        | Native precedence and configured choice unchanged; incompatible gate refuses without charging another identity                                                    |
| Selector plus explicitly supplied literals / missing current model                 | Clear configuration/unavailable outcome; selector-only input remains valid despite parser defaults; no default-model inference or silent success                  |
| Changed nested dependency/Team adapter, loading error or unknown late registration | Capability absent/invalidated even when top-level descriptor names/version are unchanged; full reload retained                                                    |
| Unknown/custom extension or unsupported native release                             | Capability absent; exactly one pending full reload before ordinary inference; no claim of optimized compatibility                                                 |
| Supported profile ordinary next prompt                                             | No full reload, duplicate prepare or deferred process start hidden after timing; same native session and expected usage                                           |
| Model-select handler error or readback mismatch                                    | Existing failure/unknown behavior, not a positive capability-based success                                                                                        |
| Stop/revocation/account change at authorization await                              | No inference after revocation; old token rejected; payer/model receipt immutable                                                                                  |
| Active child/compaction or unproven process closure                                | No live transition or unsafe release; existing unknown fences retained                                                                                            |
| A → B → A and restart                                                              | New gate identity each operation; no stale capability or token restored on restart                                                                                |
| Real resource change / explicit `/reload`                                          | Full documented lifecycle still runs; pending model reload and explicit reload are not executed twice                                                             |
| Sensitivity control                                                                | Reintroducing the captured-A lookup makes the real A → B auxiliary-request assertion fail                                                                         |
| Performance                                                                        | Same instrument, low-load locked pairs, L1 reload/process/resolve work down and L2 both switch and next-operation timings reported; zero unavailable observations |

Do not substitute a fake reducer returning a requested model name for real captured auxiliary inference. Do not trigger
real paid providers to verify this design. The control test must distinguish a genuine dynamic selector from a UI-only
or main-model-only switch. Keep baseline/ledger ceilings unchanged until measured tightening is justified.

## 8. Current verification and open handoff

Independent read-only design review found no blockers. Its two concrete notes are incorporated above: explicit-key
validation before parser defaults, and negative source/loading eligibility cases. That review does not establish the
future native provenance implementation or runtime behavior.

This is a source-based design. No proposed configuration field/capability was implemented, no native release was
published or installed, and no model-switch performance gain was measured. Current evidence is the round-2 diagnostic
report and the inspected pinned sources. Proposal review and documentation checks are not runtime acceptance.

Next implementation owner: the native rotom maintainer, in `https://github.com/bingjiang0611/rotom` (the installed
package's `repository.url`). First action: confirm the target source checkout and review the bounded profile/provenance
mechanism. Obtain explicit implementation/release scope before changing native source or the Team pin. If no bounded
profile can be positively proven, keep full reload and measure/optimize its supported internal work instead. Deployment
remains a separate decision.
