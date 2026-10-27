# Native runtime, commands and credentials

Detailed contract sections from [CONFIGURATION.md](CONFIGURATION.md).

## Native pin and subagent defaults

The pin is rotom 0.1.26. Team does not override native retry, compaction or builtin role settings. An empty shared
profile uses native defaults: automatic retry enabled (3 retries, 2-second exponential base delay, 60-second maximum),
automatic compaction enabled (16,384 reserve tokens and approximately 20,000 recent tokens retained), and all five builtin
roles: scout, worker, reviewer, delegate and oracle (alias advisor for oracle). Compaction triggers when the
native context estimate exceeds the selected model's context window minus reserve tokens, and uses native overflow
recovery. Context windows come from model metadata, not a Team-wide limit. Shared `compaction.modelOverrides` and
`retry.provider` settings retain native precedence. Provider request retry options are forwarded unchanged; the pinned
OpenAI provider helper defaults to zero HTTP retries when no override is set. Agent-level retry is separate and defaults
to three. Automatic compaction usage and rotom's evidence-preserving reducer usage are journaled under the same prompt payer;
missing usage remains unknown. Unless an owner/shared or trusted project `sol-pi.json` explicitly selects otherwise,
Team writes native SoL-Pi configuration with rotom's feature defaults and the admitted provider/model. Shared
`sol-pi.json` is a managed configuration file. The reducer may run only on the admitted provider/model: an explicitly
selected foreign reducer is blocked and leaves the operation unknown rather than charging an unbound account. All inference, including
retry, compaction and reduction, still passes through the fixed payer/model gate. Unknown Team operations and
credential refreshes are not replayed. Existing managed role/recovery overrides are replaced from the shared profile on
the next startup; private/unclassified state is untouched. This is not an OS sandbox or a claim that a plugin cannot read
project files.

Optional child named skills, user/project memory and existing project refinement overlays use native injection.
User memory stays under the paying member's native agent directory and is never copied on handoff. Project memory is
shared by that project. Native read/write and size limits apply. Private routing is not secrecy after a model quotes
memory into a shared conversation, and is not an OS sandbox. The old Team recovery-descriptor injection gate is removed;
native owned admission and the fd-3 lifeline remain authoritative.

`workflowScript` remains blocked in Team RPC. Pinned native synchronous controllers and standalone foreground launches
are refused by owned scope. Native asynchronous controllers are supported natively, but the RPC UI skips the headless
auto-drain; `agent_settled` and `ctx.waitForIdle()` do not prove controller/child closure. The fixed pin exports no public
drain bridge. Enabling this requires a supported native drain request/response plus Team integration and closure tests,
not a new Team executor, status-file polling, or spoofing `hasUI`. Native refinement generation also uses an unsupported
foreground reviewer; this release enables existing overlays, not generation. See
[NATIVE-COMMAND-COMPATIBILITY.md](NATIVE-COMMAND-COMPATIBILITY.md).

## Native slash commands

Typing `/` uses pinned native metadata. Dynamic extensions, prompt templates and skills from native `get_commands`
are admitted by default; Team only protects terminal-only builtins for credentials, trust, uploads and session lifecycle,
plus private `team-kernel-*` commands. `GET /api/c/:id/prompts` reads a snapshot; it never starts native code. Opening slash suggestions through composer input, or choosing **Refresh shared agent commands on my account**, explicitly starts the trusted native runtime under the member's ordinary permissions, admission and lease. Discovery denies Team
inference and credential-refresh requests. It needs no paid prompt, but shared extension startup is still trusted executable
code, not a sandbox. An idle session owned by another member is first handed over using public history.

Snapshots belong to one member, segment and immutable binding. Another member never receives their HOME-derived
descriptions. Snapshots persist and do not disappear after 30 idle seconds. Freshness distinguishes undiscovered, live, last-known and configuration-changed. The bounded fingerprint reads declared configuration and immediate resource metadata, never npm dependency trees or
symlink targets. Linked/external code and nested file edits require explicit Refresh or `/reload`; this is a freshness hint,
not a complete content attestation. Settings/failure invalidation retains the last-known names; authorized startup/reload captures again. This is not a file-watching or freshness guarantee for arbitrary external resources: refresh after editing configuration. Catalog errors are visible. Failed discovery needs explicit review/refresh, not automatic retry after the cache TTL.
Unknown discovery blocks startup even with a new request ID; exact receipt readback starts no process. Known command-sheet
input does not race an automatic discovery. Dispatch validates the current native registry. Unknown names and private `team-kernel-*` commands do
not become model prompts. Native skills/templates are expanded by native APIs, including queued input. Selecting a
skill or prompt-template suggestion only fills the draft; submitting it starts the model request.
After the native registry admits that input as a skill/template, submit returns its active prompt receipt and the
composer clears the submitted draft without waiting for inference to finish. Side-effectful commands still wait for
their own result; cancellation/rejection/unknown does not clear the draft.

