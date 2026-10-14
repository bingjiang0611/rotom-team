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
it does not automatically compact, retry or enlarge that window.

Uploads are limited to 50 MiB each and 10 files per message. Direct model images are limited to 5 MiB each and
20 MiB total before resizing; native RPC records are bounded to 64 MiB. Larger input must be compressed or split.
The fixtures do not establish image understanding on every real provider, image-specific interrupted-run recovery,
or an OS sandbox between trusted members.

## Shared agent resources and command inventory

```sh
node --test test/rotom-resources.test.ts test/native-command-menu.test.ts test/team-resource-backup.test.ts
node test/team-resources-proof.ts
node test/native-command-inventory.ts <attested-terminal-inventory.json>
node test/native-tui-prototype.ts
node test/mcp-sign-in-proof.ts
```

The resource unit checks derive shared settings, preserve credential/unknown-state bytes, reject credential declarations,
restore declared configuration, detect private config writes and set every native computer-use override. The actual pinned
resource proof installs unknown extension names and checks arguments, standard UI interactions, context/skill loading,
stored trust, native reload, package/setting/direct project-extension negative controls, awaited async follow-up and
post-effect-error replay fencing. It records real native read-only command outputs, shared direct/package roles, pre-start
project-role rejection, a late project-settings denial at the actual native subagent tool boundary, and frozen context
composition. Dedicated regressions cover two-member managed file retirement, credential aliases, linked-package fingerprints,
dotted/non-ASCII command grammar, unknown discovery without a second POST, and real offline npm backup/restore/reinstall.
The browser proof creates an actual abruptly-ended discovery and checks the native startup counter for same/new-request retries.
The native command proof also executes a genuine effect-then-throw command during an ordinary active prompt. It checks the
persisted effect, unknown owner with unchanged operation, duplicate refusal, absent recovery eligibility and no restart replay.
Journal tests cover both unresolved and confirmed-handled inputs; read-only inspection exposes the fence without command text.
The schema-1 migration fixture is reconstructed without newer tables, and schema-5 inspection preserves operation identity.

The inventory script compares all 45 supplied terminal name/source pairs to actual isolated Team discovery. It records
39 raw baseline entries and 37 allowed catalog entries (not 37 working interactions); it does not claim 45 behavioral passes. Five personal skills are deliberately uninstalled by user choice, not replaced by fabricated skills. Read-only terminal SKILL.md metadata evidence is private and stays outside
Git. Every row and remaining interaction gap is listed in [NATIVE-COMMAND-COMPATIBILITY.md](NATIVE-COMMAND-COMPATIBILITY.md).

The PTY experiment runs the verified CLI and a real custom component on an OS PTY. It proves a native key interaction,
native persisted effects and session identity in a synthetic fixture. Its receipt remains unknown. It is not a browser
terminal implementation, generic command-completion proof or production backend. `/context` and `/llama` RPC warnings
are not success. No real accounts or external destructive actions are authorized by these checks.

MCP fixtures now deliberately install server definitions into the shared profile, not project `.pi/mcp.json`; tokens remain
per-member. The browserless OAuth callback, private token routing and sign-out assertions remain. Frozen context retains
the shared base agent MCP, while project MCP/configuration stays closed.

## Personal skills do not block native runs

`npm run test:kernel` keeps skills in both member-HOME directories and a personal `skills` setting. It verifies that
startup succeeds, personal skill commands/descriptions are absent, and project, ancestor and bundled skills still
load. Project exclusion patterns remain effective. `npm run test:kernel:app` verifies parent/child requests with
personal skills installed and that slash-command suggestions exclude them. The app fixture also covers frozen
configuration, project settings skills, history and restart. These checks use only synthetic credentials.

Existing `unknown` receipts are not rewritten or replayed by this change.

## Team subagent defaults

`test/rotom-subagents.test.ts` checks fresh and existing settings for two isolated member HOMEs, preservation of
unrelated settings, private file permissions and no rewrite when defaults already match. `npm run test:kernel`
uses the actual pinned subagent tool against a loopback model: its executable list contains only `scout`, `worker`
and `reviewer`, and new tasks naming `delegate`, `oracle`, `advisor` or `researcher` are rejected as unknown agents.
This does not use real accounts. Independent reader enforcement is covered by the resource proofs above, not inferred from
the default-role test. Actual child inference/usage, fd-3 owner lifetime and Stop remain covered by the Team kernel proof.
The same proof checks optional named-skill/memory/refinement refusals before child inference and pre-execution rejection of
user-provided workflowScript. Native structured single-child normalization is not programmable-workflow coverage. Native scoped
ownership itself rejects synchronous script controllers; the async script delivery/lifetime gap is an explicit unsupported
capability, not simulated completion. See the user-approved subset in NATIVE-COMMAND-COMPATIBILITY.md.

## Delivered file links

`test/delivered-files.test.ts` uses an isolated server and synthetic accounts. It checks PDF inline responses,
HTML/Markdown/binary downloads, unchanged image-only serving, sign-in/session permissions, realpath traversal
and symlink rejection, and private configuration protection. Its real Chromium check renders ordinary Markdown
links, activates a file link with Enter, and verifies the Markdown viewer, script-disabled HTML preview and PDF
open action. Web URLs, anchors and application routes retain their addresses; supplied `data-path` marks are removed.
Browser checks skip explicitly when Chromium is unavailable. `npm run test:kernel:ui` also reads a delivered upload
through an actual native session, proving the download route is admitted without a model call. PDF byte delivery does
not establish rendering in every browser's PDF viewer. HTML downloads do not run in the application's origin.

