import { createHash, createHmac, randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { QoderError } from './auth.mjs';
import { abortable } from './transport.mjs';

// Public CLI client identity used by the Qoder provider adapter.
// This is not a rotom registration, client secret, or evidence of upstream support.
export const DEVICE_CLIENT_ID = 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb';
export const LOGIN_URL = 'https://qoder.com/device/selectAccounts';
export const AUTH_ORIGIN = 'https://openapi.qoder.sh';
const MAX_BODY = 64 * 1024;
const text = (v, max = 16384) => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\x00-\x20\x7f]/.test(v);
const identity = v => text(v, 512) || (Number.isSafeInteger(v) && v >= 0);
const uuid = v => typeof v === 'string' && /^[a-f0-9-]{36}$/.test(v);

function expiry(absolute, relative, now) {
  let value;
  if (absolute !== undefined) {
    value = typeof absolute === 'string' ? Date.parse(absolute) : NaN;
  } else if (Number.isFinite(relative) && relative > 0) value = now + relative * 1000;
  // No invented lifetime. Keep one minute for dispatch/refresh skew.
  if (!Number.isSafeInteger(value) || value <= now + 60000) throw new QoderError('oauth_expiry_invalid');
  return value;
}

function fingerprint(machineId, uid, org) {
  return createHmac('sha256', machineId).update(JSON.stringify(['rotom-qoder-browser-v1', uid, org])).digest('hex');
}
function validate(c, now, requireFresh = true) {
  if (c?.type !== 'oauth' || c.qoderAuthVersion !== 1 || !text(c.access) || !text(c.refresh) ||
      !uuid(c.machineId) || !identity(c.uid) || (c.org !== '' && !identity(c.org)) ||
      !Number.isSafeInteger(c.expires) || !Number.isSafeInteger(c.refreshExpires) ||
      c.fingerprint !== fingerprint(c.machineId, c.uid, c.org)) throw new QoderError('oauth_credential_invalid');
  if (requireFresh && c.expires <= now) throw new QoderError('oauth_login_required');
  return c;
}

// Request auth is a process-local sealed envelope, not a mutable "current user"
// cache. Pi owns persisted OAuth credentials; hooks/overrides cannot substitute
// a token or account fingerprint, and only the transport receives the real token.
export function createOAuthEnvelope({ now = Date.now } = {}) {
  const key = randomBytes(32);
  return {
    async toAuth(credential) {
      const c = validate(credential, now());
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(JSON.stringify({ accessToken: c.access, fingerprint: c.fingerprint, expiresAt: c.expires, uid: c.uid, org: c.org, machineId: c.machineId })), cipher.final()]);
      return { apiKey: 'rotom-qoder-v1.' + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url') };
    },
    read(apiKey) {
      try {
        if (typeof apiKey !== 'string' || !apiKey.startsWith('rotom-qoder-v1.') || apiKey.length > 32768) throw new Error();
        const data = Buffer.from(apiKey.slice('rotom-qoder-v1.'.length), 'base64url');
        const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
        cipher.setAuthTag(data.subarray(12, 28));
        const c = JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8'));
        if (c.expiresAt <= now()) throw new QoderError('oauth_login_required');
        return c;
      } catch (e) {
        if (e instanceof QoderError) throw e;
        throw new QoderError('oauth_request_auth_invalid');
      }
    },
  };
}

