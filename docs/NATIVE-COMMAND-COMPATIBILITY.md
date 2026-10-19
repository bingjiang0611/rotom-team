# Supported native commands

Team discovers commands from rotom 0.1.25 and admits native extensions, skills and prompt templates by default. There
is no fixed extension allowlist. Terminal-only builtins that control credentials, trust, session lifecycle, external
uploads or an unsupported TUI remain protected: `scoped-models, export, import, share, bug, changelog, hotkeys, trust,
login, logout, new, resume, quit`. Team's separate account, export and session APIs remain available.

`team-command-policy.ts` still resolves native name precedence, protects those names and routes Web adapters. Submit
and queue recheck the live native registry before dispatch; an unknown command cannot become model input. A newly
registered trusted extension may replace a cached same-name template and execute under the same payer/receipt gate.
Internal `team-kernel-*` commands are never public. Catalog presence is not proof that a plugin's custom terminal UI
works in Web mode. The catalog now includes Web capability/argument guidance: known terminal-only entries remain
visible but disabled; unknown trusted extensions are marked unverified, not silently dropped or declared compatible.
`/llama` is rejected before dispatch instead of returning a misleading handled warning. Cached known-invalid inputs
are refused before native startup; live admission rechecks the source and arguments for idle **and queued** commands.

## Interaction contract

