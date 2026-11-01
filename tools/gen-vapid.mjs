// 生成一对 VAPID 密钥（P-256）。公钥进前端，私钥进 Worker 的 secret。
// 用法：node tools/gen-vapid.mjs
// 输出：tools/.vapid.json（已 gitignore），并把公钥打到屏幕上。

import { writeFileSync } from 'node:fs';

const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const raw = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
const jwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);

const b64url = (bytes) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const publicKey = b64url(raw);
const record = { publicKey, privateJwk: jwk, createdAt: new Date().toISOString() };
writeFileSync(new URL('./.vapid.json', import.meta.url), JSON.stringify(record, null, 2));

console.log('公钥（放进前端 PUSH_VAPID_PUBLIC_KEY）：');
console.log(publicKey);
console.log('');
console.log('私钥已写入 tools/.vapid.json，部署时用：');
console.log('  npx wrangler secret put VAPID_PRIVATE_JWK   # 粘贴 privateJwk 这一整段 JSON');