export function createBrowserOAuth({ fetchImpl = globalThis.fetch, now = Date.now, sleep = delay, claimRefresh } = {}) {
  async function request(path, { signal, body, token, pending = false } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let reader;
    try {
      combined.throwIfAborted();
      const response = await abortable(async () => {
        const result = await fetchImpl(AUTH_ORIGIN + path, {
          method: body ? 'POST' : 'GET', redirect: 'error', signal: combined,
          headers: { Accept: 'application/json', 'User-Agent': 'rotom/qoder',
            ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        if (combined.aborted) { void result.body?.cancel().catch(() => {}); throw new QoderError('oauth_aborted'); }
        return result;
      }, combined);
      combined.throwIfAborted();
      if (pending && response.status === 404) { void response.body?.cancel().catch(() => {}); return undefined; }
      if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new QoderError(`oauth_http_${response.status}`); }
      reader = response.body?.getReader();
      if (!reader) throw new QoderError('oauth_response_invalid');
      let size = 0; const chunks = [];
      for (;;) {
        const { value, done } = await abortable(() => reader.read(), combined);
        combined.throwIfAborted();
        if (done) break;
        size += value.length;
        if (size > MAX_BODY) throw new QoderError('oauth_response_oversized');
        chunks.push(value);
      }
      let data;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new QoderError('oauth_response_invalid'); }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new QoderError('oauth_response_invalid');
      return data;
    } catch (e) {
      if (combined.aborted) throw new QoderError(signal?.aborted ? 'oauth_aborted' : 'oauth_request_unknown');
      if (e instanceof QoderError) throw e;
      // Do not include fetch errors (which may contain verifier URLs or headers).
      throw new QoderError(signal?.aborted ? 'oauth_aborted' : 'oauth_request_unknown');
    } finally {
      clearTimeout(timer);
      if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
  }
  async function userInfo(access, signal) {
    const d = await request('/api/v1/userinfo', { token: access, signal });
    const uid = d.id ?? d.user_id ?? d.uid;
    const org = d.orgId ?? d.organization_id ?? d.organization?.id ?? '';
    if (!identity(uid) || (org !== '' && !identity(org))) throw new QoderError('oauth_identity_invalid');
    return { uid: String(uid), org: String(org) };
  }
  async function credential(data, machineId, signal, previous) {
    const access = data.token ?? data.device_token;
    if (!text(access) || !text(data.refresh_token)) throw new QoderError('oauth_response_invalid');
    const timestamp = now();
    const expires = expiry(data.expires_at, data.expires_in, timestamp) - 60000;
    const refreshExpires = expiry(data.refresh_token_expires_at, data.refresh_token_expires_in, timestamp);
    const user = await userInfo(access, signal);
    if (data.user_id !== undefined && String(data.user_id) !== user.uid) throw new QoderError('oauth_identity_mismatch');
    if (previous && (previous.uid !== user.uid || previous.org !== user.org)) throw new QoderError('oauth_identity_mismatch');
    signal?.throwIfAborted();
    return { type: 'oauth', qoderAuthVersion: 1, access, refresh: data.refresh_token, expires, refreshExpires,
      machineId, ...user, fingerprint: fingerprint(machineId, user.uid, user.org) };
  }
  return {
    name: 'Qoder browser login',
    async login(interaction) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 300000);
      const signal = interaction.signal ? AbortSignal.any([interaction.signal, controller.signal]) : controller.signal;
      try {
        signal.throwIfAborted();
        const verifier = randomBytes(32).toString('base64url');
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        const nonce = randomUUID(), machineId = randomUUID();
        const query = new URLSearchParams({ challenge, challenge_method: 'S256', nonce, machine_id: machineId, client_id: DEVICE_CLIENT_ID });
        interaction.notify({ type: 'info', message: 'Qoder browser login credentials are stored by rotom/Pi, never in Qoder CLI. A fresh login requires a new Qoder session; refresh preserves binding.' });
        interaction.notify({ type: 'auth_url', url: `${LOGIN_URL}?${query}`, instructions: 'Complete Qoder account authorization in your browser. This link expires in five minutes.' });
        const poll = '/api/v1/deviceToken/poll?' + new URLSearchParams({ nonce, verifier, challenge_method: 'S256' });
        for (;;) {
          signal.throwIfAborted();
          const data = await request(poll, { signal, pending: true });
          if (data) return await credential(data, machineId, signal);
          await sleep(1000, undefined, { signal });
        }
      } catch (e) {
        if (controller.signal.aborted) throw new QoderError('oauth_login_timeout');
        if (signal.aborted) throw new QoderError('oauth_aborted');
        if (e instanceof QoderError) throw e;
        throw new QoderError('oauth_login_failed');
      } finally { clearTimeout(timer); }
    },
    async refresh(c, signal) {
      validate(c, now(), false);
      if (signal?.aborted) throw new QoderError('oauth_aborted');
      if (c.refreshExpires <= now() + 60000) throw new QoderError('oauth_login_required');
      if (!claimRefresh) throw new QoderError('oauth_refresh_guard_unavailable');
      // The durable one-shot claim survives cancellation, crashes, failed Pi
      // persistence, and process restarts. Never retry an already-used token.
      await claimRefresh(c.refresh);
      try {
        const data = await request('/api/v1/deviceToken/refresh', { signal, body: { refresh_token: c.refresh } });
        if (data.refresh_token === c.refresh) throw new QoderError('oauth_nonrotating_refresh_login_required');
        return await credential(data, c.machineId, signal, c);
      } catch { throw new QoderError('oauth_refresh_unproven_login_required'); }
    },
  };
}
