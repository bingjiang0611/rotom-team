# UX audit follow-up — local repair

## Scope and feedback authority

The user selected audit findings **2, 3, 5, 6**, and expanded **4 to all dynamic commands**. This authorizes localized
implementation, not a new visual system, onboarding redesign, deployment, or real external installations/account calls.
Base: `45d45275c4fec52c44561443cbb43f8666554c7d`; isolated branch/worktree: `ux-audit-followup` / `rotom-team-ux-followup`.
The original dirty checkout and deployed release are not implementation targets.

- Human outcome: find created files in the same place as artifacts; see the model actually selected for the native
  session; recognize a copied conversation by its source name; enter through consistently branded sign-in pages.
- Dynamic commands: distinguish discovery, Web capability and effects. Never call a guarded warning "successful model
  management", imply a service-machine browser is the member's phone, or hide unknown trusted extensions by allowlist.
- Keep model/payer isolation, immutable receipts, unknown/no-replay fences, native name precedence, public-history
  privacy and existing file authorization. No legacy extension enabling, directory scanning or inferred shell paths.

## Baseline → reuse → repair

The existing Artifacts sheet only indexed separately published documents. Native Write delivery and authorized file
view/download already worked. Repair the entry point instead of inventing a second publication or filesystem index:
**Outputs → Files / Published artifacts**, using the existing `Sheet`, `list-item`, file viewer, download URL and project
files panel. Counts and paths derive from successful already-public transcript records. This is explicitly history,
including inherited/discarded history, not an active-branch manifest or saved file version. Missing/changed files resolve
through the existing endpoint. Browse project files covers shell-created and unindexed files. Copies share that folder.

Sidebar labels read native journal model state in one batch query, not one session lookup per row. Clones keep the
visible source name plus `· Copy`; forks use `· Fork`.
Imported source metadata remains auditable but no longer renames the new conversation. Identity/invite errors and the
share entry point say rotom team; internal/upstream identifiers and the agent's name are not mechanically renamed.

Command suggestions retain native descriptions and add short capability labels. The currently selected command gets
wrapped, readable argument/effect guidance. Terminal-only llama is visible but disabled and rejected server-side;
unsupported MCP verbs/extra positional arguments and bare subagent-stop are rejected before known effects and rechecked
against the live idle/queued registry. Unknown trusted commands remain visible as unverified. Skills/templates warn of
inference and service-machine prerequisites. Capability notes are not another source of registration or precedence.

## Research and reuse receipts

| Source / region inspected                                                                                          | Observation                                                                                                                         | Adopt / reject → action                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Project `web/sheets/viewers.js`, `file.js`, `files-panel.js`, `ui.js`                                              | Existing sheets and file permissions already solve viewing and navigation.                                                          | Adopt components and theme tokens. Reject legacy artifact extension enabling and duplicated file state.                         |
| Original deployed audit, file delivery and clone/model flows                                                       | Execution worked while entry points/projections misled the member.                                                                  | Repair projection and labels, not payer routing or execution identity.                                                          |
| W3C Forms Notifications tutorial, <https://www.w3.org/WAI/tutorials/forms/notifications/> (read during this audit) | Feedback should identify the problem and how to fix it rather than imply success.                                                   | Show terminal-only/required-argument guidance; retain rejected drafts and existing unknown fences. Not a WCAG compliance claim. |
| Pinned rotom 0.1.25 registration roots and product subagent policy                                                 | Installed handlers are not necessarily registered; TUI/custom UI and RPC differ.                                                    | Inventory real registrations, label partial/risky paths, preserve private Web adapters. No TUI-mode spoofing.                   |
| Personal library `rotom team` and interaction/component searches                                                   | Existing rotom design records, but no suitable portable file-output component. 42 unrelated stale old-machine source issues remain. | Reuse project components; do not import a demo theme, migrate unrelated pointers or claim whole-library health.                 |

Craft applied: existing theme tokens; readable wrapping for paths/hints; compact existing sheet hierarchy; no decorative
redesign. Work is a same-pattern repair, so no redundant A/B prototype selection or new component kit is needed.

## Verification and acceptance

- Pinned native HTTP proof: model/name/clone/restart/handoff, all 15 shipped extension metadata, eight read-only handlers,
  zero-inference rejection, current precedence and unknown/no-replay boundaries.
- Browser proof: disabled llama/draft, Outputs desktop and phone-width sheet, Chinese/space paths, failed-write exclusion,
  real authorized HTML file-view action; existing theme/context/Goal/tree/settings tests remain in the same run.
- Output screenshots are explicitly synthetic public-projection + filesystem fixtures; they do not prove a real model
  generated those files. The earlier deployed audit independently proved real Write delivery, but is not validation of
  this unshipped artifact.
- Actual viewed screenshots: `outputs-desktop.jpg`, `outputs-light.jpg`, `outputs-mobile.jpg`, `outputs-file-viewer.jpg`;
  wrapped paths and explanatory text fit the existing sheet, and the file action reaches Preview rather than executing automatically.
- Final checks: 445 tests pass; native command HTTP/UI and synthetic MCP OAuth proofs pass; static checks pass. The
  performance ledger guard and gating counters pass. A scalar model projection's introduced 39 list queries became
  one batch query; this is work-counter evidence, not a speed claim (`highLoad: true`, one run). The experiment and
  measured costs are in `docs/performance/experiments/2026-10-17-ux-model-projection.md`.
- Unit, HTTP and full-suite commands and limits are listed in `docs/VERIFICATION.md`. Generated test screenshots stay
  in the printed private temporary fixture directory, not in repository history.

**User visual acceptance is pending.** Browser fixtures are not a real-phone test. No browser installation, real MCP
connection, SQL/mobile/vendor workflow or real paid inference is claimed. No new global aesthetic preference is inferred
from this bug-fix selection. This record is the project-scoped feedback authority and can be registered as a searchable
project pointer; it is not a second approved/accepted status table.