## Acceptance boundaries

- Type checking and automated tests do not establish real-account authorization, provider approval, complete billing or target-device readiness.
- Native acceptance must cover individual credential routing, history handoff, fork, compaction, app permissions, persistence and safe recovery.
- Unknown inference, tool and refresh outcomes remain unknown. Do not replay them or substitute a zero-cost result.
- Installation, restart, backup, restore and rollback must be verified on the authorized target. Restore excludes refresh grants and does not undo remote side effects.
- Keep account identities, request/session records, SSH addresses, device names and private operational logs outside Git.

See [NATIVE-DELIVERY.md](NATIVE-DELIVERY.md) for R1–R8, [NATIVE-RECOVERY.md](NATIVE-RECOVERY.md) for recovery rules, and [PROVIDER-POLICY.md](PROVIDER-POLICY.md) for provider and distribution constraints.

## Native tree selector

`node --test test/native-tree.test.ts` compares browser row text/order/connectors against the pinned
rotom 0.1.21 `TreeSelectorComponent` for all five filters, search and folding. This is a native-output
comparison, not a snapshot generated by the browser implementation. Removing the tool-only-message
filter makes both checks fail.

`node test/native-commands-proof.ts --ui` additionally checks search, empty results, Escape-to-clear,
arrow selection and Enter-to-navigate through the actual browser, while preserving cancellation,
editable drafts, explicit summary billing and immutable audit history. It captures the tree after its
opening animation at desktop and 390px phone-emulated widths; checks horizontal containment, visible
summary controls, selection after resizing, 44px touch rows and a 16px mobile search field. These are
Chromium checks, not real-device/iOS-keyboard verification.

The reference is the user's terminal Session Tree screenshot and the pinned native selector source:
compact role-colored rows, branch connectors, active-path dots, tool-call summaries rather than raw tool
results, and keyboard navigation. Team's generic full-width button list was not a tree representation.
The port keeps native execution behind Team's existing authorization and receipt path; it is not a PTY
or generic TUI bridge. Personal design-library searches had stale old-machine source paths; no personal
component was imported. Visual acceptance remains pending.

Current limits: default terminal shortcuts only (browser/OS-reserved keys may intercept them; filter
buttons remain available); no label editing or full-entry copy shortcut; message search follows the
native 200-character excerpt rather than full transcript search. Long rows clip to the viewport; native
automatic horizontal panning for deeply nested branches is not ported. If clipping hides the selected
entry's identity in real branched histories, add selected-anchor panning with a deep-tree browser fixture.
All rows are rendered; no large-history virtualization claim is made. Other slash dialogs and TUI-only
extensions are unchanged. Recheck native parity when updating the runtime pin.

## Native command adapters and Goal

```sh
node --test test/rotom-commands.test.ts test/rotom-rpc.test.ts
node test/native-commands-proof.ts --ui
node test/rotom-goal-proof.ts
npm run test:kernel:ui
```

These scripts use the actual pinned runtime, isolated member HOMEs, loopback model/OAuth fixtures and Chromium.
`native-commands-proof` writes `native-commands/report.json` and screenshots under its printed temporary data root.
It checks first-session discovery without inference; retained snapshots beyond 30 seconds and after restart without native startup; owner-only shared settings; viewer/other-member catalog privacy; model A→B and later payer/model
requests; confirmed names before the first conversation and across handoff; native branch JSONL/HTML export; positive
owner-private reasoning before cross-member clone/import filtering; earlier SECOND-entry fork/tree with THIRD absent
from the new branch and later inference; request replay/conflicts; native settings and slash compaction with persisted summary/usage; and explicit share/bug rejection
without starting native operations. Personal Qoder API fixtures assert credential ownership and private result delivery;
they are not real-account billing evidence.

The browser proof chooses native entry IDs, restores fork/tree drafts without submitting them, invokes an authorized
native branch summary and checks persisted usage, preserves a draft on actual native extension cancellation, and checks
custom-message text extraction. HTTP coverage also checks native no-op navigation. Native RPC exposes cancellation but
not its reason; summary-abort reason discrimination is not verified or claimed. Audit transcript records remain visible
while native branch checks exclude the abandoned user entries.

A fixture appends a real native effect and then throws. The command remains `unknown`; restart and same-request retry
add neither inference nor native bytes. The separate Team proof retains ordinary prompt clean-stop/crash continuation
checks and asserts that native skill expansion receipts remain `prompt`, not non-recoverable extension handlers.

The browser sends 20 native status/widget updates and verifies one keyed slot per key, followed by removal while the
handler is still live. Goal waiting controls remain usable without a status-toast pile-up; plain composer input wakes
the same workflow. The low-level Goal proof verifies a real timer wake, Stop with unknown outcome, pause, explicit wake and queued native skill expansion/wake, retaining one receipt/member. These are distinct from merely receiving a command acknowledgement.

No real account, external sharing upload, deployment, target-device/mobile layout, financial reconciliation or arbitrary
third-party extension is accepted by these fixtures. Run the commands on the final artifact; older logs are not evidence
for a later edit.
