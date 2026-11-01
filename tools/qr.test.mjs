// 扫码导入的端到端验收：
// 1) 在设置里填好同步 → 点「扫码导入到手机」→ 页面画出的二维码用独立解码器（jsQR）解回来
// 2) 用解出来的真实链接打开一次（模拟手机扫码）→ 配置被写进 localStorage、hash 被擦掉
// 3) 坏链接不会污染配置
// 用法：先起 http://127.0.0.1:4173 和 Chrome 的 9222 调试端口，再 node tools/qr.test.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const jsQR = require('D:/Apps/hkc-qrcheck/node_modules/jsqr/dist/jsQR.js');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173/';
const SHOT_DIR = new URL('../shots/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const TOKEN = 'github_pat_11TESTTEST0TESTTEST_TESTTESTTESTTESTTESTTESTTESTTESTTESTTESTTESTTESTTESTTEST';
const GIST = 'abc123def4567890abc123def4567890';

const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = targets.find((t) => t.type === 'page' && (t.url.startsWith(BASE) || t.url.includes('4173')))
  || targets.find((t) => t.type === 'page');
if (!page) throw new Error('找不到打开的页面，先启动 Chrome');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

let msgId = 0;
const pending = new Map();
const consoleErrors = [];

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
    else resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    consoleErrors.push('exception: ' + (msg.params.exceptionDetails?.text || 'unknown'));
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    consoleErrors.push('console.error: ' + msg.params.args.map((a) => a.value || a.description || '').join(' '));
  }
});

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error('CDP 超时: ' + method));
      }
    }, 30000);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evalJS(expression) {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (res.exceptionDetails) throw new Error('页面脚本异常: ' + JSON.stringify(res.exceptionDetails).slice(0, 600));
  return res.result.value;
}

async function waitFor(expression, message, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await evalJS(expression)) return true;
    await sleep(120);
  }
  throw new Error('等待超时: ' + message);
}

function assert(cond, message) {
  if (!cond) throw new Error('断言失败: ' + message);
  console.log('  PASS ' + message);
}

async function click(selector) {
  const rect = await evalJS(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!rect) throw new Error('找不到元素: ' + selector);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', {
      type,
      x: rect.x,
      y: rect.y,
      button: 'left',
      buttons: type === 'mousePressed' ? 1 : 0,
      pointerType: 'mouse',
      clickCount: type === 'mouseMoved' ? 0 : 1
    });
    await sleep(40);
  }
  await sleep(200);
}

