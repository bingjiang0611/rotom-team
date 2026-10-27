# Native macOS deployment and recovery

This service is for a dedicated macOS user and fully trusted team. It is **not** an OS sandbox. Begin on loopback; no public tunnel is configured by these instructions. Remote members need an explicitly selected private/TLS network route before deployment.

## Install a fixed checkout

Use Node 24 and the committed lockfiles. Copy only this repository's source, runtime pin/lockfile, `vendor/`, and scripts to the deployment machine; never copy the maintainer's HOME, `.pi`, credentials, or `node_modules`. Preserve upstream notices. There is no public npm release.

```sh
cd /absolute/rotom-team
node --version
npm ci
npm run install:kernel
npm run check
npm run format:check
npm test
node bin/rotom-team.js --data /absolute/team-data --cwd /absolute/team-workspace --host 127.0.0.1 --port 8787
```

`npm ci` runs the hash-bound preparation of the pinned Durable and OpenAI response runtime repairs. If installation uses `--ignore-scripts`, explicitly run `npm run prepare:runtime` before starting. The launcher checks the same patch identity on every start; unexpected dependency bytes fail closed rather than silently patching another release.

The first startup prints an owner bearer login link. Keep it private. Invite members with their own accounts; do not distribute the owner's link. Each member selects their own provider/model. The browser sign-ins settings create separately revocable credentials for another browser **with the same member identity and provider accounts**; these are not remote execution workers. There are at most 32 additional browser credentials per member; revoke old ones to add more. Revocation closes that member's established streams so they authenticate again. Owner-token rotation revokes the owner's additional credentials too.

For OpenAI sign-in from another computer, the member pastes the browser's final `localhost:1455` address back into the sign-in dialog: see [REMOTE-OPENAI-LOGIN.md](REMOTE-OPENAI-LOGIN.md). No SSH access is needed. Only one OpenAI/Codex sign-in uses the server's port 1455 at a time.

Importing existing OAuth material into a separate refresh-capable runtime can race and invalidate the original login. Use independent login for deployed members and keep a unique parent refresh writer. No instruction here authorizes copying the maintainer's grants.

## Current execution backend

rotom runs new sessions by default. The installation above prepares the fixed product in `runtime/rotom/`; its
version and hashes come from `runtime/rotom/pin.json`. Do not replace that installation while a run uses it.

`--no-rotom-kernel` starts a read-only archive server, never the retired Durable executor; `--rotom-kernel` remains an explicit alias for the default. Stored
Durable sessions retain their backend as archives. Back up offline before first D9a startup; see [LEGACY-ARCHIVE.md](LEGACY-ARCHIVE.md) for atomic quarantine and rollback. Pending/unknown native receipts remain fenced even if native creation is
disabled; changing the flag does not authorize bypassing quarantine.

The parent remains the model credential refresh writer. Shared agent configuration, project context/skills/MCP and private member MCP sign-ins follow
[CONFIGURATION.md](CONFIGURATION.md). Do not place copied model grants in `kernel-homes`, delete receipts or remove
an unreconciled lock to force recovery.

For isolated, authorized verification, use the `test:kernel*` scripts described in [VERIFICATION.md](VERIFICATION.md)
and [CONFIGURATION.md](CONFIGURATION.md). These are separate from production startup. A recipe or an old PASS is
not deployment evidence. The current execution limits are in [PRODUCT.md](PRODUCT.md), acceptance requirements in
[NATIVE-DELIVERY.md](NATIVE-DELIVERY.md), and recovery decisions in [NATIVE-RECOVERY.md](NATIVE-RECOVERY.md).

## Keep it running with launchd

Run as the dedicated user, not root. Create `~/Library/LaunchAgents/dev.rotom.team.plist` using absolute paths below; replace `NODE`, `CHECKOUT`, `DATA`, and `WORKSPACE`. `NODE` is the result of `command -v node` on **that machine**, not a copied maintainer path. Create `DATA` and `WORKSPACE` privately first. Store the plist with mode `0600`.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.rotom.team</string>
  <key>ProgramArguments</key><array>
    <string>NODE</string><string>CHECKOUT/bin/rotom-team.js</string>
    <string>--data</string><string>DATA</string>
    <string>--cwd</string><string>WORKSPACE</string>
    <string>--host</string><string>127.0.0.1</string>
    <string>--port</string><string>8787</string>
  </array>
  <key>WorkingDirectory</key><string>WORKSPACE</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>DATA/service.log</string>
  <key>StandardErrorPath</key><string>DATA/service-error.log</string>