Team's fixed Web adapters remain `settings, model, thinking, tree, fork, clone, compact, reload`; Goal, context, account
commands and other native extensions use command-specific or native handlers after live discovery. The protected
terminal-only builtins are `scoped-models, export, import, share, bug, changelog, hotkeys, trust, login, logout, new,
resume, quit`. Resolving native name precedence before protection prevents a same-name template from bypassing a
protected builtin. The actual native registry is checked again immediately before idle or queued dispatch, including
when a retained process reloads resources or registers a new command. Separate Team APIs and internal lifecycle/recovery
operations are unchanged. Catalog entries also carry Web guidance, not another registry. `/llama` remains visible as
Terminal only but cannot execute in Web. MCP supports the personal sign-in manager and login/logout/reconnect syntax;
owner server-definition/enable/exposure commands and extra positional arguments are rejected. Bare `/subagents-stop`
requires an explicit run id. Unknown trusted extensions are labeled unverified; skills/templates explicitly warn about
inference and service-machine prerequisites. See the complete dynamic-command audit in the compatibility document.

`/context` and `/context usage` open a Web context-usage sheet; `/context injections` groups current request injections
by native/extension source. Both reuse pinned `pi-context-view` capture and measurement code, never make a paid/silent
probe, and return only labels/counts—not raw prompt, message or tool text. `/context config` is refused because plugin
configuration belongs to the owner-managed shared profile. Context commands are read-only receipts, idempotent by
request ID, and busy-gated rather than queued into a running prompt. The usage sheet follows the pinned terminal's
16×16 proportional map, category colors, token precision and window percentages. Tool Output opens its measured
per-tool breakdown by default. Auto-Compact Buffer is capped at remaining window space, and Free Space excludes it;
an unknown window stays unknown. Desktop map/legend columns stack on phones. Browser colors use the active Team
theme; terminal custom color/map-size overrides, Fit zoom and raw-content previews are not ported.

Tab and partial-name Enter fill the draft without executing. Complete-name Enter runs the command. Thinking and fork
have dedicated keyboard selectors; settings writes remain owner-only and busy-gated. Bare Goal opens a Web manager,
with native grammar, personal billing and no-replay fences intact. Its safety-settings editor remains unavailable.
The composer shows a separate current thinking control, including `off`. During a live prompt, only its paying member
with continue/driver permission may change thinking, through the picker or `/thinking <level>`. Native clamps the level;
the next model request uses it, not the response already streaming. The same process, payer, model, segment and initial
receipt binding remain unchanged. Native thinking history preserves the level after process retirement/restart; current
live readback takes precedence while the process is retained. A durable command-input fence prevents unknown writes
from being replayed or making the parent prompt eligible for automatic continuation. Startup, finalization, Stop and
unknown operations still refuse live changes. When idle, the paying member's own change stays in the same native
session and segment, so project hooks keep seeing one session id. A thinking-only change runs as the native `/thinking`
command receipt on the retained process. A model or account change of the same member is one `/model` command receipt:
its intent and the segment's current model commit together. A ready process is reused only within the same member,
account generation, provider and model API. The parent rotates the gate token and immutable model identity; native
re-registers the gated model catalog, applies `set_model`, records `model_change`, and reapplies the selected thinking
level. Completion requires native model readback, not an optimistic UI label. Old tokens and authorization crossing an
epoch change are denied. Cold processes, account/provider/API changes and kernel upgrades still take the startup path.

Full extension/resource reload is deferred until the next non-switch operation, under that operation's receipt and
before its work is dispatched. This refreshes startup-captured auxiliary models (including SoL-Pi); consecutive model
choices need only one reload. That next operation pays the reload latency. Reload failures remain unknown and retire
the process. Native reload prepares derived resources from the current gate model, never from a stale startup choice.
No browser click-to-paint, cold-start or cross-account sub-100-ms guarantee is claimed. The segment's
original binding stays the immutable identity anchor; each attempt keeps its own binding for response validation and
usage. A known rejection restores the previous model; an unknown outcome keeps the new one and stays fenced. After a
kernel pin upgrade, the paying member's own next dispatch (prompt, command, model/thinking change, compaction or
discovery) moves the idle head segment to the new kernel in place: only the current binding's version changes, the
same session file reopens on it, and the native session id and full history stay. Running or unknown work refuses the
move. A payer change, or another member sending, still uses the existing handoff path. Rolling the executable back to
the previous kernel makes such a segment's version differ again, so its next send on the old release hands off.
Session-list model labels read the current native journal binding,
not the legacy Durable agent's stale preference. A single batch read joins current conversation heads and model overrides,
without a per-row native session lookup or a second model-state cache. Model switches and server restarts do not change historical receipt bindings.

Browser/computer-use refer to the service host, not the viewer's device. Quota results remain member-private account
snapshots. See [NATIVE-COMMAND-COMPATIBILITY.md](NATIVE-COMMAND-COMPATIBILITY.md) for every supported interaction and limit.

### Branch interaction and outcomes

