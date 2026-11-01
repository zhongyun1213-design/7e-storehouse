// 同步配置的扫码/链接编解码。
// 纯函数，不碰 DOM，也不发网络请求，方便直接跑单测。

const PAYLOAD_VERSION = 1;
const HASH_PREFIX = '#s=';

function toBase64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value) {
  const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * 把 token 和 Gist ID 打包成手机可以直接打开的链接。
 * @param {string} baseUrl 应用根地址，例如 https://example.com/app/
 * @param {{token: string, gistId: string}} config
 * @returns {string}
 */
export function buildSyncLink(baseUrl, config) {
  const token = String((config && config.token) || '').trim();
  const gistId = String((config && config.gistId) || '').trim();
  if (!token || !gistId) throw new Error('缺少 token 或 Gist ID');
  const payload = toBase64Url(JSON.stringify({ v: PAYLOAD_VERSION, t: token, g: gistId }));
  const base = String(baseUrl || '').split('#')[0];
  return `${base}${HASH_PREFIX}${payload}`;
}

/**
 * 从 location.hash（或整条链接）里解出同步配置。解不出来就返回 null。
 * @param {string} hash
 * @returns {{token: string, gistId: string} | null}
 */
export function parseSyncHash(hash) {
  if (typeof hash !== 'string' || !hash) return null;
  const marker = hash.indexOf('#s=');
  if (marker === -1) return null;
  const raw = hash.slice(marker + HASH_PREFIX.length).split(/[&#]/)[0].trim();
  if (!raw) return null;
  try {
    const data = JSON.parse(fromBase64Url(raw));
    if (!data || data.v !== PAYLOAD_VERSION) return null;
    const token = typeof data.t === 'string' ? data.t.trim() : '';
    const gistId = typeof data.g === 'string' ? data.g.trim() : '';
    if (token.length < 8 || gistId.length < 8) return null;
    return { token, gistId };
  } catch (err) {
    return null;
  }
}

export const SYNC_HASH_PREFIX = HASH_PREFIX;
