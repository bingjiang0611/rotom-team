// COSY catalog authentication adapted from 9router's Qoder protocol description.
// Copyright (c) 2024-2026 decolua and contributors. MIT license: see
// rotom/THIRD_PARTY_NOTICES.md. No CLI/WASM runtime dependency.
import { constants, createCipheriv, createHash, publicEncrypt, randomUUID } from 'node:crypto';
import { QoderError } from './auth.mjs';

// Compatibility header observed in official CLI 1.1.45. Account catalog
// visibility (including Sonus) changes with this header; not rotom's version.
export const CATALOG_COMPAT_VERSION = '1.1.45';
export const CATALOG_URL = 'https://api2.qoder.sh/algo/api/v2/model/list?Encode=1';
const SIG_PATH = '/api/v2/model/list';
// Public server encryption key, not a credential or signing private key.
const SERVER_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;
const md5 = value => createHash('md5').update(value).digest('hex');
const field = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x20\x7f]/.test(value);

export function catalogHeaders(credential, { now = Date.now, platform = process.platform, arch = process.arch } = {}) {
  const { accessToken, uid, machineId, org = '' } = credential ?? {};
  if (!field(accessToken, 16384) || !field(uid, 512) || !field(machineId, 128) || (org !== '' && !field(org, 512))) throw new QoderError('catalog_identity_unavailable');
  try {
    const key = Buffer.from(randomUUID().slice(0, 16), 'ascii');
    let info, wrapped;
    try {
      const cipher = createCipheriv('aes-128-cbc', key, key);
      info = Buffer.concat([cipher.update(JSON.stringify({ uid, security_oauth_token: accessToken, name: '', aid: '', email: '' })), cipher.final()]).toString('base64');
      wrapped = publicEncrypt({ key: SERVER_KEY, padding: constants.RSA_PKCS1_PADDING }, key).toString('base64');
    } finally { key.fill(0); }
    const payload = Buffer.from(JSON.stringify({ version: 'v1', requestId: randomUUID(), info, cosyVersion: '1.0.0', ideVersion: '1.0.0' })).toString('base64');
    const timestamp = String(Math.floor(now() / 1000));
    const signature = md5(`${payload}\n${wrapped}\n${timestamp}\n\n${SIG_PATH}`);
    return {
      Authorization: `Bearer COSY.${payload}.${signature}`, Accept: 'application/json', 'Accept-Encoding': 'identity',
      'Cosy-Key': wrapped, 'Cosy-User': uid, 'Cosy-Date': timestamp, 'Cosy-Version': CATALOG_COMPAT_VERSION,
      'Cosy-Machineid': machineId, 'Cosy-Machinetoken': machineId, 'Cosy-Machinetype': '5',
      'Cosy-Machineos': `${arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : arch}_${platform === 'win32' ? 'windows' : platform}`,
      'Cosy-Clienttype': '5', 'Cosy-Clientip': '127.0.0.1', 'Cosy-Bodyhash': md5(''), 'Cosy-Bodylength': '0',
      'Cosy-Sigpath': SIG_PATH, 'Cosy-Data-Policy': 'disagree', 'Cosy-Organization-Id': org,
      'Cosy-Organization-Tags': '', 'Login-Version': 'v2', 'X-Request-Id': randomUUID(),
    };
  } catch { throw new QoderError('catalog_auth_unavailable'); }
}
