// Web Push 的协议实现：VAPID（RFC 8292）+ aes128gcm 载荷加密（RFC 8291）。
// 只依赖标准 WebCrypto 和 fetch —— Cloudflare Workers 和 Node 24 都能直接跑，
// 所以本地测试和线上跑的是同一份代码。

const encoder = new TextEncoder();

export function b64url(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < arr.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, arr.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(value) {
  const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function concat(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

/** 把订阅里的 p256dh / auth 解成字节，顺便校验格式。 */
export function parseSubscription(sub) {
  if (!sub || typeof sub.endpoint !== 'string' || !sub.keys) throw new Error('订阅缺少 endpoint 或 keys');
  const endpoint = new URL(sub.endpoint);
  if (endpoint.protocol !== 'https:') throw new Error('endpoint 必须是 https');
  const p256dh = fromB64url(sub.keys.p256dh);
  const auth = fromB64url(sub.keys.auth);
  if (p256dh.length !== 65 || p256dh[0] !== 4) throw new Error('p256dh 不是有效的 P-256 公钥');
  if (auth.length !== 16) throw new Error('auth secret 长度不对');
  return { endpoint: endpoint.toString(), p256dh, auth };
}

/** 按 RFC 8291 加密一条推送载荷，返回 aes128gcm 的完整请求体。 */
export async function encryptPayload(subscription, message) {
  const { p256dh, auth } = parseSubscription(subscription);
  const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', p256dh, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, ephemeral.privateKey, 256));

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const ikm = await hkdf(auth, shared, concat(encoder.encode('WebPush: info\u0000'), p256dh, asPublic), 32);
  const cek = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\u0000'), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\u0000'), 12);

  const recordSize = new Uint8Array([0, 0, 16, 0]); // 4096
  const keyIdLen = new Uint8Array([asPublic.length]); // 65
  const header = concat(salt, recordSize, keyIdLen, asPublic);

  const plaintext = concat(encoder.encode(message), new Uint8Array([2])); // 0x02 = 最后一条记录
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // aes128gcm 的 AEAD 不加附加数据（AAD）；header 只负责传 salt / rs / keyid。
  // 加了 AAD 的话 FCM 会收下（201），但浏览器解不开，通知静默丢掉。
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plaintext));
  return concat(header, cipher);
}

/** 从 VAPID 私钥 JWK 推出 65 字节公钥（b64url）。 */
export function vapidPublicKey(privateJwk) {
  const x = fromB64url(privateJwk.x);
  const y = fromB64url(privateJwk.y);
  return b64url(concat(new Uint8Array([4]), x, y));
}

/** 生成 Authorization 头：vapid t=<jwt>, k=<public key> */
export async function vapidHeader(privateJwk, endpoint, subject = 'mailto:noreply@example.com') {
  const aud = new URL(endpoint).origin;
  const signingInput = `${b64url(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))}.${b64url(
    encoder.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }))
  )}`;
  const key = await crypto.subtle.importKey('jwk', { ...privateJwk, key_ops: ['sign'] }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(signingInput)));
  return `vapid t=${signingInput}.${b64url(signature)}, k=${vapidPublicKey(privateJwk)}`;
}

/** 向一个订阅推送载荷。返回 { status, ok, error }。 */
export async function sendPush(subscription, message, vapidPrivateJwk, subject) {
  const body = await encryptPayload(subscription, message);
  const authorization = await vapidHeader(vapidPrivateJwk, subscription.endpoint, subject);
  const response = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '600',
      Urgency: 'high'
    },
    body
  });
  let error = '';
  if (!response.ok) {
    try {
      error = (await response.text()).slice(0, 200);
    } catch (err) {
      error = 'no body';
    }
  }
  return { status: response.status, ok: response.ok, error };
}
