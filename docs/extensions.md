# Extensions in rotom team

## Supported configuration

Team supports **native Agent Extensions**, not the inherited Pi Pocket service extension API.
Use [AGENT-CONFIGURATION.md](AGENT-CONFIGURATION.md) for admitted shared/project paths, native
`default (pi) => { … }` examples, installation, trust and reload. Native extensions execute inside the
trusted native boundary; installing one does not make it a sandbox or bypass member/account authorization.
Do not move an old `(host: PocketHost) => Extension` module into a native directory unchanged.

## Removed repository modules, retained user data

D9c removes the nine old repository modules formerly under `src/server/extensions/`: artifacts, browser,
codemode, goals, guard, plan, prompt, schedules and subagents. Their loader and execution paths were already
removed in D9b. Neither native kernel mode nor read-only archive mode loads or watches old service modules.
The old `/api/extensions` listing/toggle/reload endpoints remain unavailable. `reload.ts` keeps only the web watcher;
it is not a place to register extensions.

Existing user `<data>/extensions/` source files and enabled/disabled records stay intact and unloaded.
No dependency link is created, no source is deleted and no setting is silently migrated into a native resource.
Back up those files with the rest of the data. Port a desired extension explicitly using the native API and trust
rules above; preserving a file does not authorize its execution.

## Historical examples and data compatibility

[clock.ts](examples/clock.ts) and [no-force-push.ts](examples/no-force-push.ts) are retained **historical source
examples**, not Team installation instructions. `test/docs-examples.test.ts` parses their source and checks that
files and switches survive archive reopening without loading them. It does not execute their factories or prove
native admission. Tests which required the deleted repository modules are listed individually in the
[D9c inventory](performance/review-2026-10-23/d9c-inventory.md).

Historical task/document definitions, archive quarantine/export/auth paths and independent Approvals,
Lancet/parser tests remain. D9c changes no persistent format. D9b/D9a can reopen the same data without reviving
quarantined tasks; returning to pre-D9a requires the matched backup procedure and must not replay uncertain
external effects. See [LEGACY-ARCHIVE.md](LEGACY-ARCHIVE.md).
