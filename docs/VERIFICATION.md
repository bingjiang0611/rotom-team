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
it does not automatically compact, retry or enlarge that window.

Uploads are limited to 50 MiB each and 10 files per message. Direct model images are limited to 5 MiB each and
20 MiB total before resizing; native RPC records are bounded to 64 MiB. Larger input must be compressed or split.
The fixtures do not establish image understanding on every real provider, image-specific interrupted-run recovery,
or an OS sandbox between trusted members.

## Acceptance boundaries

- Type checking and automated tests do not establish real-account authorization, provider approval, complete billing or target-device readiness.
- Native acceptance must cover individual credential routing, history handoff, fork, compaction, app permissions, persistence and safe recovery.
- Unknown inference, tool and refresh outcomes remain unknown. Do not replay them or substitute a zero-cost result.
- Installation, restart, backup, restore and rollback must be verified on the authorized target. Restore excludes refresh grants and does not undo remote side effects.
- Keep account identities, request/session records, SSH addresses, device names and private operational logs outside Git.

See [NATIVE-DELIVERY.md](NATIVE-DELIVERY.md) for R1–R8, [NATIVE-RECOVERY.md](NATIVE-RECOVERY.md) for recovery rules, and [PROVIDER-POLICY.md](PROVIDER-POLICY.md) for provider and distribution constraints.
