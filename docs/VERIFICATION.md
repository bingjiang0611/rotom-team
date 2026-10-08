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

## Acceptance boundaries

- Type checking and automated tests do not establish real-account authorization, provider approval, complete billing or target-device readiness.
- Native acceptance must cover individual credential routing, history handoff, fork, compaction, app permissions, persistence and safe recovery.
- Unknown inference, tool and refresh outcomes remain unknown. Do not replay them or substitute a zero-cost result.
- Installation, restart, backup, restore and rollback must be verified on the authorized target. Restore excludes refresh grants and does not undo remote side effects.
- Keep account identities, request/session records, SSH addresses, device names and private operational logs outside Git.

See [NATIVE-DELIVERY.md](NATIVE-DELIVERY.md) for R1–R8, [NATIVE-RECOVERY.md](NATIVE-RECOVERY.md) for recovery rules, and [PROVIDER-POLICY.md](PROVIDER-POLICY.md) for provider and distribution constraints.
