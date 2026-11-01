import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptPayload, vapidHeader, vapidPublicKey, b64url, fromB64url } from '../worker/src/webpush.js';
import { dueItems } from '../worker/src/index.js';

const encoder = new TextEncoder();

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
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

// 模拟手机端：自己生成一对密钥，再把服务端发来的 aes128gcm 请求体解开
async function makeReceiver() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    pair,
    publicKey,
    auth,
    subscription: { endpoint: 'https://push.example.test/abc', keys: { p256dh: b64url(publicKey), auth: b64url(auth) } }
  };
}

async function decryptAsReceiver(receiver, body) {
  const salt = body.subarray(0, 16);
  const recordSize = body.subarray(16, 20);
  const idLength = body[20];
  const keyId = body.subarray(21, 21 + idLength);
  const header = body.subarray(0, 21 + idLength);
  const cipher = body.subarray(21 + idLength);

  const asKey = await crypto.subtle.importKey('raw', keyId, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, receiver.pair.privateKey, 256));
  const ikm = await hkdf(receiver.auth, shared, concat(encoder.encode('WebPush: info\u0000'), receiver.publicKey, keyId), 32);
  const cek = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\u0000'), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\u0000'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  // aes128gcm 不传 AAD；传了 header 会变成「本地能解、浏览器解不开」
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, cipher));
  return { recordSize, plain };
}

test('加密后的载荷能被接收端正确解开', async () => {
  const receiver = await makeReceiver();
  const message = JSON.stringify({ title: 'PolyU 备忘录 · 快到了', body: 'COMP2021 作业（今天 23:00 截止）', tag: 'polyu-x' });
  const body = await encryptPayload(receiver.subscription, message);
  const { recordSize, plain } = await decryptAsReceiver(receiver, body);
  assert.deepEqual([...recordSize], [0, 0, 16, 0], '记录大小是 4096');
  assert.equal(plain[plain.length - 1], 2, '最后一条记录以 0x02 收尾');
  assert.equal(new TextDecoder().decode(plain.subarray(0, plain.length - 1)), message);
});

test('每次加密用的临时密钥和 salt 都不同', async () => {
  const receiver = await makeReceiver();
  const a = await encryptPayload(receiver.subscription, 'same');
  const b = await encryptPayload(receiver.subscription, 'same');
  assert.notDeepEqual([...a], [...b]);
  assert.notDeepEqual([...a.subarray(0, 16)], [...b.subarray(0, 16)]);
});

test('VAPID 头的 JWT 签名验得过，k= 就是公钥', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const header = await vapidHeader(privateJwk, 'https://fcm.googleapis.com/wp/abc', 'mailto:test@example.com');
  assert.match(header, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{80,}$/);

  const [tokenPart, keyPart] = header.replace('vapid ', '').split(', k=');
  const jwt = tokenPart.replace('t=', '');
  const [head, claims, signature] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(head, 'base64').toString()), { typ: 'JWT', alg: 'ES256' });
  const payload = JSON.parse(Buffer.from(claims, 'base64').toString());
  assert.equal(payload.aud, 'https://fcm.googleapis.com');
  assert.equal(payload.sub, 'mailto:test@example.com');
  assert.ok(payload.exp > Date.now() / 1000 + 3600);

  const verifyKey = await crypto.subtle.importKey('jwk', { ...privateJwk, d: undefined, key_ops: ['verify'] }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']).catch(() => null);
  const publicJwk = { kty: 'EC', crv: 'P-256', x: privateJwk.x, y: privateJwk.y };
  const key = verifyKey || (await crypto.subtle.importKey('jwk', publicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']));
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, fromB64url(signature), encoder.encode(`${head}.${claims}`));
  assert.equal(ok, true, '签名有效');
  assert.equal(keyPart, vapidPublicKey(privateJwk), 'k= 与私钥推导出的公钥一致');
});

test('VAPID 私钥以字符串形式传入也能用（Worker secret 就是字符串）', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const asString = await vapidHeader(JSON.stringify(jwk), 'https://web.push.apple.com/abc');
  const asObject = await vapidHeader(jwk, 'https://web.push.apple.com/abc');
  assert.match(asString, /^vapid t=/);
  assert.equal(asString.split(', k=')[1], asObject.split(', k=')[1]);
  await assert.rejects(() => vapidHeader(JSON.stringify({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }), 'https://x.test/'), /缺少 d/);
});

const baseItem = {
  id: 'it-1',
  title: '测试作业',
  date: '2026-11-01',
  time: '23:00',
  lead: 30,
  done: false
};

test('提前量到点就算到期', () => {
  const remindAt = Date.parse('2026-11-01T22:30:00+08:00');
  assert.equal(dueItems({ items: [baseItem] }, remindAt).length, 1);
  assert.equal(dueItems({ items: [baseItem] }, remindAt - 60000).length, 0, '还没到点');
});

test('漏跑几分钟也能补上，超过 5 分钟就不补了', () => {
  const remindAt = Date.parse('2026-11-01T22:30:00+08:00');
  assert.equal(dueItems({ items: [baseItem] }, remindAt + 4 * 60000).length, 1);
  assert.equal(dueItems({ items: [baseItem] }, remindAt + 6 * 60000).length, 0);
});

test('没有时间、已完成、日期坏掉的条目都不推', () => {
  const now = Date.parse('2026-11-01T22:30:00+08:00');
  assert.equal(dueItems({ items: [{ ...baseItem, time: '' }] }, now).length, 0);
  assert.equal(dueItems({ items: [{ ...baseItem, done: true }] }, now).length, 0);
  assert.equal(dueItems({ items: [{ ...baseItem, date: '2026/11/01' }] }, now).length, 0);
});

test('不填提前量就按默认 30 分钟算', () => {
  const item = { ...baseItem };
  delete item.lead;
  assert.equal(dueItems({ items: [item] }, Date.parse('2026-11-01T22:30:00+08:00')).length, 1);
});
