// 真机推送的端到端验收（不花钱、不需要 Cloudflare）：
// 1) 起一个本地「Worker」——直接跑 worker/src/index.js 的那份代码，KV 用内存 Map
// 2) 用真实 Chrome 订阅 Web Push（FCM 真端点），把订阅 POST 给本地 Worker
// 3) 让 Worker 真的把推送发到 FCM，Chrome 收到后能读回通知 → 证明加密、VAPID、载荷全对
// 用法：先起 http://127.0.0.1:4173 和 Chrome 的 9222，再 node tools/push-e2e.mjs

import http from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import worker, { runDue } from '../worker/src/index.js';

const BASE = 'http://127.0.0.1:4173/';
const PORT = 8788;
const SHOT = new URL('../shots/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const vapid = JSON.parse(readFileSync(new URL('./.vapid.json', import.meta.url), 'utf8'));

class MemoryKV {
  constructor() { this.map = new Map(); }
  async get(key) { return this.map.has(key) ? this.map.get(key) : null; }
  async put(key, value) { this.map.set(key, String(value)); }
  async delete(key) { this.map.delete(key); }
  async list({ prefix = '' } = {}) {
    return { keys: [...this.map.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) };
  }
}

const SUBS = new MemoryKV();
const SENT = new MemoryKV();
const env = {
  SUBS,
  SENT,
  GH_GIST: 'fake-gist',
  GH_TOKEN: 'fake-token',
  VAPID_PRIVATE_JWK: vapid.privateJwk,
  VAPID_SUBJECT: 'mailto:test@example.com'
};

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(`http://127.0.0.1:${PORT}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : body
  });
  const response = await worker.fetch(request, env);
  const headers = {};
  response.headers.forEach((value, name) => { headers[name] = value; });
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

let closed = false;
function shutdown(code) {
  if (closed) return;
  closed = true;
  server.close();
  process.exit(code);
}
process.on('uncaughtException', (err) => { console.error('未捕获异常', err); shutdown(1); });
process.on('unhandledRejection', (err) => { console.error('未处理拒绝', err); shutdown(1); });

const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = targets.find((t) => t.type === 'page' && (t.url.includes('4173') || t.url.includes('127.0.0.1'))) || targets.find((t) => t.type === 'page');
if (!page) throw new Error('找不到 Chrome 页面');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});
let msgId = 0;
const pending = new Map();
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++msgId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('CDP 超时 ' + method)); } }, 30000);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ev(expression) {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (res.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(res.exceptionDetails).slice(0, 500));
  return res.result.value;
}
async function waitFor(expression, label, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await ev(expression)) return true;
    await sleep(200);
  }
  throw new Error('等待超时: ' + label);
}
function assert(cond, message) {
  if (!cond) throw new Error('断言失败: ' + message);
  console.log('  PASS ' + message);
}
async function click(selector) {
  const rect = await ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!rect) throw new Error('找不到 ' + selector);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, pointerType: 'mouse', clickCount: type === 'mouseMoved' ? 0 : 1 });
    await sleep(50);
  }
  await sleep(250);
}
async function shot(name) {
  const res = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(SHOT + name + '.png', Buffer.from(res.data, 'base64'));
  console.log('  → shots/' + name + '.png');
}

mkdirSync(SHOT, { recursive: true });
await send('Page.enable');
await send('Runtime.enable');

console.log('· 准备页面');
await send('Page.bringToFront');
await send('Page.navigate', { url: BASE });
await sleep(2000);
await ev(`(async () => {
  for (const reg of await navigator.serviceWorker.getRegistrations()) await reg.unregister();
  for (const key of await caches.keys()) await caches.delete(key);
  localStorage.clear();
  localStorage.setItem('polyu-push-worker', 'http://127.0.0.1:${PORT}');
  return true;
})()`);
await send('Browser.grantPermissions', { origin: 'http://127.0.0.1:4173', permissions: ['notifications'] });
await send('Page.reload', { ignoreCache: true });
await sleep(1500);
await send('Page.bringToFront');
await waitFor(`document.getElementById('heroTitle') && document.getElementById('heroTitle').textContent !== '正在读取清单…'`, '应用启动');
await sleep(500);
assert((await ev(`Notification.permission`)) === 'granted', '通知权限已给');

console.log('· 在设置里开启推送');
await click('#settingsBtn');
await waitFor(`document.getElementById('settingsDialog').open`, '设置弹窗');
await click('#pushToggleBtn');
await waitFor(`document.getElementById('pushStatus').textContent.includes('已开启')`, '界面显示已开启', 30000);
const subsCount = (await SUBS.list({ prefix: 'sub:' })).keys.length;
assert(subsCount === 1, 'Worker 收到并保存了 1 个订阅');
// 刚订阅完的那几秒，Chrome 和 FCM 的连接还在握手，第一条消息容易丢；
// 线上是每分钟一轮 cron，丢了下一轮会补，这里等一下再发。
await sleep(6000);

console.log('· Worker 发一条测试推送，Chrome 收到');
const swLogs = [];
let swWs = null;
try {
  const swTarget = (await (await fetch('http://127.0.0.1:9222/json/list')).json()).find((t) => t.type === 'service_worker' && t.url.includes('sw.js'));
  if (swTarget) {
    swWs = new WebSocket(swTarget.webSocketDebuggerUrl);
    await new Promise((r) => swWs.addEventListener('open', r, { once: true }));
    let swId = 0;
    swWs.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.method === 'Runtime.exceptionThrown') swLogs.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
      if (m.method === 'Runtime.consoleAPICalled') swLogs.push(m.params.type + ': ' + m.params.args.map((a) => a.value || a.description || '').join(' '));
      if (m.id) { /* ignore */ }
      if (m.method === 'Runtime.consoleAPICalled' || m.method === 'Runtime.exceptionThrown') return;
    });
    swWs.send(JSON.stringify({ id: ++swId, method: 'Runtime.enable', params: {} }));
    swWs.send(JSON.stringify({ id: ++swId, method: 'Log.enable', params: {} }));
  }
} catch (err) {
  console.log('  （没接上 Service Worker 调试口：' + err.message + '）');
}

let testRes = null;
let seen = false;
for (let attempt = 1; attempt <= 3 && !seen; attempt += 1) {
  testRes = await (await fetch(`http://127.0.0.1:${PORT}/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
  console.log(`  第 ${attempt} 次发送 → ` + JSON.stringify(testRes));
  try {
    await waitFor(`navigator.serviceWorker.ready.then(r => r.getNotifications()).then(ns => ns.some(n => n.title.includes('测试推送')))`, '页面收到测试通知', 15000);
    seen = true;
  } catch (err) {
    seen = false;
  }
}
assert(testRes.ok === true, '推送被 FCM 接受');
if (!seen) {
  const state = await ev(`navigator.serviceWorker.ready.then(async (r) => ({ notes: (await r.getNotifications()).map(n => ({ title: n.title, body: n.body })), scope: r.scope, active: !!r.active, pushSub: !!(await r.pushManager.getSubscription()) }))`);
  console.log('  诊断：' + JSON.stringify(state));
  console.log('  SW 日志：' + JSON.stringify(swLogs));
  throw new Error('断言失败: Chrome 一直没收到测试推送');
}
assert(true, 'Chrome 侧读到了「测试推送」通知');

console.log('· 走真正的到点逻辑（Gist 用假数据替身）');
const now = Date.now();
const pad = (n) => String(n).padStart(2, '0');
const remindAt = now - 30 * 1000; // 30 秒前就该提醒
const deadline = new Date(remindAt + 5 * 60000);
const deadlineHKT = new Date(deadline.getTime() + 8 * 3600 * 1000);
const dateHKT = `${deadlineHKT.getUTCFullYear()}-${pad(deadlineHKT.getUTCMonth() + 1)}-${pad(deadlineHKT.getUTCDate())}`;
const timeHKT = `${pad(deadlineHKT.getUTCHours())}:${pad(deadlineHKT.getUTCMinutes())}`;
const fakeState = {
  version: 2,
  items: [{ id: 'it-push-1', title: '推送自检作业', date: dateHKT, time: timeHKT, lead: 5, done: false, createdAt: now, updatedAt: now }],
  memos: [],
  tombstones: { items: {}, memos: {} }
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('https://api.github.com/gists/')) {
    return new Response(JSON.stringify({ files: { 'polyu-memo.json': { content: JSON.stringify(fakeState), truncated: false } } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(input, init);
};
const first = await runDue(env, now);
globalThis.fetch = realFetch;
console.log('  runDue → ' + JSON.stringify(first));
assert(first.sent === 1, '到点条目被推送出去');
await waitFor(`navigator.serviceWorker.ready.then(r => r.getNotifications()).then(ns => ns.some(n => n.body.includes('推送自检作业')))`, '页面收到到点提醒', 30000);
assert(true, 'Chrome 侧读到了「推送自检作业」');

console.log('· 同一分钟重跑不会再推一次');
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('https://api.github.com/gists/')) {
    return new Response(JSON.stringify({ files: { 'polyu-memo.json': { content: JSON.stringify(fakeState), truncated: false } } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(input, init);
};
const second = await runDue(env, now + 5000);
globalThis.fetch = realFetch;
console.log('  runDue(再次) → ' + JSON.stringify(second));
assert(second.sent === 0 && second.skipped === 1, '去重生效，没有重复推送');

const notes = await ev(`navigator.serviceWorker.ready.then(r => r.getNotifications()).then(ns => ns.map(n => ({ title: n.title, body: n.body })))`);
console.log('  当前通知：' + JSON.stringify(notes));
assert(notes.length >= 2, '页面上有两类通知');
await shot('push-desktop');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await click('#settingsBtn');
await sleep(700);
await shot('push-mobile');
await send('Emulation.clearDeviceMetricsOverride');

console.log('\n全部通过：真实 FCM 通道收到加密推送，到点逻辑与去重都正常。');
ws.close();
shutdown(0);
