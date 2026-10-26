# Project map

Where to change **rotom team**. [PRODUCT.md](PRODUCT.md) and [CONFIGURATION.md](CONFIGURATION.md) are the current
contracts; [architecture.md](architecture.md) explains ownership and lifecycle order. Read [AGENTS.md](../AGENTS.md)
and [self-editing.md](self-editing.md) before editing a running checkout.

The Team entry points and native execution owners come first. The retained Pi Pocket modules below are a source
navigation map, **not a list of capabilities enabled in kernel mode**. Legacy service extensions and Durable agent
execution are explicitly marked. Native extensions use [AGENT-CONFIGURATION.md](AGENT-CONFIGURATION.md).

## Processes

- **Team:** [bin/rotom-team.js](../bin/rotom-team.js) checks Node, sets private permissions and the data/agent
  environment, prepares the pinned runtime, then imports `src/server/main.ts` directly. It does not run the
  Pocket launcher or create its tunnel/menu process. Always pass `--data` for development and tests.
- `src/server/main.ts` parses options (kernel enabled by default), opens `PocketApp`, creates the HTTP handler,
  starts the performance journal and installs watchers/signals. Its `stop` function owns the outer shutdown
  deadline. `PocketApp.#open/close` own app resources; `TeamKernel` owns native admission and closure.
- **Legacy launcher:** `bin/pi-pocket.js` → `src/launcher/main.ts`, with `options.ts`, `access.ts` and
  `term.ts`, provides the inherited interactive launcher/tunnel/restart UI. Do not use it to describe the
  default Team process tree.
- A deployed Team service may be owned by launchd and run from an immutable release directory, not this checkout.
  See [DEPLOYMENT.md](DEPLOYMENT.md); a source edit is not a deployment or permission to restart it.

## Data

Team's CLI resolves `--data`, then `ROTOM_TEAM_DIR`, then `~/.rotom-team`; it exports `PI_POCKET_DIR` and
sets `PI_CODING_AGENT_DIR=<data>/agent` before imports. The inherited `~/.pi-pocket` default is **not** the Team
deployment folder. Use an explicit throwaway data directory when testing.

| Location under data                          | Owner / purpose                                                                                                                         |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `pocket.sqlite`, `harness.lock`              | `PocketApp.#open/close`: shared Durable documents, conversations/tasks and public native mirrors                                        |
| `kernel.sqlite`, `kernel.lock`               | `RotomJournal.constructor/close`: native receipts, bindings, entries/usage and writer fence; stale kernel locks are not auto-broken     |
| `people/<member>/`                           | `TeamAccounts.#open`: private credentials, model catalog, profile/generation and refresh coordination                                   |
| `kernel-homes/<member>/`                     | `TeamKernel.#home`: native broker HOME and native session files; not the canonical personal credential store                            |
| `kernel-gates/`                              | `RotomExecutions.#launch/#retire`: short-lived loopback-gate secret/context files                                                       |
| `team-agent/`, `agent/`                      | `prepareTeamResources` and CLI bootstrap: shared native configuration/resources and isolated service agent resources; see CONFIGURATION |
| `config.json`, `push.json`                   | `ConfigStore`, `PushStore`: people/settings/finished markers and Web Push state                                                         |
| `uploads/`, `worktrees/`, `browser/profile/` | Shared workspace helpers and legacy service browser resources                                                                           |
| `performance/`                               | `startPerformanceJournal`: bounded local timing/work observations, not request content                                                  |

`scripts/data.mjs` owns offline backup/restore checks. Neither a live SQLite copy nor a deleted lock is a safe
substitute for its ownership checks.

## Server: `src/server/`

A module split into parts keeps its name for the part others import, with the rest in a folder of the same name beside it (`http.ts` and `http/`, `browser.ts` and `browser/`). Modules import what they use from the module that owns it; there are no barrels. `PocketApp` creates the app's parts and hands each one the app; callers use them as fields (`app.workspace.viewFile(…)`, `app.attribution.requesterOf(…)`).

### Team execution owners

