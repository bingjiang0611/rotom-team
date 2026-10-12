# Native core delivery — acceptance contract

Private deployment records are excluded from this repository and its published history. This document preserves the acceptance requirements, not the original account, device or operational evidence. It does not establish a new end-to-end verification result.

## Core requirements

| ID  | Requirement                             | Acceptance boundary                                                                                                                                  |
| --- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Real ChatGPT native path                | Each member uses their own account. Refresh ownership is unique; unknown refresh outcomes are not replayed.                                          |
| R2  | Qoder native path and truthful metering | Preserve independent credentials and distinguish tokens, estimated cost and provider credits. Missing usage remains unknown.                         |
| R3  | Shared-history handoff                  | Preserve public text and paired tool history without forwarding another account's private provider state.                                            |
| R4  | Fork                                    | Preserve the selected history and project permissions without widening access or reusing execution identities.                                       |
| R5  | Compaction                              | Use the initiating member's account. Do not treat synthetic-provider coverage as real-account acceptance.                                            |
| R6  | Core app/UI and safeguards              | Verify configuration, skills, permission checks, attribution and the trusted-native boundary.                                                        |
| R7  | Persistence and recovery                | Preserve receipts and pending/unknown fences across restarts. Backups and restores must respect writer ownership and exclude refresh grants.         |
| R8  | Delivery                                | Verify a frozen source artifact, isolated installation, loopback-only service access, restart, offline restore and rollback on an authorized target. |

## Verification rules

- Run automated tests with synthetic providers or local fixtures. Real model accounts require explicit authorization.
- Record source identity, test scope and unresolved outcomes separately. A passing build is not real-account or target-device acceptance.
- Never replay an unknown inference, tool operation or credential refresh to obtain evidence.
- Keep account records, deployment targets, SSH details, private backup locations and operational logs outside Git.
- Keep provider approval, distribution rights, complete billing and remote-device readiness separate from code-level checks.

See [PRODUCT.md](PRODUCT.md), [VERIFICATION.md](VERIFICATION.md), [NATIVE-RECOVERY.md](NATIVE-RECOVERY.md) and [DELIVERY-CHECKLIST.md](DELIVERY-CHECKLIST.md) for product boundaries and remaining requirements.
