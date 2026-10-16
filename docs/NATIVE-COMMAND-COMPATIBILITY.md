# Supported native commands

Team exposes exactly these thirteen builtins/extensions from rotom 0.1.25:
`settings, model, thinking, tree, fork, clone, compact, reload, goal, browser, computer-use, mcp, qoder-credits`.
Installed skills and prompt templates remain available. This is **web alignment within Team boundaries**, not a PTY
frontend or a claim of complete terminal equivalence.

`team-command-policy.ts` applies the same surface to discovery and submit/queue admission. Native name precedence is
resolved before filtering; a template cannot expose a hidden same-name extension. Known excluded names are refused
before startup. Submit and queue also recheck the actual native registry before dispatch, so a stale template catalog
cannot authorize a newly registered extension. Trusted startup/reload may already have run in that case. Arbitrary
extension code and tools remain trusted native capabilities, not extra public slash entry points. Internal lifecycle/recovery operations and separate Team APIs are not removed.

## Interaction contract

| Command          | Web behavior                                                                                                                        | Boundary / limit                                                                                                                                                                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/settings`      | Search, arrows and Enter/left/right cycle execution settings. Model scope remains reachable inside the sheet.                       | Only the owner writes shared settings while accounts are idle. Retry/compaction show inherited native values read-only. Terminal theme, keybindings and transport controls are not copied into a shared service.                                          |
| `/model`         | Personal model picker; the paying member switches in place in the same native session, another member hands off.                    | A running/unknown lease blocks changes.                                                                                                                                                                                                                   |
| `/thinking`      | Dedicated searchable picker, current-level mark, arrows/Enter. Explicit arguments are case-normalized.                              | Levels come from the requesting member's model, not the shared room projection. Applying still uses the existing personal-account configuration gate.                                                                                                     |
| `/tree`          | Native tree nodes, filters, search, keyboard/touch navigation, cancellation, editable drafts and optional summary.                  | Shared transcript remains immutable audit history; native cancellation reason is not available over RPC. See VERIFICATION.md for bounded UI omissions.                                                                                                    |
| `/fork`          | Terminal order and latest-message selection, wraparound arrows, Enter. Textless/image-only user entries are omitted as native does. | Copy preceding history into a new Team session; restore the selected text as a draft, never auto-submit. Labels show a 160-character excerpt.                                                                                                             |
| `/clone`         | Copy the selected native branch into an independent Team session.                                                                   | Same-member private history stays private; another member receives only public history.                                                                                                                                                                   |
| `/compact`       | Actual native compaction with optional instructions and completion feedback.                                                        | Uses the fixed payer, records native summary/usage, and does not repeat a completed or unknown request.                                                                                                                                                   |
| `/reload`        | Native resource reload and confirmed completion notice.                                                                             | Does not restart the shared service or install dependencies.                                                                                                                                                                                              |
| `/goal`          | Bare command opens a Web Goal manager: start/budget, edit/replace, pause/resume, status, confirmed clear and help.                  | Native RPC's bare command is status-only. This is an explicit web adapter, not `ctx.ui.custom`. The safety-settings editor is unavailable; use native `clear`/`stop`, not unsupported `cancel`. Start/resume retain the native account/receipt lifecycle. |
| `/browser`       | Real native input/confirm/notify handler. Empty Enter cancels input; Escape dismisses.                                              | Operates on the **Team service machine**, not the viewer's browser. A task may invoke the selected model. Tests do not install a relay or automate a real browser.                                                                                        |
| `/computer-use`  | Native configuration report.                                                                                                        | It is not an interactive desktop launcher. No real desktop action is claimed.                                                                                                                                                                             |
| `/mcp`           | Existing native definition/auth mediation and browserless personal OAuth.                                                           | Shared/project definitions do not share member tokens; MCP-only sign-in does not load Agent extensions.                                                                                                                                                   |
| `/qoder-credits` | Readable timestamp and pool balances instead of raw JSON. Missing/unreported values stay unknown.                                   | Credential-owning parent queries only the requesting member; results are private HTTP data, not room broadcasts or per-request financial cost.                                                                                                            |

Tab and partial-name Enter complete the composer without executing. A second Enter on the complete command executes.
Clicking an argumentless command still opens/runs it; skill/template selection only fills the draft.

## Evidence and inventory

- `node test/native-commands-proof.ts --ui`: actual pinned runtime, synthetic personal accounts, loopback inference,
  real browser interaction. Checks thirteen-command HTTP/catalog admission, owner settings, personal thinking/model,
  fork/tree, native compaction, reload, Goal, private quota output, native browser input, and unknown/no-replay fences.
- Error-command fixtures deliberately call the trusted executor below HTTP admission. They prove its receipt fence,
  **not** that extra fixture commands are public. UI slot/tree fixtures use native input hooks on ordinary test messages.
- `node --test test/team-command-policy.test.ts test/native-tree.test.ts`: surface/name-precedence/routing checks
  and direct pinned terminal tree comparison.
- `node test/native-command-inventory.ts <attested-terminal-inventory.json>` compares all 45 supplied terminal
  name/source pairs from the 0.1.22 attestation. The empty shared profile on 0.1.25 has 40 raw native entries because
  `/context` is now packaged; **14** remain public: thirteen commands plus the packaged subagent skill. Registration/handled is not proof of behavioral or financial equivalence.
- `test/team-resources-proof.ts` exercises native RPC/executor resource loading, arbitrary trusted extension handlers,
  native dialogs, reload and follow-up below Team's public command admission. Those extra names are not exposed by Team.

Five personal skills remain deliberately uninstalled by user choice. No personal settings, credentials or skill assets
are copied to manufacture parity. All other builtins/extensions, including `/context`, `/llama`, `/share`, `/bug`,
`/name`, `/qoder-models` and subagent diagnostic slash commands, are outside the supported surface.

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
The production TUI bridge is explicitly outside this accepted delivery scope. This prototype does not claim that `/context` or `/llama` works in Team.

## Resource and delivery limits

Trusted project resources follow native precedence; declared member resource mirrors remain derived from the shared
profile. Native owned-scope rules still govern children. Frozen project snapshots keep their old bytes while using the shared base.
Configuration removal preserves unknown data; dependency freshness does not recursively scan links. Locked shared npm cache
is explicitly excluded from backup and must be reinstalled after restore; see CONFIGURATION.md. These are tested Team
contracts, not claims about every arbitrary plugin's undeclared state or a filesystem sandbox.

The thirteen-command surface does not promise every native terminal setting or arbitrary custom UI. Real provider accounts,
device automation and financial reconciliation are not attested. Expanding the command set or adding terminal-only settings
requires a new explicit contract and command-specific interaction/permission evidence, not a catalog-only change.

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