Paths here are under `src/server/`. Start at these functions before changing an upstream helper.

| File                                                     | Main entry points and ownership                                                                                                                                                                                        |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `team-kernel.ts`                                         | `TeamKernel.submit/#submit/#check`: native authorization and fixed payer; `reconcile/mirror/#mirrorNow`: shared mirror recovery; `#observe/clientLive/roomState`: provisional UI; `close/resumeInterrupted`: lifecycle |
| `team-kernel/projection.ts`                              | `publicEntry/applyUpdate`: pure public-entry filtering and streamed-delta projection; no runtime imports or execution state                                                                                            |
| `rotom-executions.ts`                                    | `RotomExecutions.run/#execute/#launch`: receipt-owned process and auth gate; `handoff/#seed`: history materialization; `close`: stop native resources before closing journal                                           |
| `rotom-executions/seed.ts`                               | Parent-owned worker protocol: journal attach ACK, join/Stop, exit before final authorization/finish                                                                                                                    |
| `rotom-executions/seed-worker.ts`                        | One public-history seed job using the pinned data API; no database connection or inference                                                                                                                             |
| `storage-worker.ts`                                      | Parent-owned FIFO/admission, ACK correlation, failure fencing and final lease release                                                                                                                                  |
| `storage-protocol.ts`                                    | Bounded pages for complete V8-serialized operations and results                                                                                                                                                        |
| `storage-worker-thread.ts`                               | Single journal/public Durable Storage owner; no Harness, credentials or native processes                                                                                                                               |
| `rotom-executions/seed-files.ts`                         | Private destination, native append, file/directory fsync, readback and full comparison                                                                                                                                 |
| `rotom-executions/native-tail.ts`                        | `readNativeSnapshot/readNativeEntries/NativeTail`: bounded JSONL prefix validation and RPC suffix readback; execution still owns each tail and its lifecycle                                                           |
| `rotom-journal.ts`                                       | `RotomJournal.reserve/attach/progress/finish`, `entriesAfter/entryCursor`, `canResume/planResume`: native persistence and fences; not a display-only cache                                                             |
| `rotom-kernel.ts`, `rotom-product.ts`, `rotom-rpc.ts`    | `startRotomKernel`, `verifyRotomKernel`, `RotomRpc.request/close`: pinned launch, resource admission and bounded RPC; `nativeSessionDataApi`: verified session-file loader without the process client                  |
| `rotom-policy.mjs`, `rotom-relay.mjs`, `rotom-qoder.mjs` | `rotom-policy` is the native gate extension; `rotom-relay` is a NODE_OPTIONS preload redirecting the member's browser relay socket; `qoderRequestProvider` supplies request-scoped Qoder auth                          |
| `team-accounts.ts`, `credential-store.ts`                | `TeamAccounts.#open/kernelModel/kernelAuth`, `FileCredentials`: personal identity and the sole refresh-capable credential store                                                                                        |
| `team-execution.ts`                                      | `TeamExecution.admit/authorize/recover`, `TeamRunDoc`: legacy Durable payer admission/recovery; explicitly rejects native execution                                                                                    |
| `team-profiles.ts`, `team-projects.ts`                   | `TeamProfiles.capture/verify`, `TeamProjects.require`: frozen configuration snapshots and project grants                                                                                                               |
| `rotom-resources.ts`, `rotom-resource-policy.ts`         | `prepareTeamResources/teamResourceRevision` and policy checks: installed resources and freshness, not a package installer in request paths                                                                             |
| `rotom-history.ts`                                       | `publicNativeHistory`: public handoff history, without private reasoning/signatures                                                                                                                                    |

Native skills: `startRotomKernel` and `rotom-child.sh` disable default discovery; `rotom-skills.mjs` supplies
project resources through the pinned resolver. Each native child first runs `rotom-child.ts`; its light validator
imports `rotom-resource-policy.ts` and `rotom-product.ts`, not the full kernel launch graph.
This is resource-loading policy, not an OS restriction on reading files.

### The shared app core

