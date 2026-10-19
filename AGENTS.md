# Working on rotom team

Read [docs/PRODUCT.md](docs/PRODUCT.md), [docs/CONFIGURATION.md](docs/CONFIGURATION.md) and [docs/VERIFICATION.md](docs/VERIFICATION.md) for this fork's current contracts. Old phase plans and experimental results are not current requirements; use Git history only for explicit historical investigation. Preserve personal credential routing, unknown outcomes and the trusted-native boundary. `vendor/qoder/` is a hash-recorded source snapshot: update provenance when changing it; do not format it mechanically. The inherited Pocket implementation notes below describe upstream mechanics, not enabled team capabilities. Team kernel mode does not load or watch `src/server/extensions/` or data-folder drop-ins; use native Agent Extensions and [docs/AGENT-CONFIGURATION.md](docs/AGENT-CONFIGURATION.md).

Pi Pocket is often edited from inside itself, while it runs. [docs/map.md](docs/map.md) says where things are, and [docs/architecture.md](docs/architecture.md) what they rely on. [docs/self-editing.md](docs/self-editing.md) has the whole of what follows, including how to check a change on a throwaway copy (`node test/serve.ts`); [docs/index.md](docs/index.md) lists every guide. Keep editing safe:

- `web/**` changes reload every open browser right away. Keep the app loadable after each save: a syntax error blanks the screen for everyone, including you. Check with `node --check web/<file>.js` after editing.
- `src/server/extensions/*.ts` changes are reinstalled into the running server. A file that fails to load keeps its previous version and reports the error. Each module default-exports `(host) => Extension | Extension[]`. Start each module with a `/** … */` comment: its first sentence is the description in the app's Extensions sheet, where the owner can turn modules off (a module that is off is not loaded, even when edited).
- Other `src/server/**` changes need a restart (Settings → Restart server). Running work resumes after it, but a tool call cut off mid-run that is not replay-safe comes back as interrupted. Do not restart while your own tool call is running; finish the edit, run `npm run check` and `npm test`, then ask the user to restart.
- The owner's drop-in extensions in `~/.pi-pocket/extensions/` load the same way, after the built-in ones, and stay off until the owner turns them on. A `node_modules` link there lets them import Pi Pocket's packages.
- Document kinds in `src/server/docs.ts` are stored data. Do not rename them, or change their scope, history, or fork settings: Pi Durable checks those against what is stored.
- The server is plain TypeScript run by Node's type stripping: only erasable syntax (no enums, no parameter properties, no namespaces). Imports use `.ts` extensions.
- Code style is Prettier (`.prettierrc.json`: 4 spaces, 100 columns) plus ESLint's layout rules (`eslint.config.js`): braces on every `if` and loop, and a blank line after declarations, around blocks, and before `return` and `throw`. Run `npm run format` after editing. Prettier leaves the markup in `html` templates alone, so lay it out by hand the same way: 4 spaces per level, and a tag that runs past 100 columns gets one attribute per line and its children on their own lines. In htm a line break is not a space: break only where there is no space, or between tags, never inside running text.
- Run `npm run check`, `npm run lint`, and `npm test` after server changes.

## Starting it

Always pass `--data` (never use `~/.pi-pocket`). The server binds `127.0.0.1` unless the owner explicitly asks for another `--host`.

- Try a checkout: `npm ci && npm run install:kernel`, then `node bin/rotom-team.js --port 8788 --cwd <workspace> --data <throwaway dir>`. Use a port the team service does not own; a taken port prints "Port … is already in use" and exits, so a browser on that port still shows the old server.
- The team service on a deployment machine is the launchd agent `dev.rotom.team` (`~/Library/LaunchAgents/dev.rotom.team.plist`, `KeepAlive`), owning port 8787. It runs a fixed release under `~/rotom-team-deployment/releases/<commit>/` with the Node in `~/rotom-team-deployment/toolchains/`, data in `~/rotom-team-deployment/data`. A Git checkout elsewhere on that machine is not what it runs, and killing its process only restarts it.
- Upgrade it as in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), in this order:
    1. `git archive origin/main | tar -x -C ~/rotom-team-deployment/releases/<commit>` into a new directory; keep the old release for rollback.
    2. There, with the toolchain Node first in `PATH`: `npm ci`, `npm run install:kernel`, `npm run check`, `npm run format:check`, `npm test`.
    3. `launchctl bootout gui/$(id -u)/dev.rotom.team`; wait until `data/harness.lock` and `data/kernel.lock` are gone.
    4. `node scripts/data.mjs backup ~/rotom-team-deployment/data ~/rotom-team-deployment/backups/data-before-<commit>`, and copy the plist next to it.
    5. Point `ProgramArguments` item 1 at the new `bin/rotom-team.js`. `plutil -replace ProgramArguments.1` inserts into the array instead of replacing: follow it with `plutil -remove ProgramArguments.2`, then `plutil -lint` and diff against the copy (only the release path may differ).
    6. `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.rotom.team.plist`; check `launchctl print gui/$(id -u)/dev.rotom.team` shows `running`, `data/service-error.log` has nothing new, and the served `web/` files are the new ones.
- Roll back: bootout, copy the saved plist back, bootstrap. Restore data only with `scripts/data.mjs restore` (see DEPLOYMENT.md).

## Performance

People wait on sending, streaming, opening a session, the changes view, and opening the web app. Write new code so these stay fast; where it cannot, say why in a comment or the commit message. The loop and its rules are in [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

- Request handlers and push paths start no synchronous child process (there are none today). Synchronous file I/O there is for small, bounded files only.
- Within one refresh, run each git, SQL, or file query once. Join concurrent identical requests into one in flight.
- Page or cap lists, history, pushed payloads, and memory caches. Push only what changed, as the room already does for fields that did not.
- Prefer events. A poll backs off, pauses while the tab is hidden, and has one request in flight.
- A cache key holds every input that changes the result, and the cache can be invalidated.
- After changing a path people wait on, run `npm run perf:ci -- origin/main` and explain every counter that got worse: necessary new work, or a regression to fix first.
- Unmeasured is `unavailable`, never zero. Ceilings and baselines move down only (`perf:propose`); loosening either needs the owner's approval, and a higher ceiling also a `raise` record. Keep measurement code and optimisations in separate commits.