| Command                      | Web behavior                                                                                                                        | Boundary / limit                                                                                                                                                                                                                                                                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/settings`                  | Search, arrows and Enter/left/right cycle execution settings. Model scope remains reachable inside the sheet.                       | Only the owner writes shared settings while accounts are idle. Retry/compaction show inherited native values read-only. Terminal theme, keybindings and transport controls are not copied into a shared service.                                                                                                                        |
| `/model`                     | Personal model picker; the paying member switches in place in the same native session, another member hands off.                    | A running/unknown lease blocks changes.                                                                                                                                                                                                                                                                                                 |
| `/thinking`                  | Dedicated searchable picker, current-level mark, arrows/Enter. Explicit arguments are case-normalized.                              | Levels come from the requesting member's model, not the shared room projection. Applying still uses the existing personal-account configuration gate.                                                                                                                                                                                   |
| `/tree`                      | Native tree nodes, filters, search, keyboard/touch navigation, cancellation, editable drafts and optional summary.                  | Shared transcript remains immutable audit history; native cancellation reason is not available over RPC. See VERIFICATION.md for bounded UI omissions.                                                                                                                                                                                  |
| `/fork`                      | Terminal order and latest-message selection, wraparound arrows, Enter. Textless/image-only user entries are omitted as native does. | Copy preceding history into a new Team session; restore the selected text as a draft, never auto-submit. Labels show a 160-character excerpt.                                                                                                                                                                                           |
| `/clone`                     | Copy the selected native branch into an independent Team session.                                                                   | Same-member private history stays private; another member receives only public history. The copy keeps the visible source title with `· Copy`; both sessions use the same project folder, not copied files.                                                                                                                             |
| `/compact`                   | Actual native compaction with optional instructions and completion feedback.                                                        | Uses the fixed payer, records native summary/usage, and does not repeat a completed or unknown request.                                                                                                                                                                                                                                 |
| `/reload`                    | Native resource reload and confirmed completion notice.                                                                             | Does not restart the shared service or install dependencies.                                                                                                                                                                                                                                                                            |
| `/goal`                      | Bare command opens a Web Goal manager: start/budget, edit/replace, pause/resume, status, confirmed clear and help.                  | Native RPC's bare command is status-only. This is an explicit web adapter, not `ctx.ui.custom`. The safety-settings editor is unavailable; use native `clear`/`stop`, not unsupported `cancel`. Start/resume retain the native account/receipt lifecycle.                                                                               |
| `/browser`                   | Real native input/confirm/notify handler. Empty Enter cancels input; Escape dismisses.                                              | Operates on the **Team service machine**, not the viewer's browser. A task may invoke the selected model. Tests do not install a relay or automate a real browser.                                                                                                                                                                      |
| `/computer-use`              | Native configuration report.                                                                                                        | It is not an interactive desktop launcher. No real desktop action is claimed.                                                                                                                                                                                                                                                           |
| `/mcp`                       | Existing native definition/auth mediation and browserless personal OAuth.                                                           | Shared/project definitions do not share member tokens; MCP-only sign-in does not load Agent extensions.                                                                                                                                                                                                                                 |
| `/context`                   | Web usage and injection-source views with expandable native token breakdowns; `/context usage` and `/context injections`.           | Uses pinned `pi-context-view` capture, projection and measurement code. No paid or silent probe, no TUI emulation. Only labels/counts reach HTTP or persisted result readback; raw prompts/messages remain process-local. `/context config` is refused: configuration belongs to the shared owner profile. Busy runs must finish first. |
| `/name`, `/session`, `/copy` | Native session-name, session-statistics and clipboard adapters.                                                                     | Existing payer gate and session ownership checks still apply; clipboard writes are explicit browser actions.                                                                                                                                                                                                                            |
| `/qoder-models`              | Refresh and return the requesting member's native Qoder catalog.                                                                    | Runs in the credential-owning parent; results are private HTTP data, not shared room broadcasts.                                                                                                                                                                                                                                        |
| `/qoder-credits`             | Readable timestamp and pool balances instead of raw JSON. Missing/unreported values stay unknown.                                   | Credential-owning parent queries only the requesting member; results are private HTTP data, not room broadcasts or per-request financial cost.                                                                                                                                                                                          |

Tab and partial-name Enter complete the composer without executing. A second Enter on the complete command executes.
Clicking an argumentless command still opens/runs it; skill/template selection only fills the draft.

## Dynamic command audit: rotom 0.1.25

This is a capability review of **registrations**, not a list of every installed handler or a promise that external
operations completed. The observed service catalog had 32 entries: 11 public builtins, the 15 extensions below, and
six skill expansions (`pi-subagents`, `changelog`, `kami`, `claude-api`, `dataworks-odps-query`, `rate-runtime-verify`).
Skills/templates use native text expansion and can invoke inference/tools; their CLI, mobile, SQL, vendor and external
access are environment-dependent and were not exercised. The shared/project resource set is not frozen by this audit.
The isolated proof independently discovers all 15 shipped extensions. Additional trusted extensions remain discoverable
with an unverified label, without adding a second registration allowlist.

| Dynamic extension  | Web/argument boundary                                                                                                                                                                                                                                                             | Evidence in this change                                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `llama`            | All arguments hit the pinned TUI-only guard. Visible as Terminal only, disabled, rejected server-side.                                                                                                                                                                            | HTTP bare/download rejection starts no process, receipt or model call; UI retains draft.                                  |
| `mcp`              | Bare opens Team's personal sign-in manager; login/logout use the existing private OAuth bridge. Native reconnect is retained. Other verbs/extra positional arguments are explicitly rejected. Owner-managed server definitions, enable/disable and exposure are not Web controls. | Invalid verbs/arity rejected without effects; existing synthetic OAuth proof covers auth. No real MCP connection claimed. |
| `browser`          | Service machine, not the client device. Only exact `status`/`install` are controls; any other text is a model task. Install confirms before changing the service user's integration.                                                                                              | Status handler and cancelable task input exercised. No installation or real browser task performed.                       |
| `computer-use`     | Configuration report, not a desktop action. Arguments ignored.                                                                                                                                                                                                                    | Native report handler, zero inference.                                                                                    |
| `context`          | Bare/usage/injections have a Web adapter. Config is owner-profile managed and refused.                                                                                                                                                                                            | Native measurement, HTTP/UI views, config rejection, zero inference.                                                      |
| `goal`             | Bare uses the Web manager; status/pause/resume/clear/edit/start use native grammar. Start/resume can infer. Safety-settings TUI is unavailable.                                                                                                                                   | Existing synthetic start/pause/edit/resume/clear and unknown/restart fixtures.                                            |
| `trace`            | Trace metadata/status, not private trace contents. Arguments ignored.                                                                                                                                                                                                             | Native report handler, zero inference.                                                                                    |
| `qoder-models`     | Personal catalog query; arguments ignored.                                                                                                                                                                                                                                        | Synthetic parent-owned account bridge, private response, no room broadcast.                                               |
| `qoder-credits`    | Personal provider quota snapshot; arguments ignored. Unknown is not zero or a bill.                                                                                                                                                                                               | Synthetic private bridge and missing-value assertions.                                                                    |
| `subagent-cost`    | Recorded usage report, not a financial reconciliation; arguments ignored.                                                                                                                                                                                                         | Native report handler, zero inference.                                                                                    |
| `subagents-doctor` | Setup diagnostics, not task execution or proof of provider access.                                                                                                                                                                                                                | Native report handler, zero inference.                                                                                    |
| `subagents-guide`  | Optional topic, text help only.                                                                                                                                                                                                                                                   | Native help handler, zero inference.                                                                                      |
| `subagents-models` | Optional agent, role-default report; not a payer/session model switch.                                                                                                                                                                                                            | Native report handler, zero inference.                                                                                    |
| `subagents-stop`   | Explicit session-owned run ID required. No bare terminal selector. Stop-request acceptance is not child closure.                                                                                                                                                                  | Bare request rejected without effects; IDs continue through native ownership checks.                                      |
| `subagents-detach` | Optional ID; only an existing foreground single run can detach. Owned Team work is normally async, so no-active/non-detachable warnings are expected.                                                                                                                             | Native no-active handler, zero inference; no promise of daemonization.                                                    |

The six observed skills are text expansion commands, not six additional native RPC UI handlers. Their source and
prerequisite boundaries were reviewed, not their complete business procedures or every referenced guide:

| Skill                  | Registration source | External/interaction limit                                                                                                                                                 |
| ---------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pi-subagents`         | Pinned product      | Team's owned async subset; workflow/refinement claims in the upstream guide are not newly enabled.                                                                         |
| `changelog`            | Workspace ancestor  | Local Git/Python generation; publishing needs explicit confirmation and separately configured author credentials. No upload performed.                                     |
| `kami`                 | Workspace ancestor  | Service-side Python/templates/rendering/fonts; a non-blocking daily update check can read GitHub and write a local marker. The user's browser is not a local PDF renderer. |
| `claude-api`           | Shared Team profile | Reference instructions; model/SDK calls still require explicit tasks and the member's configured access. No API calls performed.                                           |
| `dataworks-odps-query` | Shared Team profile | Requires authenticated browser/authorized read-only access and cost/permission checks; text expansion does not prove database connectivity. No SQL submitted.              |
| `rate-runtime-verify`  | Shared Team profile | Requires Aone/Mobius/AIO access, device leases and individually confirmed temporary routing. No device task or routing mutation performed.                                 |