| File                    | Owns                                                                                                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main.ts`               | The server process: options, the port, signals, then `PocketApp.open` and `createHandler`                                                                                                                                       |
| `app.ts`                | `PocketApp`: shared Harness and optional TeamKernel lifecycle, recovery (`#recover`), commit coordinator (`#committed`), tabs/rooms and access checks; service extension loader exists only outside kernel mode                 |
| `attribution.ts`        | `Attribution.requesterOf/recover`: message authors and legacy workflow attribution; not the native fixed payer or per-inference credential gate                                                                                 |
| `room.ts`               | `Room.open/schedule/pushAll`: shared Durable view plus native `clientLive/roomState`, projected for each viewer; `pushAll` shares common serialization within one fanout. `schedulePeek/pushPeek` deliver peek state            |
| `projection.ts`         | Entries as compact JSON for browsers; `usageCost`                                                                                                                                                                               |
| `entry-format.ts`       | The kinds of Pi Pocket's own entries, and the markers it writes into message text (`[from: …]`, attached files). Stored data and the web app depend on their exact values                                                       |
| `docs.ts`               | Shared collaborative documents; additional stored contracts include TeamRunDoc (`team-execution.ts`), configuration docs and native mirror/setup docs (`team-kernel.ts`). Preserve every stored kind/scope/history/fork setting |
| `host.ts`, `reload.ts`  | Retained `PocketHost` types/Approvals and shared web `watchTree`; D9b removes the service loader and drop-in preparation                                                                                                        |
| `lock.ts`               | One process per data folder                                                                                                                                                                                                     |
| `errors.ts`, `paths.ts` | `HttpError`, `describe`, and input checks; `~` paths                                                                                                                                                                            |

### People

