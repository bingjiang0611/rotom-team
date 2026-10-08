import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { createDecipheriv, createHmac } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export class QoderError extends Error {
  constructor(code) { super(`Qoder: ${code}`); this.name = 'QoderError'; this.code = code; }
}

// Read-only compatibility with the CLI's local encrypted store. Never acquire its
// write lock, refresh tokens, create files, or expose decrypted data in errors.
async function readPrivateFile(file, limit) {
  if (await realpath(file) !== file) throw new QoderError('credential_path_not_canonical');
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o077) ||
      (process.getuid && before.uid !== process.getuid())) throw new QoderError('credential_file_not_private');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid()) || await realpath(file) !== file || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > limit) throw new QoderError('credential_file_changed_or_oversized');
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw new QoderError('credential_file_oversized');
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}

export async function readLocalCredential({ authDir = join(homedir(), '.qoder', '.auth'), now = Date.now() } = {}) {
  try {
    if (!isAbsolute(authDir) || resolve(authDir) !== authDir || await realpath(authDir) !== authDir) throw new QoderError('credential_path_not_canonical');
    const machine = (await readPrivateFile(join(authDir, 'machine_id'), 128)).toString('utf8').trim();
    if (!/^[\x20-\x7e]{16,128}$/.test(machine)) throw new QoderError('credential_format_invalid');
    const encrypted = (await readPrivateFile(join(authDir, 'user'), 64 * 1024)).toString('utf8').trim();
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encrypted)) throw new QoderError('credential_format_invalid');
    const key = Buffer.from(machine.slice(0, 16), 'ascii');
    let data, plaintext;
    try {
      const cipher = createDecipheriv('aes-128-cbc', key, key);
      plaintext = Buffer.concat([cipher.update(Buffer.from(encrypted, 'base64')), cipher.final()]);
      data = JSON.parse(plaintext.toString('utf8'));
    } finally { plaintext?.fill(0); key.fill(0); }
    const token = data.security_oauth_token || data.access_token;
    if (typeof token !== 'string' || !token || token.length > 16384 || /[\r\n]/.test(token)) throw new QoderError('credential_format_invalid');
    if (!Number.isFinite(data.expire_time) || data.expire_time * 1000 <= now + 60000) throw new QoderError('credential_expired_login_with_qodercli');
    const identity = value => (typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\r\n]/.test(value)) || (Number.isSafeInteger(value) && value >= 0);
    if (!identity(data.uid) || (data.org_id !== undefined && data.org_id !== null && data.org_id !== '' && !identity(data.org_id))) throw new QoderError('credential_identity_unavailable');
    // Persist only a machine-keyed digest, never uid/org/token. Rotation of the
    // access token is allowed; account, organization or machine changes are not.
    const fingerprint = createHmac('sha256', machine).update(JSON.stringify(['qoder-account-v1', String(data.uid), String(data.org_id ?? '')])).digest('hex');
    return { accessToken: token, fingerprint, expiresAt: data.expire_time * 1000, uid: String(data.uid), org: String(data.org_id ?? ''), machineId: machine };
  } catch (error) {
    if (error instanceof QoderError) throw error;
    throw new QoderError('credential_unavailable');
  }
}

export async function readLocalAccessToken(options) {
  return (await readLocalCredential(options)).accessToken;
}

export function createCredentialAccess({ readCredential = readLocalCredential, captureBinding } = {}) {
  let pinned;
  const localBinding = fingerprint => {
    if (pinned && pinned !== fingerprint) throw new QoderError('account_changed_start_new_session');
    pinned = fingerprint;
  };
  const read = async signal => {
    if (signal?.aborted) throw new QoderError('aborted');
    const credential = await readCredential(signal);
    if (signal?.aborted) throw new QoderError('aborted');
    if (!/^[a-f0-9]{64}$/.test(credential?.fingerprint ?? '') || typeof credential?.accessToken !== 'string' || !credential.accessToken) throw new QoderError('credential_identity_unavailable');
    return credential;
  };
  return {
    // Catalog availability checks do not bind an account or write a session.
    async check(signal) { await read(signal); },
    async getToken(signal) {
      if (signal?.aborted) throw new QoderError('aborted');
      const bind = captureBinding ? captureBinding() : localBinding;
      const credential = await read(signal);
      bind(credential.fingerprint);
      return credential.accessToken;
    },
  };
}
