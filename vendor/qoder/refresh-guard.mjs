import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { QoderError } from './auth.mjs';

// Empty, private tombstones contain only SHA-256 token digests in their names.
// Keep them after success too: Pi may fail to persist a rotated credential.
// No automatic cleanup/expiry can prove that an old credential is unreachable.
export function createRefreshGuard(agentDir) {
  return async refresh => {
    try {
      if (!isAbsolute(agentDir) || resolve(agentDir) !== agentDir || await realpath(agentDir) !== agentDir) throw new Error();
      const dir = join(agentDir, 'qoder-refresh-attempts');
      await mkdir(dir, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
      const before = await lstat(dir);
      if (!before.isDirectory() || before.isSymbolicLink() || (before.mode & 0o077) ||
          (process.getuid && before.uid !== process.getuid()) || await realpath(dir) !== dir) throw new Error();
      let count = 0;
      for await (const _ of await opendir(dir)) {
        if (++count >= 4096) throw new QoderError('oauth_refresh_guard_full');
      }
      const name = createHash('sha256').update(refresh).digest('hex');
      let handle;
      try { handle = await open(join(dir, name), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
      catch (e) { if (e.code === 'EEXIST') throw new QoderError('oauth_refresh_already_attempted_login_required'); throw e; }
      try {
        await handle.sync();
        const after = await lstat(dir);
        if (await realpath(dir) !== dir || before.dev !== after.dev || before.ino !== after.ino) throw new Error();
        const directory = await open(dir, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await directory.stat();
          if (stat.dev !== before.dev || stat.ino !== before.ino) throw new Error();
          await directory.sync();
        } finally { await directory.close(); }
      } finally { await handle.close(); }
    } catch (e) {
      if (e instanceof QoderError) throw e;
      throw new QoderError('oauth_refresh_guard_unavailable');
    }
  };
}
