# Native command comparison: 45 terminal entries

This is a comparison and evidence ledger, **not a claim that all 45 interactions pass**. The pin is rotom 0.1.21.
An isolated terminal inventory supplies 24 builtin, 15 extension and 6 skill name/source pairs. Team's empty dedicated
profile supplies 39 native entries; 37 remain allowed catalog entries after the two explicit exclusions (not 37 working interactions). No personal settings,
telemetry, credentials or skill assets are copied to manufacture this count.

`node test/native-command-inventory.ts <attested-terminal-inventory.json>` asserts every name/source pair, compares actual
pinned Team discovery and writes all 45 rows with source files to a temporary report. It makes no inference. A registration
match or `handled` disposition is not an effect, interaction or financial verification.

Source abbreviations are relative to `runtime/rotom/node_modules/@bingjiang0611/rotom`:

- **B**: `runtime/pi/node_modules/@earendil-works/pi-coding-agent/dist/core/slash-commands.js`; native terminal handlers in
  `dist/modes/interactive/interactive-mode.js`. Team permission/session mediation is in `src/server/team-kernel.ts`.
- **S**: `extensions/third-party/node_modules/pi-subagents/src/slash/slash-commands.ts`.
- **C**: `extensions/third-party/node_modules/@injaneity/pi-computer-use/extensions/computer-use.ts`.
- **G**: `extensions/third-party/node_modules/@narumitw/pi-goal/src/command-registration.ts`.
- **Q**: `extensions/qoder/index.ts` and its command registration modules.
- **L/M**: `runtime/pi/node_modules/@earendil-works/pi-coding-agent/dist/extensions/llama/index.js` / `extensions/mcp/index.js`.
- **Context**: public package `pi-context-view@0.6.0`, `src/index.ts`, `src/ui/usage-view.ts`, `src/ui/injections-view.ts` (MIT).

