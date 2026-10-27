# Verification: native resources and delivered files

This file contains the resource, command, subagent, and delivered-file verification evidence split from
[VERIFICATION.md](VERIFICATION.md).

## Shared agent resources and command inventory

`node --test test/native-service-extensions.test.ts test/app.test.ts test/dropins.test.ts` checks actual Team startup
without a server extension loader or drop-in dependency link, refusal of the old listing/toggle/reload API, and a
previously enabled drop-in not executing across reopen. Its source and persisted switch stay unchanged in both modes.
Legacy example tests parse source and verify preservation; they never execute retired extension factories. No model inference or real MCP service is required by these checks.

```sh
node --test test/rotom-resources.test.ts test/native-command-menu.test.ts test/team-resource-backup.test.ts
node --test test/backup.test.ts test/data-streaming-backup.test.ts
node --test test/agent-resource-list.test.ts
node test/team-resources-proof.ts
node test/native-command-inventory.ts <attested-terminal-inventory.json>
node test/native-tui-prototype.ts
node test/mcp-sign-in-proof.ts
```

`agent-resource-list.test.ts` checks the read-only Agent resources list: shared versus project scope, package and
disabled entries, the AGENTS.md chain, a same-name skill reported as not loaded, MCP overrides, a settings parse error
shown as a problem, the folders offered (the owner gets every session's folder, a member only the projects they may
view, and any other path is 404), and the bundled extensions and skill listed as the product launcher passes them
(without the session-only `ROTOM_PRODUCT_VERSION`, so Pi's Codemode is not counted twice). It also checks that a session the kernel never started reports no native commands instead of
failing. It does not check that a listed extension loads or a listed MCP server connects.

The resource unit checks derive shared settings, preserve credential/unknown-state bytes, reject credential declarations,
restore declared configuration and detect private config writes. The actual pinned resource proof checks native
computer-use project precedence, project settings/extensions/packages/templates/system files, native role loading,
standard UI interactions, shared/project skills and frozen context composition. It proves same PID and an increasing
extension-local counter across two receipts, idle gate HTTP 403, native reload, awaited follow-up and post-effect-error
replay fencing. Member-private executable customization remains a negative control. Dedicated regressions cover two-member managed file retirement, credential aliases, linked-package fingerprints,
dotted/non-ASCII command grammar, unknown discovery without a second POST, and real offline npm backup/restore/reinstall.
The streaming backup regression round-trips a 512 MiB + 73-byte payload in a 64 MiB heap subprocess, rejects whole-file payload reads, caps read/write chunks at 1 MiB, and checks peak RSS below 192 MiB. It also verifies private/executable modes, non-restoration of refresh grants, digest rejection for large and omitted files, symlink refusal, and staging cleanup on failure. These synthetic files do not establish a production restore or valid provider credentials.
The browser proof creates an actual abruptly-ended discovery and checks the native startup counter for same/new-request retries.
The native command proof also executes a genuine effect-then-throw command during an ordinary active prompt. It checks the
persisted effect, unknown owner with unchanged operation, duplicate refusal, absent recovery eligibility and no restart replay.
Journal tests cover both unresolved and confirmed-handled inputs; read-only inspection exposes the fence without command text.
The schema-1 migration fixture is reconstructed without newer tables/columns. Schema-6 inspection preserves operation identity and exposes only bounded phase/failure metadata. The v5 migration regression keeps legacy unknown receipts unchanged and ineligible for automatic continuation.

`node --test test/native-snapshot.test.ts test/rotom-journal.test.ts` checks a synthetic image-bearing history above 64 MiB against the pinned native SessionManager and actual RPC transport: the full response fails at the existing limit, while local-prefix/native-delta readback preserves every entry and the native selected branch. It also checks unflushed entries without a JSONL file, partial append anchors, foreign headers, durable finalization before a crash, and size-limit no-replay fences.

`node test/rotom-context-proof.ts` runs pinned context capture/measurement through the Team executor with a synthetic
loopback model. It covers usage and injection-source views before the first message and after a captured request, no
silent/paid probe, no extra usage charge, idempotent duplicate readback, and absence of raw prompt/message text in
returned results. `node test/native-commands-proof.ts --ui` checks `/context` discovery, desktop/mobile rendering,
usage/injections sheets, no-inference behavior and mobile containment. It also runs a real native prompt with more than
64 MiB of persisted custom history through the Team HTTP path, then verifies settlement. A separate unflushed 70 MiB suffix deliberately exceeds the unchanged bound: its finalization failure is visible through readback and remains unknown across restart without another inference.

The inventory script compares all 45 supplied terminal name/source pairs to actual isolated Team discovery. It records
40 raw baseline entries on 0.1.25 (`/context` is packaged) and 27 public catalog entries after thirteen terminal-only
builtins are protected; it does not claim 45 behavioral passes. Five personal skills are deliberately uninstalled by user choice, not replaced by fabricated skills. Read-only terminal SKILL.md metadata evidence is private and stays outside
Git. Every row and remaining interaction gap is listed in [NATIVE-COMMAND-COMPATIBILITY.md](NATIVE-COMMAND-COMPATIBILITY.md).

The PTY experiment runs the verified CLI and a real custom component on an OS PTY. It proves a native key interaction,
native persisted effects and session identity in a synthetic fixture. Its receipt remains unknown. It is not a browser
terminal implementation, generic command-completion proof or production backend. `/context` and `/llama` RPC warnings
are not success. No real accounts or external destructive actions are authorized by these checks.

`node --test test/rotom-mcp.test.ts` checks native shared/project precedence, partial disable overrides, project model-token
routing rejection, visible malformed-config errors and per-workspace freshness. `npm run test:kernel` proves a project
stdio tool overrides a shared definition and actually executes. `npm run test:kernel:mcp` uses project `.pi/mcp.json`
with two isolated member HOMEs: browserless OAuth, foreign callback rejection, private token routing, logout and frozen
context MCP loading. Project extensions stay unexecuted in MCP-only CLI operations and load in trusted Agent startup.
`npm run test:kernel:app` uses a project-defined child role explicitly selecting builtin MCP, under the same account gate. Shared resources remain covered by
the resource proofs. These are synthetic loopback checks, not real MCP service acceptance.

## Personal skills do not block native runs

`npm run test:kernel` keeps skills in both member-HOME directories and a personal `skills` setting. It verifies that
startup succeeds, personal skill commands/descriptions are absent, and project, ancestor and bundled skills still
load. Project exclusion patterns remain effective. `npm run test:kernel:app` verifies parent/child requests with
personal skills installed and that slash-command suggestions exclude them. The app fixture also covers frozen
configuration, project settings skills, history and restart. These checks use only synthetic credentials.

Existing `unknown` receipts are not rewritten or replayed by this change.

## Team subagent defaults

On rotom 0.1.26, session shutdown sends SIGTERM to live child runners, which records them as `paused`. Team's private
stop command therefore waits, up to 10 seconds, for each stopped child's runner to close before the kernel may close;
`npm run test:kernel:app` asserts the hanging child ends `stopped`. A runner that does not close in time is left to
shutdown and may still be `paused`. Neither state proves that external side effects were undone.

`test/rotom-subagents.test.ts` compares derived settings with the pinned native SettingsManager defaults, checks two
isolated member HOMEs and retirement of old managed overrides, and preserves shared retry, model-specific compaction
and role settings. `npm run test:kernel` uses the actual pinned subagent tool against a loopback model: its executable
list contains all five native roles on rotom 0.1.26 (`scout`, `worker`, `reviewer`, `delegate`, `oracle`). Its separate
no-redispatch fixture explicitly disables recovery in that fixture's shared profile, not in production code.
`node test/rotom-native-defaults-proof.ts` verifies actual Agent retry, provider retry options, automatic compaction,
same-payer gate checks and persisted summary usage with synthetic loopback requests. Journal unit tests preserve
unknown summary usage and require a terminal assistant response independently of automatic compaction.
This does not use real accounts. Independent reader enforcement is covered by the resource proofs above, not inferred from
the default-role test. Actual child inference/usage, fd-3 owner lifetime and Stop remain covered by the Team kernel proof.
The same proof checks named-skill metadata plus an actual child read of its file, user-memory routing for two members,
shared project memory for both members, and an existing refinement marker in the child's system prompt. Read-only memory
files and refinement files remain unchanged. WorkflowScript still has pre-execution negative controls. Native structured
single-child normalization is not programmable-workflow coverage. Native scoped ownership itself rejects synchronous script controllers; the async script delivery/lifetime gap is an explicit unsupported
capability, not simulated completion. See the user-approved subset in NATIVE-COMMAND-COMPATIBILITY.md.

## Delivered file links

`test/delivered-files.test.ts` uses an isolated server and synthetic accounts. It checks PDF inline responses,
HTML/Markdown/binary downloads, unchanged image-only serving, sign-in/session permissions, realpath traversal
and symlink rejection, and private configuration protection. Its real Chromium check renders ordinary Markdown
links, activates a file link with Enter, and verifies the Markdown viewer, script-disabled HTML preview and PDF
open action. Web URLs, anchors and application routes retain their addresses; supplied `data-path` marks are removed.
Browser checks skip explicitly when Chromium is unavailable. `npm run test:kernel:ui` also reads a delivered upload
through an actual native session, proving the download route is admitted without a model call. PDF byte delivery
does not establish rendering in every browser's PDF viewer. HTML downloads do not run in the application's origin.

`test/native-files.test.ts` creates a native session without inference. It checks `~` against the current execution
binding's HOME (not the service HOME), HTTP preview/download, attachment path resolution, both browser viewers,
and unchanged private-data/workspace boundaries. Missing and restricted paths give recovery guidance without
claiming that a restricted file exists. Native `~` follows the current segment after a handoff; it is not a historical
artifact identifier. Keep shared deliverables in the session workspace and link by workspace-relative or absolute
path. Private HOME contents are still owner-only; this fix does not publish them to other members or recover deleted files.

Failed relative file opens offer matching workspace paths, including hidden/ignored skill folders, without silently
choosing a different file. Lookup walks at most 50,000 files for 3 seconds, skips dependency directories and `.git`,
and never traverses linked directories. At most 50 readable matches are returned; incomplete results are labeled.
Use an exact server path when lookup is incomplete or the file is outside the workspace; a broader indexed search
is warranted only if repeated lookup limits make this insufficient. Normal session/private-data permissions still apply.
The same fixture checks duplicate candidates, hidden ignored skills, unauthorized/scoped access, candidate selection
in both viewers, manual absolute-path entry, 390px layout, and document-relative Markdown links/cache isolation.
Binary files still download instead of pretending to be previewable; missing files are not reconstructed.