The installed subagent package's other registrations are suppressed by its pinned product policy **before** discovery.
They are not missing Web menu entries: `/subagents`, `/run`, profile management, RPC inspector, fleet, refine and prompt
workflow commands are not exposed by that composition root. `skill:pi-subagents` also warns that Team's owned async
subset does not support programmable workflows or refinement generation. A command's `handled` status means that its
handler was recognized/returned, not that a model downloaded, a browser task completed, an MCP server connected or a
child process closed. Extension exceptions and lost replies retain the existing unknown/no-replay fences.

## Evidence and inventory

- `node test/native-commands-proof.ts --ui`: actual pinned runtime, synthetic personal accounts, loopback inference,
  real browser interaction. Checks default native-command admission, protected builtins, context usage/injections,
  owner settings, personal thinking/model, fork/tree, compaction, reload, Goal, private account output, native browser
  input and unknown/no-replay fences.
- Error-command fixtures exercise the trusted executor's effect/unknown fence; dynamically discovered fixture names
  now follow the same default extension admission. UI slot/tree fixtures use native input hooks on test messages.
- `node --test test/team-command-policy.test.ts test/native-tree.test.ts`: surface/name-precedence/routing checks
  and direct pinned terminal tree comparison.
- `node test/native-command-inventory.ts <attested-terminal-inventory.json>` compares all 45 supplied terminal
  name/source pairs from the 0.1.22 attestation. The empty shared profile on 0.1.25 has 40 raw native entries because
  `/context` is now packaged; **27** remain public after protecting thirteen terminal builtins. Registration/handled
  is not proof of behavioral or financial equivalence.
