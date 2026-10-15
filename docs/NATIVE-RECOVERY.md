# Native recovery: inspect first, never replay an unknown operation

This is an operator workflow for the trusted-native deployment, not an OS sandbox or an automatic repair command. A settled native transcript is not proof of business success. A dead parent PID is not proof that its tools, detached processes or remote jobs stopped.

## Read-only inspection

From the installed source/artifact root, use its Node 24 runtime:

```sh
node scripts/data.mjs inspect-native /absolute/path/to/data
```

The command works without starting PocketApp or acquiring/releasing its writer lease. It opens the native journal read-only, does not migrate schema 1/2, and reports:

- Whether `kernel.lock` exists and its recorded parent PID. PID existence/identity and descendant closure are **not** inferred.
- The total number of pending/unknown receipts, at most 100 receipt identities, and an explicit truncation flag.
- Logical conversation, immutable segment, payer member, operation, recorded status and whether a transcript was bound.
- `toolClosure: "unknown"` and `replayPermitted: false`. No prompt, transcript, raw binding, workspace/HOME path, account generation or credential is printed.

The journal counts/rows share one read transaction. The separately sampled lease is diagnostic metadata, not an atomic ownership proof. Non-regular journal/lease paths and unsupported schemas fail closed. This output is private operational metadata; do not publish it. A truncated list is not a full receipt inventory.

## Decision table

| Observed state                                               | Safe next action                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST response lost, app available                            | Read the original operation/request ID through `kernel-request`; never resend the POST. A fork's allocated target remains its identity even without a native receipt.                                                                                                                                                                                                                                                                                                                        |
| App creation intent without a journal binding                | Normal startup can finish only the unexecuted binding step from its recorded immutable setup; it does not infer current account/configuration settings.                                                                                                                                                                                                                                                                                                                                      |
| Recorded fork/configuration plan without a seed receipt      | Read the original identity. With a recorded plan, no native receipt and no live admission, readback explicitly reports `preparedOnly`; the UI can recheck and dismiss only its local pending state. The server record and draft remain, and a duplicate never runs the seed. Active/unknown operations cannot use this dismissal. Reconciled backup/checkpoint provenance remains an operator prerequisite; absence in an unchecked older restore is not proof about later external effects. |
| Previously bound app conversation but native journal missing | Stop. Restore/reconcile the corresponding authoritative stores. Do not recreate prior execution from current defaults.                                                                                                                                                                                                                                                                                                                                                                       |
| Journal execution without app metadata                       | Stop. Restore/reconcile app metadata. Only a single untouched initial binding with no file/attempt may be removed automatically.                                                                                                                                                                                                                                                                                                                                                             |
| `dispatch-intent` or `unknown`                               | Inspect the same native/remote operation and its effects, without issuing another inference, refresh or tool action. Leave the HOME/conversation fence intact if the outcome cannot be established.                                                                                                                                                                                                                                                                                          |
| Lease exists after parent death                              | Do not delete it because a PID is gone. Account for the actual kernel/tool descendants and remote jobs; unresolved closure requires operator intervention, not a new writer.                                                                                                                                                                                                                                                                                                                 |

The current product deliberately has no universal `force-unlock`, mark-unknown-success or replay recovery API. Readback can establish an already recorded outcome; it cannot manufacture a missing terminal result or prove arbitrary external side effects. If evidence remains insufficient, preserve the files and stop. Re-login does not reconcile an earlier tool effect, and OAuth refresh tombstones must not be erased to force another attempt.

## Startup continuation policy

Startup never turns an `unknown` prompt into `interrupted` just because its native PID is gone or its
transcript is readable. It preserves the receipt, conversation/HOME fence and any legacy pending resume
plan without submitting a new request. Legacy `interrupted` classifications are not automatically resumed
because older releases could derive them from an unknown outcome without authoritative closure evidence.

Only an explicitly planned shutdown continuation whose original receipt is already `settled` can start
automatically, under the same member and the ordinary admission checks. This preserves known clean-stop
continuation without treating an unsuccessful/unknown stop as safe. A recovered browser login does not
clear execution fences. Operators must reconcile unknown task effects separately.

## Backup/restore and rollback

Stop the supervised service, prevent automatic restart and establish writer/tool closure before the existing offline backup procedure. `backup` refuses an unreconciled native lease, even if its parent has died. Use `docs/DEPLOYMENT.md` for the designated service controls and the original-path restore procedure.

Restore excludes model refresh credentials, including native child auth stores. Obtain new independent sign-ins rather than copying or resurrecting grants. Preserve the pre-restore data and evidence. Restoring an older database does **not** roll back remote side effects or prove that receipts created after that checkpoint never existed; reconcile the checkpoint and those effects before using the restored deployment. Disabling the native backend does not bypass pending/unknown fences.

## Verified scope and limitations

- `test/native-recovery.test.ts` checks CLI readback, unchanged receipt/lease state, bounded output, private-field exclusion, symlink refusal and schema-1 inspection without migration.
- Its controlled OS fixture reserves a durable intent, starts a detached Node descendant and kills the journal-owning parent with SIGKILL. The descendant demonstrably survives; journal reopen and backup stay blocked, and inspection leaves the lease/intent untouched. Teardown terminates only the fixture's known descendant and confirms its exit before removing fixture data. This is not a production force-unlock implementation or a test of every native tool's process tree.
- `test/startup-recovery.test.ts` checks two real app reopen cycles with dead-PID unknown attempts, legacy pending plans and legacy interrupted classifications. It asserts unchanged receipts/plans and zero automatic submissions; reverting the startup guard makes the unknown-to-interrupted assertion fail.
- `test/team-kernel-proof.ts` retains the clean, settled shutdown continuation check and verifies a genuinely killed native process stays unknown across two restarts with no additional loopback model requests.
- Existing pinned-process app/RPC tests cover cancellation/revocation, direct-child closure, persisted receipts and restart non-replay. They do not prove that arbitrary descendants or remote jobs have terminated.
- Actual host power loss, hardware failure, filesystem durability under power failure and arbitrary remote-effect reconciliation remain unverified. No guarantee of those scenarios is inferred from SIGKILL, fsync calls or a clean backup/restore test.