| Command                 | Source                              | Interaction / current evidence and limit                                                                                                                                 |
| ----------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/settings`             | B                                   | Owner-managed native SettingsManager; browser settings→later native startup proof. Non-owner editing is denied.                                                          |
| `/model`                | B                                   | Member model picker→immutable handoff→later inference on chosen model/payer; native/browser proof.                                                                       |
| `/tree`                 | B                                   | Selected native ID, editable draft, cancellation/no-op, optional billed native summary; branch and browser proof. Cancellation reason is unavailable through pinned RPC. |
| `/thinking`             | B                                   | Native model-compatible thinking via immutable Team handoff; later state proof.                                                                                          |
| `/scoped-models`        | B                                   | Owner shared native patterns; member cycles only their own available models through a handoff. Browser proof.                                                            |
| `/export`               | B                                   | Member-private native JSONL current branch / native HTML; bytes and foreign-member denial proof.                                                                         |
| `/import`               | B                                   | Native parsing and Team public-history seed in a new conversation; privacy and continuation proof.                                                                       |
| `/share`                | B                                   | Explicit exclusion; manual submit rejected before startup/inference/upload.                                                                                              |
| `/bug`                  | B                                   | Explicit exclusion; manual submit rejected before startup/inference/upload.                                                                                              |
| `/copy`                 | B                                   | Native last assistant text and browser clipboard adapter. Clipboard behavior is not native terminal clipboard transport.                                                 |
| `/name`                 | B                                   | Native set/readback, Team persistence before first JSONL and across handoff; browser/native proof.                                                                       |
| `/session`              | B                                   | Native state/statistics result, including later bound model/thinking; HTTP/native proof.                                                                                 |
| `/changelog`            | B                                   | Pinned Rotom version/package/update guidance, matching native Rotom-specific handler (not upstream Pi changelog). Individual browser invocation not separately attested. |
| `/hotkeys`              | B                                   | Web shortcut sheet, not a claim that native terminal keybindings work in the browser. Individual invocation not separately attested.                                     |
| `/fork`                 | B                                   | Earlier selected user ID→Team-safe seed before entry→editable draft; later inference excludes abandoned text. Not native forkSession identity switching.                 |
| `/clone`                | B                                   | Native same-member branch clone; foreign member gets public history only; continuation proof.                                                                            |
| `/trust`                | B                                   | Native trust choices; startup already trusts the configured workspace. Native project loading and reload are covered by the resource proof.                              |
| `/login`                | B                                   | Personal provider sheet/security mediation; no real login performed by this work. Provider argument-specific parity is not separately attested.                          |
| `/logout`               | B                                   | Personal provider sheet/security mediation; account lifecycle tests are separate from arbitrary native terminal UI parity.                                               |
| `/new`                  | B                                   | Separate Team/native conversation; no receipt identity mutation; native proof.                                                                                           |
| `/compact`              | B                                   | Actual native compaction; persisted summary, aggregate split-turn usage and no duplicate retry; native proof.                                                            |
| `/resume`               | B                                   | Visible Team conversation selector; does not expose private native session trees. Native proof.                                                                          |
| `/reload`               | B                                   | Native resource reload; shared discovery and new unknown command installation proof.                                                                                     |
| `/quit`                 | B                                   | Stop/leave Team view, not terminate the shared server. Goal Stop is independently tested; individual slash invocation is not separately attested.                        |
| `/trace`                | `extensions/observability/index.ts` | Actual native notification observed with observability disabled; not a claim that a trace upload occurred.                                                               |
| `/browser`              | `extensions/browser/index.ts`       | Actual native `status` result observed. Installation and destructive browser actions are not run for coverage.                                                           |
| `/computer-use`         | C                                   | Actual config notification; native project values take precedence over shared configuration. No desktop action is needed for this check.                                 |
| `/subagent-cost`        | S                                   | Actual native report/message observed. Empty synthetic history is not real-account cost reconciliation.                                                                  |
| `/subagents-doctor`     | S                                   | Actual native diagnostic message observed; not a proof that every reported capability is usable.                                                                         |
| `/subagents-guide`      | S                                   | Actual packaged native guide message observed.                                                                                                                           |
| `/subagents-detach`     | S                                   | Native empty-input/empty-task response observed; successful detachment of a live child is not individually attested here.                                                |
| `/subagents-stop`       | S                                   | Native empty-task response observed; actual child closure is covered separately by the kernel proof, not inferred from this acknowledgement.                             |
| `/subagents-models`     | S                                   | Native builtin-model report observed. Shared/project/package roles load; member customization remains rejected in resource proofs.                                       |
| `/goal`                 | G                                   | Actual timers, pause, Stop/unknown, plain and skill wake under one receipt/member; native and browser proofs.                                                            |
| `/qoder-models`         | Q                                   | Private member provider API/catalog mediation with synthetic accounts; no broker HOME credential or room result broadcast.                                               |
| `/qoder-credits`        | Q                                   | Private member quota API fixture; not per-request debit, billing or real-account evidence.                                                                               |
| `/context`              | Context                             | Not installed into the initial shared profile. Native handler refuses RPC except `config`; arbitrary custom-UI parity is blocked, not an implicit product exclusion.     |
| `/llama`                | L                                   | Registered but native handler refuses RPC before UI. A TUI-only warning plus handled response is not functional parity.                                                  |
| `/mcp`                  | M                                   | Shared definitions, member-private native OAuth, browserless callback mediation; HTTP/browser/native isolation proof.                                                    |
| `/skill:pi-subagents`   | `skills/pi-subagents/SKILL.md`      | Bundled native skill expansion. Suggestion only fills draft; explicit submit/queued skill wake proof. User-script workflows remain unsupported.                          |
| `/skill:design-loop`    | Terminal skill metadata only        | Deliberately uninstalled by user choice. Personal memory, component collections and history are not imported.                                                            |
| `/skill:dws`            | Terminal skill metadata only        | Deliberately uninstalled by user choice. No DingTalk action executed.                                                                                                    |
| `/skill:mobile-use`     | Terminal skill metadata only        | Deliberately uninstalled by user choice. Private device/setup lessons stay private; no device operation executed.                                                        |
| `/skill:ponytail-audit` | Terminal skill metadata only        | Deliberately uninstalled by user choice; no replacement skill is fabricated.                                                                                             |
| `/skill:yao-meta-skill` | Terminal skill metadata only        | Deliberately uninstalled by user choice; referenced personal assets are not copied.                                                                                      |

## Generic extension proof, not a command-name switch

`test/team-resources-proof.ts` installs previously unknown names into a temporary shared profile. The actual native
handlers receive exact arguments, select/input/confirm responses and keyed status/widget calls. It checks persisted
native effects, shared/project context, project skill retention, native reload, an installed later command and restart
into a new session. An awaited asynchronous follow-up reaches the synthetic provider under the original receipt/payer.
A handler appends a real effect and throws; restart/retry adds no inference or file bytes. Its unknown session refuses a
new dispatch. No Team handler implementation names those fixture commands.

This does not prove unannounced fire-and-forget timers after a handler has returned. The pinned extension API exposes no
generic lifetime/completion contract for arbitrary background work; the native Goal protocol has its own lifecycle proof.

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

The project/member subagent-source bypass is now guarded separately from core trust, including native live tool calls and
child CLI aliases/canonical paths. Frozen project snapshots keep their old bytes while using the current shared base.
Configuration removal preserves unknown data; dependency freshness does not recursively scan links. Locked shared npm cache
is explicitly excluded from backup and must be reinstalled after restore; see CONFIGURATION.md. These are tested Team
contracts, not claims about every arbitrary plugin's undeclared state or a filesystem sandbox.

Remaining capability gaps are separate from the two explicit exclusions: five personal skills are deliberately uninstalled by user choice (no automatic import); `/context` custom views and `/llama` TUI actions have no production browser transport;
not every live/error branch of all 45 entries is individually exercised. Real provider accounts, device automation and financial
reconciliation are not attested. `/share` and `/bug` alone are intentionally excluded.

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

Workflow support still needs a supported native RPC drain bridge. In 0.1.21, RPC has UI and skips the native headless
auto-drain; agent settlement does not prove workflow-controller closure. Native refinement generation uses a standalone
foreground reviewer that owned scope rejects. Existing overlays are supported; generation is not.

This is not a filesystem sandbox or proof against concurrent resource replacement. Native background-work identities
have a 256-character limit; long fixture/session paths are not repaired by rewriting histories.