| File                   | Owns                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| `config.ts`, `auth.ts` | People and settings; cookies, tokens, invites                                                    |
| `requests.ts`          | Request ids, which say whose each message to Pi is (`u:` a person's own, `p:` sent for a person) |
| `collab.ts`            | Chat, activity lines (`addActivity`), reactions, pins, notes, typing, take turns                 |
| `alerts.ts`, `push.ts` | Push notifications: who hears about what; Web Push without dependencies (RFC 8291, 8292)         |
| `spend.ts`             | Cost per conversation and person; limits                                                         |

### Shared UI helpers and legacy execution wrappers

These files also serve retained Durable sessions. Their presence does not enable every old command in native mode;
`conversationRoutes`, `TeamKernel` and `team-command-policy.ts` select the native adapters.

| File                      | Owns                                                                                                                                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commands.ts`             | `Commands.createSession` creates the requested backend; `Commands.submit` is legacy Durable submission. Native submit is routed directly to `TeamKernel.submit` by `conversationRoutes` |
| `resend.ts`               | A message sent again: the task made with its fork that sends it                                                                                                                         |
| `shell.ts`                | `!` and `!!` commands: a background task per command that runs it and writes a `pocket.shell` entry; a restart cuts it off rather than running it again                                 |
| `schedules.ts`, `when.ts` | Scheduled messages (a durable task) and their time grammar                                                                                                                              |
| `goals.ts`                | "Done when" checks                                                                                                                                                                      |
| `titles.ts`               | A short title for a session with a long first message, from a small model of its provider                                                                                               |
| `prompts.ts`              | Pi's prompt templates and skills (`/skill:name`) as slash commands                                                                                                                      |
| `models.ts`               | The models people can pick, the one a conversation runs with, and finding one by name                                                                                                   |
| `running.ts`              | Running now, from Pi Durable's task graph                                                                                                                                               |

### A conversation's folder and history

| File                                   | Owns                                                                                                                                                                                               |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace.ts`                         | `app.workspace`: which files a person may load or read through a conversation, the file viewer, the files for `@` mentions, Changes, uploads, new folders from the folder picker                   |
| `transcripts.ts`                       | `app.transcripts`: stored history as people read it: an entry (its own, or one a fork inherited), the images in it, what came before the active context, and the session as Markdown               |
| `files.ts`                             | The files in a session's folder for `@` mentions: git's list, or a capped walk; kept briefly per folder, versioned, and compressed once. The file viewer's reads, and the paths a message mentions |
| `changes.ts`, `worktrees.ts`, `git.ts` | The Files tile's Changes (and undoing a file there), per-session worktrees, and the git runner both use                                                                                            |
| `branches.ts`                          | A session's git branch: read from the repository's HEAD for its view (`Room` looks every few seconds), listed and switched for the branch picker                                                   |
| `export.ts`                            | A session as Markdown                                                                                                                                                                              |

### HTTP: `http.ts` and `http/`

| File                          | Owns                                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `http.ts`                     | The one request handler: which part answers a path, and the error boundary that turns what it throws into a status                                                             |
| `http/api.ts`                 | `/api`: signing in, the `X-Pocket` header, and the app-wide routes (people, sessions, peeks, spend, folders, settings, extensions, providers, invites, restart)                |
| `http/conversation-routes.ts` | `/api/c/:id`: one conversation's routes, after the API checked that the person may see it                                                                                      |
| `http/browser-routes.ts`      | `/api/c/:id/browser`: the Browser panel's frames, console, and input                                                                                                           |
| `http/push-routes.ts`         | `/api/push`: this device's subscription, what to notify about, a test                                                                                                          |
| `http/events.ts`              | Each tab's events: the event stream (`/api/events`), or long polling (`/api/poll`) where a tunnel holds streams back                                                           |
| `http/assets.ts`              | `serveApp/serveFile/serveDownload/serveImage`: app CSP, best-effort modulepreload, file/download/image delivery; `http/static-cache.ts` owns bounded content/gzip/ETag caching |
| `http/sign-in.ts`             | `/login`, `/join/:code`, and `/share` before the service worker takes shares                                                                                                   |
| `http/artifacts.ts`           | `/a/…`: an artifact as its own page, in a sandbox; `/a/frame`, the page a reply's HTML runs in once someone taps Run                                                           |
| `http/io.ts`                  | What every route uses: reading a body, writing JSON, `ApiRequest`                                                                                                              |

`http/conversation-routes/upload.ts` owns only the terminal upload/404 branch and its filename/size checks.
The parent keeps its original dispatch position and supplies the already captured method and route part.

### Legacy service browser: `browser.ts` and `browser/`

This is the browser behind the Pocket service extension (`PocketApp.browserOn`), not a replacement for native tools.

| File                                     | Owns                                                                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `browser.ts`                             | `Browsers`: one headless Chromium for every conversation, started with the first page and stopped after the last; each conversation's page |
| `browser/page.ts`                        | `BrowserPage`: one conversation's page: its events, screencast frames, console, navigation, and what Pi and people do to it                |
| `browser/cdp.ts`                         | The DevTools protocol over a pipe (`--remote-debugging-pipe`), and the Chromium process; `BrowserError`                                    |
| `browser/discovery.ts`                   | Finding a Chromium-based browser on this machine, and where its profile goes                                                               |
| `browser/page-scripts.ts`                | The scripts that run inside a page: the outline with refs for Pi, finding a target, selecting                                              |
| `browser/keys.ts`                        | Key names and combinations as key events                                                                                                   |
| `browser/viewport.ts`, `browser/urls.ts` | Page sizes and their presets; what people and Pi type, made into addresses                                                                 |
| `browser/local-servers.ts`               | The web servers running on this machine, for the panel's start screen                                                                      |

### Elsewhere

| File                     | Owns                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| `providers.ts`, `net.ts` | Provider sign-ins; HTTP settings for provider streams                                           |
| `lancet.ts`              | Loads Lancet Guard from Pi's install                                                            |
| `omarchy.ts`             | The Omarchy desktop's current theme and wallpaper, read-only, for Follow desktop (`/api/theme`) |

## Removed legacy service extensions

D9c deletes the nine repository modules formerly under `src/server/extensions/` and only their exclusive tests/helpers.
Neither kernel nor read-only archive mode loads or watches old service extensions. User `<data>/extensions/` source
and enabled/disabled records remain intact and unloaded. Native Agent Extensions use the separate paths documented in
[AGENT-CONFIGURATION.md](AGENT-CONFIGURATION.md).

Shared Approvals/Lancet/parser implementations, historical task/document definitions, archive/export/auth paths and
legacy fixtures remain. D9c changes no data format; D9b/D9a can reopen the same data without reviving quarantined work.
See [LEGACY-ARCHIVE.md](LEGACY-ARCHIVE.md) and the [deletion inventory](performance/review-2026-10-23/d9c-inventory.md).

## Web: `web/` (Preact and htm, no build)

Plain ES modules, loaded as they are. `store.js` holds the shared state, and nothing imports in a circle. Some modules do work when they load: `back.js` (it hears back and forward), `store.js`, `ui.js` (Markdown and sanitizer setup, document listeners), `theme.js` (the saved appearance, which `prefs()` reads), `peeks.js`, `browser-panel.js` and `files-panel.js` (the panels' saved widths), `rich.js` (gives `Markdown` its rich block), `sheets.js` (a step back for each sheet opened from another), and `app.js`. `store.set` calls subscribers in the order they subscribed, so keep the order in which modules load when moving code between them.

| File                   | Owns                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `style.css`            | General stylesheet prefix, loaded before native.css                                                                                                                                                                                                                                                                                                                              |
| `native.css`           | Original contiguous native-UI suffix; adjacent link after style.css, with the same relative URL base                                                                                                                                                                                                                                                                             |
| `store.js`             | State, the event stream (SSE, or long polling when a tunnel holds it back), `api()`, `actions`                                                                                                                                                                                                                                                                                   |
| `back.js`              | The back stack: routes and the layers over them (sheets, the drawer, panels that cover the screen, a file over the tree) as history entries, so back closes what opened last; `useBack`, `pushRoute`, `goHome`, the list put under a conversation opened straight away, taps let go that land on what just slid in                                                               |
| `gestures.js`          | Touch gestures, each following its own finger by its identifier, passive where they can be: sheets dragged down and the drawer dragged left to close (`useDragToClose`); on phones, swipes on the conversation (right back, left Files), in Files (right back), and up from the message box (the places); a swipe in from the left edge goes back in an iPhone's home screen app |
| `app.js`               | Layout (tiled windows), top bar, notices, keyboard shortcuts, routing                                                                                                                                                                                                                                                                                                            |
| `transcript.js`        | Messages, tool cards, approvals, breadcrumbs                                                                                                                                                                                                                                                                                                                                     |
| `calls.js`             | A tool call in one line, for tool cards and peek tiles                                                                                                                                                                                                                                                                                                                           |
| `composer.js`          | Message box, chips, plan and goal bars, `@` file suggestions, `!` commands, ↑ and Ctrl+R history, long-paste placeholders                                                                                                                                                                                                                                                        |
| `history.js`           | What this browser sent, for ↑ and Ctrl+R                                                                                                                                                                                                                                                                                                                                         |
| `files.js`             | `@` mentions: the folder's file list, fetched once and checked in the background, and matched here as people type                                                                                                                                                                                                                                                                |
| `commands.js`          | Slash commands and prompt templates                                                                                                                                                                                                                                                                                                                                              |
| `sheets.js`            | Which sheet is open, and the component that shows it                                                                                                                                                                                                                                                                                                                             |
| `sheets/*.js`          | One sheet (or a few close ones) each: the model and branch pickers, folder, extensions, providers, people and invites, the file viewer (`FileView`, which the Files tile shows too), find, spend, running now, schedules, worktree, appearance, shortcuts, the menu, settings                                                                                                    |
| `peeks.js`             | Peek tiles: their switch, which sessions get one and in what order, the column and the strip, the watch list                                                                                                                                                                                                                                                                     |
| `chat.js`              | People panel: chat, pins, notes; the chat sheet                                                                                                                                                                                                                                                                                                                                  |
| `avatar.js`            | People's avatars and colors                                                                                                                                                                                                                                                                                                                                                      |
| `sessions.js`          | Session list (sidebar, drawer), selecting rows and archiving them with undo (`setArchived`), the folded rail                                                                                                                                                                                                                                                                     |
| `home.js`, `signin.js` | The wide home screen; the sign-in screen                                                                                                                                                                                                                                                                                                                                         |
| `notify.js`, `sw.js`   | Push, the icon badge, approvals from notifications, shares; the notifications sheet                                                                                                                                                                                                                                                                                              |
| `share.js`             | Share to Pi                                                                                                                                                                                                                                                                                                                                                                      |
| `ui.js`                | htm binding, Markdown (code blocks colored and labeled, split into parts around the blocks `rich.js` draws), formatting, icons, `Sheet`, `Switch`, `item` (a menu row), `usePresence` (animate out), `useSlide` (sliding indicators)                                                                                                                                             |
| `theme.js`             | Appearance: palettes as CSS variables, Follow desktop, tiling, motion, text size, sidebar shape, pins; the theme reveal                                                                                                                                                                                                                                                          |
| `themes.js`            | Omarchy's themes as palettes, generated from `/usr/share/omarchy/themes/*/colors.toml`                                                                                                                                                                                                                                                                                           |
| `launcher.js`          | The Ctrl/⌘+K launcher: sessions, actions, and themes, with live theme previews                                                                                                                                                                                                                                                                                                   |
| `browser.js`           | Whether the Browser panel is open, and opening an address in it                                                                                                                                                                                                                                                                                                                  |
| `browser-panel.js`     | The Browser panel: frames by long polling, taps, drags, wheel, and keys as input events, the address bar, sizes, the console, the start screen                                                                                                                                                                                                                                   |
| `files-panel.js`       | The Files tile: whether it is open and on which tab, the folder's tree (folders read as they open), Go to file, the open file beside the tree, and the Changes tab                                                                                                                                                                                                               |
| `diff.js`              | The diff viewer: one file's diff (unified or split, line numbers, colors, changed words, hidden lines on request), `DiffBlock` for tool cards and replies, and `DiffReview`, every change file by file with viewed marks                                                                                                                                                         |
| `diff-parse.js`        | Diffs as data, without the DOM: unified diffs and Pi's edit format as files, hunks, and lines; rows that pair changed lines by likeness; the words that changed                                                                                                                                                                                                                  |
| `rich.js`              | Code blocks in replies that show more than code (a page previewed, with Run; an SVG; a diff), given to `Markdown` at load (`setRichBlock`); `HtmlPreview`, `Highlighted`                                                                                                                                                                                                         |
| `run-frame.js`         | `RunFrame`: a reply's HTML run on a tap, in the server's sandboxed `/a/frame` page, sized to fit it                                                                                                                                                                                                                                                                              |
| `highlight.js`         | Syntax colors without dependencies: `highlightLines` gives escaped HTML with flat `hl-` spans per line, which `diff.js` marks changed words in                                                                                                                                                                                                                                   |

## How a native message travels

1. `web/store.js: actions.submit` posts a stable request id to `/api/c/:id/submit`.
   `conversationRoutes` selects the stored backend; native requests go to `TeamKernel.submit`, not `Commands.submit`.
2. `TeamKernel.#operation/#submit/#check` checks access and payer identity and owns request identity.
   `RotomExecutions.run/#execute` reserves a journal receipt before native dispatch. An accepted request is not
   proof that a tool or provider operation succeeded.
3. `RotomExecutions.#execute` reuses an admitted process or starts one through `#launch`/`startRotomKernel`.
   The launch owns its auth gate. Every model request goes through personal authorization; active work does not
   inherit a later speaker's account.
4. `RotomJournal.progress/finish` records native entries/receipts. `TeamKernel.#mirrorNow` commits public
   entries and the mirror count to Durable; only then does the in-memory cursor advance.
5. `PocketApp.#committed` updates shared projections. `Room.pushAll` sends changed fields; `store.js: applyView`
   applies them. Native live events and a tab's optimistic send may appear before persistence, visibly separate
   from confirmed history.

**Legacy archive path:** the HTTP route and direct commands reject execution/mutation using the persisted root backend. `legacy-archive.ts` atomically quarantines outstanding work through public Storage before Harness opens; no legacy callbacks or resume run. Reads, export and access grants remain. Native receipts keep their own payer/unknown rules.
For startup, clean closure and permitted continuation, follow [architecture.md](architecture.md#startup-and-recovery-order).

## Adding things

- **A document:** define it in `docs.ts`. To show it live, add it to `ROOM_DOCS` and the view in `room.ts`, and read it in `store.js`.
- **A command:** choose the backend first. Native adapters belong with `TeamKernel` and `team-command-policy.ts`; legacy/shared wrappers may use `commands.ts`. Route through `conversationRoutes`/`createApi`, enforce access and request identity, then add the store action/UI.
- **A sheet:** a component in `web/sheets/`, a case in `sheetBody` (`web/sheets.js`), and `openSheet({ type })` where it opens. An app-wide one also goes in `SETTINGS_PAGES` and the list in `web/sheets/settings.js`, so it opens as a page of the settings window.
- **Something back should close** (a screen over the conversation, a view that takes another's place on a phone): `useBack(open, close)` from `web/back.js` in the component that shows it. Sheets already have it.
- **A Team native extension:** follow [AGENT-CONFIGURATION.md](AGENT-CONFIGURATION.md) and the admitted shared/project configuration. D9c removes legacy repository service modules; user drop-in source/switches stay intact and unloaded. `reload.ts` retains only the shared web watcher. Do not add a legacy execution path.
- **A slash command:** `web/commands.js`.

## Rules that are easy to break

- Shared committed history, provisional native live output and tab-local optimistic sends are different states.
  Use `TeamKernel.clientLive`, `#mirrorNow` and `web/store.js: applyView` as their boundaries.
- Document kind/scope/history/fork settings are stored data: never change them as a refactor.
- Native unknown outcomes are not replayable; `RotomJournal.reserve/canResume` and
  `TeamKernel.resumeInterrupted` enforce fences and limited continuation. A missing PID proves no outcome.
- Native payer identity comes from the binding and gate, not the newest author or `Attribution.requesterOf`.
- Legacy task/memo/Live records are recovery data, not runnable work. Do not invoke old callbacks while archiving.
- Native Agent Extensions are admitted trusted code, not an OS sandbox. Retained `PocketHost` modules are unloaded.
- Server code remains erasable TypeScript with `.ts` imports. Pure moves preserve code and module/subscription
  order; see [architecture.md](architecture.md#the-web-app).

## Tests: `test/`

`npm test` runs `*.test.ts` using Node's test runner. `helpers.ts` supplies temporary data, scripted/no-inference
models, `openApp`, `until` and `fakeTab`; do not point these checks at real accounts or deployment data.

- `team.test.ts`, `rotom-lifecycle.test.ts`, `native-recovery.test.ts`: personal identity, receipts, restart
  and uncertain outcomes.
- `native-mirror.test.ts`: real cross-process mirror recovery, including failed mirror retries.
- `legacy-archive.test.ts`, `legacy-archive-ui.test.ts`: real old-version fixture, atomic/idempotent quarantine, immutable archive and browser read-only controls.
- `native-service-extensions.test.ts`, `dropins.test.ts`: neither mode enables the legacy service loader.
- `native-room-info.test.ts`, `room-projection.test.ts`: native projections and per-client delivery.
- `static-assets.test.ts`: HTTP validators, preload success/failure and CSP.
- `*ui.test.ts` plus the browser/native fixtures exercise the web app in real Chromium where available.
  The web app is not untested merely because it uses plain modules.
- `docs-examples.test.ts` parses **unloaded legacy** examples and checks source/config preservation; it does not execute factories or prove native extension admission. `test/perf/` is the separate controlled performance loop.

Use [VERIFICATION.md](VERIFICATION.md) to choose the required native, UI and policy proofs.
`node test/serve.ts` is the inherited temporary-data fixture, not a production deployment command;
for native-specific work use the fixtures described in that verification guide.
