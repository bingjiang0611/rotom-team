# Supported native commands

Team discovers commands from rotom 0.1.25 and admits native extensions, skills and prompt templates by default. There
is no fixed extension allowlist. Terminal-only builtins that control credentials, trust, session lifecycle, external
uploads or an unsupported TUI remain protected: `scoped-models, export, import, share, bug, changelog, hotkeys, trust,
login, logout, new, resume, quit`. Team's separate account, export and session APIs remain available.

`team-command-policy.ts` still resolves native name precedence, protects those names and routes Web adapters. Submit
and queue recheck the live native registry before dispatch; an unknown command cannot become model input. A newly
registered trusted extension may replace a cached same-name template and execute under the same payer/receipt gate.
Internal `team-kernel-*` commands are never public. Catalog presence is not proof that a plugin's custom terminal UI
works in Web mode; native warnings/errors are shown rather than hiding all unadapted extensions.

## Interaction contract

| Command                      | Web behavior                                                                                                                        | Boundary / limit                                                                                                                                                                                                                                                                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/settings`                  | Search, arrows and Enter/left/right cycle execution settings. Model scope remains reachable inside the sheet.                       | Only the owner writes shared settings while accounts are idle. Retry/compaction show inherited native values read-only. Terminal theme, keybindings and transport controls are not copied into a shared service.                                                                                                                        |
| `/model`                     | Personal model picker; the paying member switches in place in the same native session, another member hands off.                    | A running/unknown lease blocks changes.                                                                                                                                                                                                                                                                                                 |
| `/thinking`                  | Dedicated searchable picker, current-level mark, arrows/Enter. Explicit arguments are case-normalized.                              | Levels come from the requesting member's model, not the shared room projection. Applying still uses the existing personal-account configuration gate.                                                                                                                                                                                   |
| `/tree`                      | Native tree nodes, filters, search, keyboard/touch navigation, cancellation, editable drafts and optional summary.                  | Shared transcript remains immutable audit history; native cancellation reason is not available over RPC. See VERIFICATION.md for bounded UI omissions.                                                                                                                                                                                  |
| `/fork`                      | Terminal order and latest-message selection, wraparound arrows, Enter. Textless/image-only user entries are omitted as native does. | Copy preceding history into a new Team session; restore the selected text as a draft, never auto-submit. Labels show a 160-character excerpt.                                                                                                                                                                                           |
| `/clone`                     | Copy the selected native branch into an independent Team session.                                                                   | Same-member private history stays private; another member receives only public history.                                                                                                                                                                                                                                                 |
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
