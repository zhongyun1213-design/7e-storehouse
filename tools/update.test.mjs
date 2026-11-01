// 自动更新的验收：模拟「发版」——改 version.js，然后只做一次普通刷新，
// 断言页面已经跑的是新版本，证明不需要重新添加到主屏幕。
// 用法：先起 http://127.0.0.1:4173 和 Chrome 的 9222，再 node tools/update.test.mjs

import { readFileSync, writeFileSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173/';
const VERSION_FILE = new URL('../version.js', import.meta.url);
const original = readFileSync(VERSION_FILE, 'utf8');

const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = targets.find((t) => t.type === 'page' && (t.url.startsWith(BASE) || t.url.includes('4173'))) || targets.find((t) => t.type === 'page');
if (!page) throw new Error('找不到 Chrome 页面');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});
let msgId = 0;
const pending = new Map();
const errors = [];
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  }
  if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.text || 'exception');
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
  if (res.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(res.exceptionDetails).slice(0, 400));
  return res.result.value;
}
async function waitFor(expression, label, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await ev(expression)) return true;
    await sleep(150);
  }
  throw new Error('等待超时: ' + label);
}
function assert(cond, message) {
  if (!cond) throw new Error('断言失败: ' + message);
  console.log('  PASS ' + message);
}

await send('Page.enable');
await send('Runtime.enable');
await send('Page.bringToFront');

console.log('· 装好旧版本');
await send('Page.navigate', { url: BASE });
await sleep(2000);
await ev(`(async () => {
  for (const reg of await navigator.serviceWorker.getRegistrations()) await reg.unregister();
  for (const key of await caches.keys()) await caches.delete(key);
  return true;
})()`);
await send('Page.reload', { ignoreCache: true });
await waitFor(`document.getElementById('aboutLine') && document.getElementById('aboutLine').textContent.includes('PolyU')`, '页面启动');
await waitFor(`navigator.serviceWorker.getRegistration().then(r => !!(r && r.active))`, 'Service Worker 激活', 20000);
const before = await ev(`document.getElementById('aboutLine').textContent`);
console.log('  当前版本：' + before);
assert(before.includes(original.match(/BUILD = '([^']+)'/)[1]), '页面显示的是磁盘上这一版');

console.log('· 模拟发版：改 version.js');
const stamp = 'TEST-' + Date.now();
writeFileSync(VERSION_FILE, original.replace(/BUILD = '[^']+'/, `BUILD = '${stamp}'`), 'utf8');
await sleep(1200); // 本地服务器按秒判 Last-Modified，等一秒再刷新才像真实发版

try {
  console.log('· 只做一次普通刷新（相当于从主屏幕点开一次）');
  await send('Page.reload');
  await waitFor(`document.getElementById('aboutLine') && document.getElementById('aboutLine').textContent.includes(${JSON.stringify(stamp)})`, '一次刷新后变成新版', 20000);
  assert(true, '一次刷新就拿到了新版本，没有要求重新添加到主屏幕');

  const after = await ev(`document.getElementById('aboutLine').textContent`);
  console.log('  现在版本：' + after);
} finally {
  console.log('· 还原版本号');
  writeFileSync(VERSION_FILE, original, 'utf8');
}

await sleep(1200);
await send('Page.reload');
await waitFor(`document.getElementById('aboutLine').textContent.includes(${JSON.stringify(original.match(/BUILD = '([^']+)'/)[1])})`, '还原成功', 20000);
assert(true, '还原后同样一次刷新生效');

assert(errors.length === 0, '没有页面异常（' + errors.join(' | ') + '）');
console.log('\n全部通过：更新靠一次打开完成。');
ws.close();