async function type(selector, text) {
  await evalJS(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    el.focus();
    if (typeof el.select === 'function') el.select();
    return true;
  })()`);
  await send('Input.insertText', { text });
  await sleep(80);
}

async function reload() {
  await send('Page.reload', { ignoreCache: true });
  await waitFor(`document.readyState === 'complete' && document.getElementById('heroTitle') && document.getElementById('heroTitle').textContent !== '正在读取清单…'`, '页面加载');
  await sleep(300);
}

async function shot(name) {
  const res = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(new URL(`../shots/${name}.png`, import.meta.url), Buffer.from(res.data, 'base64'));
  console.log('  → shots/' + name + '.png');
}

async function goto(url) {
  await send('Page.navigate', { url });
  await waitFor(`document.readyState === 'complete' && document.getElementById('heroTitle') && document.getElementById('heroTitle').textContent !== '正在读取清单…'`, '页面加载 ' + url);
  await sleep(500);
}

async function canvasPixels() {
  const payload = await evalJS(`(() => {
    const c = document.getElementById('qrCanvas');
    const ctx = c.getContext('2d');
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < data.length; i += CH) {
      bin += String.fromCharCode.apply(null, data.subarray(i, i + CH));
    }
    return { width: c.width, height: c.height, b64: btoa(bin) };
  })()`);
  const raw = Buffer.from(payload.b64, 'base64');
  return { width: payload.width, height: payload.height, data: new Uint8ClampedArray(raw) };
}

mkdirSync(SHOT_DIR, { recursive: true });
await send('Page.enable');
await send('Runtime.enable');

console.log('· 清掉旧的 Service Worker 和数据');
await send('Page.navigate', { url: BASE });
await sleep(1200);
await evalJS(`(async () => {
  const regs = await navigator.serviceWorker.getRegistrations();
  for (const reg of regs) await reg.unregister();
  if (window.caches) { for (const key of await caches.keys()) await caches.delete(key); }
  localStorage.clear();
  return true;
})()`);
await reload();

console.log('· 在设置里填同步配置');
await click('#settingsBtn');
await waitFor(`document.getElementById('settingsDialog').open`, '设置弹窗打开');
await type('#syncToken', TOKEN);
await type('#syncGistId', GIST);
await click('#syncConnectBtn');
await sleep(2500);
const saved = await evalJS(`JSON.parse(localStorage.getItem('polyu-memo.v2')).settings.sync`);
assert(saved.token === TOKEN, 'token 已写进本地');
assert(saved.gistId === GIST, 'Gist ID 已写进本地');

console.log('· 点「扫码导入到手机」');
assert(await evalJS(`document.getElementById('qrBtn').getBoundingClientRect().height > 0`), '按钮是可见的');
await click('#qrBtn');
await waitFor(`!document.getElementById('qrPanel').hidden`, '二维码面板出现');
const size = await evalJS(`({ w: document.getElementById('qrCanvas').width, h: document.getElementById('qrCanvas').height })`);
assert(size.w > 100 && size.w === size.h, '画布已按二维码尺寸绘制（' + size.w + 'px）');
assert(await evalJS(`(() => { const c = document.getElementById('qrCanvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let dark = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 128) dark++; return dark > 1000; })()`), '画布上确实有黑色码点');
await shot('qr-panel');

console.log('· 用独立解码器把二维码解回来');
const photo = await canvasPixels();
const decoded = jsQR(photo.data, photo.width, photo.height);
assert(decoded && typeof decoded.data === 'string', 'jsQR 成功解出内容');
console.log('  解出：' + decoded.data);
const hash = decoded.data.split('#')[1] ? '#' + decoded.data.split('#')[1] : '';
assert(decoded.data.startsWith(BASE.replace(/\/$/, '') + '/#s='), '链接指向应用本体');
const parsed = /#s=([A-Za-z0-9_-]+)/.exec(decoded.data);
assert(!!parsed, '链接里带 s= 参数');
const payload = JSON.parse(Buffer.from(parsed[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
assert(payload.t === TOKEN, '二维码里的 token 与页面配置一致');
assert(payload.g === GIST, '二维码里的 Gist ID 与页面配置一致');
assert(payload.v === 1, '载荷版本是 1');

console.log('· 模拟手机扫码：用解出来的链接打开');
await evalJS(`localStorage.clear()`);
// 同一地址只改 hash 不会重新加载页面，所以先跳转、再真正刷新一次，等价手机冷启动
await send('Page.navigate', { url: decoded.data });
await sleep(400);
await reload();
const imported = await evalJS(`JSON.parse(localStorage.getItem('polyu-memo.v2')).settings.sync`);
assert(imported.token === TOKEN, '手机端导入 token 成功');
assert(imported.gistId === GIST, '手机端导入 Gist ID 成功');
assert((await evalJS(`location.hash`)) === '', '导入后 hash 被擦掉，链接不残留 token');
await waitFor(`document.getElementById('toast').textContent.includes('导入')`, '界面提示已导入', 5000);
assert((await evalJS(`document.getElementById('toast').classList.contains('show')`)) === true, '提示真的弹出来了');
await evalJS(`document.getElementById('settingsBtn').click()`);
await waitFor(`document.getElementById('settingsDialog').open`, '设置弹窗打开');
assert((await evalJS(`document.getElementById('syncToken').value`)) === TOKEN, '设置页回填了导入的 token');
await shot('qr-imported');

console.log('· 坏链接不污染配置');
await send('Page.navigate', { url: BASE.replace(/\/$/, '') + '/#s=broken-payload' });
await sleep(400);
await reload();
assert((await evalJS(`location.hash`)) === '', '坏链接的 hash 也被清掉');
const after = await evalJS(`JSON.parse(localStorage.getItem('polyu-memo.v2')).settings.sync`);
assert(after.token === TOKEN, '坏链接没有覆盖已有 token');

console.log('· 关掉设置时二维码消失');
await click('#settingsBtn');
await waitFor(`document.getElementById('settingsDialog').open`, '设置弹窗打开');
await click('#qrBtn');
await waitFor(`!document.getElementById('qrPanel').hidden`, '二维码面板出现');
await click('#settingsDialog [data-close="settingsDialog"]');
await sleep(300);
assert(await evalJS(`document.getElementById('qrPanel').hidden`), '关闭设置后二维码被收起');

console.log('· 收尾');
assert(consoleErrors.length === 0, '没有页面报错（' + consoleErrors.join(' | ') + '）');
await evalJS(`localStorage.clear()`);
await reload();
console.log('\n全部通过：二维码可解码、导入生效、坏链接安全。');
ws.close();