</dict></plist>
```

Behind a TLS-intercepting corporate proxy, `curl` trusts the proxy's root through the macOS keychain but Node does not, and model requests fail with `fetch failed` (`SELF_SIGNED_CERT_IN_CHAIN`). Export that root to a PEM file (`security find-certificate -c "<root name>" -p > root.pem`) and add `NODE_EXTRA_CA_CERTS` with its absolute path to the plist's `EnvironmentVariables`. The server passes it on to every rotom process; check with a Node `fetch` to the provider before admitting members.

```sh
plutil -lint ~/Library/LaunchAgents/dev.rotom.team.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.rotom.team.plist
launchctl print gui/$(id -u)/dev.rotom.team
# Stop before an upgrade or offline backup:
launchctl bootout gui/$(id -u)/dev.rotom.team
```

Do not auto-open or publish login URLs. Logs may contain the startup owner link; keep the directory/logs private and rotate/remove logs deliberately. `KeepAlive` restarts stopped services; use `bootout` to actually stop. Locking refuses a second authoritative writer. This plist is a generic recipe, not evidence for a target device. It requires the dedicated user's GUI login domain; verify installation, restart and restore on the authorized target separately.

## Upgrade and offline backup

The current native journal uses **schema 6** for current segment-model overrides, following schema 5's unresolved queued-command fences. Older releases refuse unsupported schemas. Keep the pre-upgrade backup: rolling back only the executable is insufficient across a schema migration. Never drop the fences or lower the schema version. Review the shared-agent migration in [CONFIGURATION.md](CONFIGURATION.md) before starting the new release; workspaces now load trusted native project settings, extensions and packages. Review those executable sources before upgrading. Native processes persist between turns; shutdown must drain them before locks are released. MCP retains member-specific authentication.

1. Stop launchd/the existing process and wait for `harness.lock` to disappear. Investigate a remaining lock; never delete a live writer's lock. Native kernel executions additionally hold `kernel.lock`: even a dead recorded parent PID is not proof that its tools stopped. Backup refuses this lease; reconcile owned processes and unknown effects before any explicit recovery.
2. Create the destination parent privately first. Back up to a new directory outside the canonical data tree (ancestor symlink aliases cannot bypass this check):

    ```sh
    mkdir -m 700 -p /absolute/backups
    node scripts/data.mjs backup /absolute/team-data /absolute/backups/team-data-before-upgrade
    ```

3. Record the current commit and preserve its checkout. Install/check the new fixed checkout separately with `npm ci`, `npm run install:kernel`, `npm run check`, `npm run format:check`, and `npm test`. Do not replace files/node_modules under a live process.
4. Start the new checkout against the **same absolute data path**. Check owner/member views, model identities, configuration digests, and run receipts before admitting work. Document migrations preserve kind/version contracts; new optional project/configuration/usage documents do not rewrite historical assistant identity.
5. Roll back across the parallel-sessions change only when no member has two sessions running or unknown at once: an older release rebuilds its one-run-per-account index on open and refuses to start otherwise. Let runs finish or reconcile them first.
6. A failed/unverified external write is not permission to retry it. Inspect its durable task receipt and actual file/service state first. Durable process recovery and known interrupted tool behavior are different from OS/host migration. Never silently move SQLite or pending tool intents to another execution device.

Backups contain provider credentials, login tokens and conversation data. Keep them private; do not attach them to bug reports or recordings. Backup refuses a live writer, symlinks and nonregular files; it records per-file SHA-256 and excludes the lock and installed extension `node_modules`. Payload files, including journals larger than 512 MiB, are copied and hashed in 1 MiB chunks on both backup and restore. Metadata stays in memory proportional to the number of files; individual payload size does not set the I/O buffer size. A changed source or digest mismatch aborts the operation and removes the uncommitted staging copy. Locked `team-agent/npm/node_modules` is also excluded as rebuildable code; the manifest lists `excludedCaches`. Package manifests/locks and declared configuration remain in the backup. After restore, explicitly reinstall those packages with `npm ci` in `team-agent/npm` before native startup. Packages storing configuration/state inside that cache are unsupported; do not treat the backup as preserving such data. Backups still require enough disk space for the complete copy. Older restore scripts retain the 512 MiB limit: use this release's streaming restore tool for a large-file archive, including when rolling the service back to an older executable. The manifest remains `rotom-team-backup/v1`; streaming restore also accepts existing archives.

## Restore

```sh
# Only after stopping the service. Move the failed data directory aside; never overwrite it.
node scripts/data.mjs restore /absolute/backups/team-data-before-upgrade /absolute/team-data
```

Restore verifies the manifest and every copied file. It refuses an existing destination or a different canonical absolute data path; macOS `/var`↔`/private/var` aliases are equivalent. Relocating durable tool intents is unsupported. Restore deliberately **does not restore `people/*/auth.json`, `kernel-homes/*/.pi/agent/auth.json` or `kernel-homes/*/.pi/agent/mcp-auth.json`**, and skips temporary kernel gate capabilities: reviving old rotated refresh credentials could break an account. Members must log in independently again. Account routes without credentials fail closed; reconcile pending executions before continuing. Restoring history/configuration is not proof of inference, valid credentials, safe replay or a complete host migration.

Legacy frozen configuration snapshots contain copied instructions/skill assets, not symlinks to personal drafts. Their content is checked when read and at dispatch; changed assets are refused until a verified backup or explicit new configuration is activated. New sessions instead read the shared agent profile plus allowed project context and skills on each run. Neither path is an OS sandbox: the service OS user controls every file.