The pinned RPC `navigateTree` adapter returns only `cancelled`; it drops the native session's `editorText`, `aborted`
and summary result. Team therefore preserves native cancellation, extracts draft text with the pinned native
`contentText(content, "")` helper **after successful, non-no-op navigation**, and reads only newly persisted native
summary entries. The cancellation reason is unavailable, not inferred. String content and multiple text blocks use
native concatenation; image-only/empty entries are not offered by the fork selector. Cancellation, error and unknown
outcomes leave an existing draft untouched. Tree result readback is durable and does not replay navigation.

The shared transcript and the native snapshot API's `messages` are **immutable audit history**, including abandoned
branches. Navigation does not delete those records. A notice identifies this after branching; `/tree` labels active
versus abandoned branch entries. Native JSONL export follows the selected branch. Compaction may further reduce the
context sent to a model; branch membership is not a promise that every ancestor message is sent verbatim.

Native status/widget events replace or clear keyed live slots. Ordinary `notify` text/JSON creates notices;
Team's existing `team-kernel-*-v1` notify envelopes are private controls, not notices. The shared decoder validates
children/policy/barrier/tree/context fields before dispatch to readers; command adapters still correlate their own
nonce. Unknown reserved kinds, invalid fields or malformed reserved `{"kind":"team-kernel-` prefixes fence the RPC
transport as unknown, without replay or payload logging. Other incomplete JSON remains ordinary notification text.
The wire format and pinned native sender are unchanged.

A `handled` receipt means the handler completed, not that a requested navigation occurred: inspect its cancellation/result.
Side-effectful slash handlers use `command` receipts and are not automatically continued after unknown outcomes.
Only native-discovered prompt templates/skills become ordinary recoverable `prompt` operations. Existing stored
receipts stay readable and are not rewritten. Goal Stop may remain unknown; it does not certify external effects.

## Outputs and conversation copies

The **Outputs** entry groups successful `write`/`edit` records and separately published artifacts. It uses the already
public transcript projection, not a scan of the server filesystem, raw native history, parsed shell commands or script
source. Successful codemode child-call metadata is included, even if a later script step failed. Failed/pending writes
and clipped direct path arguments do not create links. Only child metadata with an already-public path is indexed;
native nested-call records without public paths are not mined for arguments and remain accessible via Browse project
files. Existing file-view/download authorization remains authoritative.
The button count and sheet share this history-based definition. Browse project files finds shell-created and other
unindexed outputs without enabling the legacy artifact extension.

This is an audit-history shortcut, **not** a manifest of the active native branch, an existence check, a saved file
version or a new filesystem permission. Inherited/discarded history may refer to files that have changed or disappeared;
opening resolves the current path through the existing authorized endpoint. Clones/forks share the project folder.
The UI states these limits instead of implying independent file copies. Native `/clone` keeps the visible source title
plus `· Copy`; an earlier-message fork uses `· Fork`. Imported source `session_info` remains in audit history but cannot
rename the destination. Subsequent explicit live naming still works.

## MCP credentials

MCP server definitions can be shared or project-local; OAuth tokens remain in each member's
`kernel-homes/<member>/.pi/agent/mcp-auth.json`. The browserless native sign-in bridge never opens the service user's browser.
Only the initiating member's loopback callback origin/path is accepted. The MCP-only native CLI runs from the project's
cwd, so relative stdio arguments and config precedence match Agent execution. Its native trust record enables project MCP
parsing; this CLI exits before project extension/package loading. Agent/child startup independently grants native project
trust. Project `auth.provider` remains rejected by the native
parser: a repository cannot redirect a member's model login token. Config add/edit/remove changes the next startup and
command freshness; `/reload` reconnects native MCP. Project workspaces remain separately backed up.

Do not put personal access tokens or global-account credentials in shared config. Environment lookups use the scrubbed
member environment, not the service's ambient secrets. Backups/restores continue to exclude refresh grants; members sign
in again. Declared config paths cannot name auth, model stores or session storage.

## Forty-five terminal entries and TUI compatibility

See [NATIVE-COMMAND-COMPATIBILITY.md](NATIVE-COMMAND-COMPATIBILITY.md) for the supported interactions and actual coverage.
The attested 0.1.22 terminal comparison contains 24 builtins, 15 extension commands and 6 skill commands. The empty
shared Team profile on rotom 0.1.25 has 40 raw native entries: `/context` is now packaged and the other five personal
skills remain absent. Twenty-seven remain public after protecting thirteen terminal-only builtins. Inventory presence
is not proof of terminal-equivalent interactions.

`/context` has structured Web usage/injection-source adapters. `/llama` remains discoverable but its custom manager
requires TUI support that pinned RPC cannot supply. A handled response containing a TUI-only warning is not success. Five personal skills remain deliberately uninstalled
by user choice; this is not permission to publish private memory/preferences/device lessons.

Production TUI transport is outside this delivery scope. A bounded OS-PTY prototype renders and interacts with an actual native custom component, preserving an isolated member
session and an unknown command receipt. It is **not** a production transport: public extension APIs expose no generic
command-completion/error observer to the external TUI frontend. Terminal exit or visual messages are not sufficient to
settle a receipt. No context.mode spoofing or native monkeypatch is used. The separate `/context` Web adapter reuses
native measurement functions; it is not a generic TUI transport.