- `test/team-resources-proof.ts` exercises native RPC/executor resource loading, arbitrary trusted extension handlers,
  native dialogs, reload and follow-up. Trusted extension names are admitted after live discovery.

Five personal skills remain deliberately uninstalled by user choice. No personal settings, credentials or skill assets
are copied to manufacture parity. `/llama` and subagent diagnostics are discoverable; arbitrary custom UI still needs
native RPC support or an explicit Web adapter. `/llama` currently warns that it requires TUI mode.

## TUI feasibility (outside this delivery scope)

`node test/native-tui-prototype.ts` uses the verified product CLI and an OS PTY. A fixture's actual native `ctx.ui.custom`
component consumes a real `x` key and persists its result. Another native handler appends an effect and throws. The test
keeps an isolated member/session, a reserved command receipt and a deny-only synthetic gate; it settles that receipt as
**unknown**, not handled. A marker written by a fixture proves that fixture only.

Pinned RPC `modes/rpc/rpc-mode.js:152` returns undefined for `custom()`. `pi-context-view/src/index.ts` refuses non-TUI mode
before its views. `extensions/llama/index.js:166` has the same mode guard. Public `ExtensionAPI.getCommands()` supplies
metadata, not handlers or completion callbacks (`core/extensions/types.d.ts:1271`). Native command exceptions go through
`AgentSession._tryExecuteExtensionCommand` to runner error listeners (`core/agent-session.js:1655–1677`); interactive mode
consumes them into terminal rendering (`modes/interactive/interactive-mode.js:1624`). There is no verified public external
TUI command-completion/error observation seam. Interactive initial commands can execute sequentially, but a private barrier
also follows caught handler errors: it is not proof of business success. Raw root-editor input could bypass Team model/session,
MCP and private Qoder mediation. `ui_prompt_start/end` or terminal-input hooks are not yet a verified complete transport and
closure contract. Exit status, terminal text and timeouts cannot replace that evidence.

No production terminal backend, ANSI emulator, ctx.mode spoof, dependency monkeypatch or alternate Agent loop is included.
The production TUI bridge remains outside this delivery scope. `/context` now uses a separate structured Web adapter;
this PTY prototype does not implement that adapter or make `/llama`'s terminal manager work in Team.

## Resource and delivery limits

Trusted project resources follow native precedence; declared member resource mirrors remain derived from the shared
profile. Native owned-scope rules still govern children. Frozen project snapshots keep their old bytes while using the shared base.
Configuration removal preserves unknown data; dependency freshness does not recursively scan links. Locked shared npm cache
is explicitly excluded from backup and must be reinstalled after restore; see CONFIGURATION.md. These are tested Team
contracts, not claims about every arbitrary plugin's undeclared state or a filesystem sandbox.

Default native command admission does not promise every terminal setting or arbitrary custom UI. Real provider
accounts, device automation and financial reconciliation are not attested. Protected native operations and new Web
adapters still require explicit interaction/permission evidence, not a catalog-only change.

### Subagent limits in the verified subset

Native parent/project skills and the asynchronous structured single-child path remain supported. The native kernel may
internally normalize that single-child request into a workflow; that is **not** user-supplied programmable-workflow coverage.
The user explicitly chose this verified subset. User-provided `workflowScript` is rejected before execution: the pinned owned
scope refuses synchronous workflow controllers, and asynchronous workflow result delivery/lifetime is not bridged. No script
is silently rewritten, no native ownership protection is disabled, and no script completion is inferred from status files.

Optional native named-skill injection, user/project memory and existing project refinement overlays are enabled.
Native injection resolves sources; Team no longer assumes every owned child has an asynchronous recovery descriptor.
User memory is member-private, project memory is shared, and neither is copied into the shared base profile.
Named skills advertise descriptions/locations; the fixture verifies an actual child read, not just prompt metadata.

Workflow support still needs a supported native RPC drain bridge. In 0.1.25, RPC has UI and skips the native headless
auto-drain; agent settlement does not prove workflow-controller closure. Native refinement generation uses a standalone
foreground reviewer that owned scope rejects. Existing overlays are supported; generation is not.

This is not a filesystem sandbox or proof against concurrent resource replacement. Native background-work identities
have a 256-character limit; long fixture/session paths are not repaired by rewriting histories.
