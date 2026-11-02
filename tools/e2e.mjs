// 端到端验收：通过 CDP 驱动真实 Chrome，模拟点击和输入，断言 DOM 状态。
// 用法：先启动 http://127.0.0.1:4173 和 Chrome 的 9222 调试端口，再 node tools/e2e.mjs

import { writeFileSync, mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173/';
const SHOT_DIR = new URL('../shots/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = targets.find((t) => t.type === 'page' && t.url.startsWith(BASE))
  || targets.find((t) => t.type === 'page' && (t.url.includes('4173') || t.url.includes('7e-storehouse')))
  || targets.find((t) => t.type === 'page');
if (!page) throw new Error('找不到打开的页面，先启动 Chrome 并访问 ' + BASE);

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
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    consoleErrors.push('log: ' + msg.params.entry.text);
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

async function waitFor(expression, message, timeout = 8000) {
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
  await sleep(150);
}

async function clickByText(selector, text) {
  const index = await evalJS(`(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
    return nodes.findIndex((n) => n.textContent.trim() === ${JSON.stringify(text)});
  })()`);
  if (index < 0) throw new Error(`找不到文本为「${text}」的元素`);
  const rect = await evalJS(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})][${index}];
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', {
      type,
      x: rect.x,
      y: rect.y,
      button: 'left',
      buttons: type === 'mousePressed' ? 1 : 0,
      pointerType: 'mouse',
      clickCount: 1
    });
    await sleep(40);
  }
  await sleep(150);
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

async function setValue(selector, value) {
  await evalJS(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value;
  })()`);
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

async function setViewport(width, height, mobile, scale = 2) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile });
  await sleep(350);
}

async function localDate(offset) {
  return evalJS(`(() => {
    const d = new Date();
    d.setDate(d.getDate() + ${Number(offset)});
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  })()`);
}

async function clearViewport() {
  await send('Emulation.clearDeviceMetricsOverride');
  await sleep(250);
}

mkdirSync(SHOT_DIR, { recursive: true });
await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');

console.log('· 打开页面');
await send('Page.navigate', { url: BASE });
await waitFor(`document.readyState === 'complete' && document.getElementById('heroTitle') && document.getElementById('heroTitle').textContent !== '正在读取清单…'`, '页面加载');
await evalJS('localStorage.clear()');
await reload();

console.log('· 空状态');
assert((await evalJS(`document.title`)).includes('PolyU'), '标题是 PolyU 备忘录');
assert((await evalJS(`document.getElementById('heroTitle').textContent`)) === '清单还是空的', '空状态英雄区文案正确');
assert((await evalJS(`document.querySelectorAll('.item').length`)) === 0, '还没有截止日');
assert((await evalJS(`document.getElementById('heroPill').hidden`)) === true, '空状态类别标签隐藏');

console.log('· 添加第一个截止日');
await click('#addBtn');
assert(await evalJS(`document.getElementById('editorDialog').open`), '编辑弹窗打开');
await type('#editTitle', '缴交下学期学费');
const date5 = await localDate(5);
await setValue('#editDate', date5);
await setValue('#editCategory', 'tuition');
await type('#editNote', '在 SIS 缴费');
await click('#editorForm button[type="submit"]');
await waitFor(`document.querySelectorAll('.item').length === 1`, '第一条进入列表');
assert((await evalJS(`document.querySelector('.item .item-title').textContent`)) === '缴交下学期学费', '标题正确');
assert((await evalJS(`document.getElementById('heroNum').textContent`)) === '5', '英雄区显示 5 天');

console.log('· 添加第二个截止日');
await click('#addBtn');
await type('#editTitle', '宿舍续住申请');
const date20 = await localDate(20);
await setValue('#editDate', date20);
await setValue('#editCategory', 'housing');
await click('#editorForm button[type="submit"]');
await waitFor(`document.querySelectorAll('.item').length === 2`, '第二条进入列表');
assert((await evalJS(`document.getElementById('heroNum').textContent`)) === '5', '最近的一件仍然是 5 天');

console.log('· 勾选完成 / 已完成分组');
await click('.item .check');
await waitFor(`document.querySelectorAll('.item').length === 1`, '完成的条目从列表隐藏');
assert((await evalJS(`document.getElementById('heroNum').textContent`)) === '20', '英雄区跳到 20 天');
await click('#toggleDoneBtn');
await waitFor(`document.querySelectorAll('.item').length === 2`, '展开后两条都在');
assert(await evalJS(`document.querySelector('.item.is-done') !== null`), '已完成条目有完成样式');
assert(await evalJS(`[...document.querySelectorAll('.group-title')].some(n => n.textContent.includes('已完成'))`), '出现已完成分组');

console.log('· 刷新后数据还在');
await reload();
assert((await evalJS(`document.querySelectorAll('.item').length`)) === 1, '已完成条目默认隐藏');
await click('#toggleDoneBtn');
assert((await evalJS(`document.querySelectorAll('.item').length`)) === 2, '展开后两条都在');
assert((await evalJS(`JSON.parse(localStorage.getItem('polyu-memo.v2')).items.length`)) === 2, 'localStorage 写入两条');

console.log('· 备忘');
await click('[data-tab="memos"]');
assert(await evalJS(`document.getElementById('view-memos').hidden === false`), '切换到备忘页');
assert((await evalJS(`document.querySelector('.memo-empty strong').textContent`)) === '还没有备忘', '备忘空状态');
await click('#addBtn');
assert(await evalJS(`document.getElementById('memoDialog').open`), '备忘弹窗打开');
await type('#memoItems input[type="text"]', '买打印机墨盒');
await click('#memoAddItem');
await type('#memoItems .memo-item-row:nth-child(2) input[type="text"]', '预约牙医');
await click('#memoForm button[type="submit"]');
await waitFor(`document.querySelectorAll('.memo').length === 1`, '备忘进入列表');
assert((await evalJS(`document.querySelectorAll('.memo .memo-item').length`)) === 2, '一条备忘里有两件事');
await click('.memo .memo-check');
await waitFor(`document.querySelector('.memo .memo-item').classList.contains('is-done')`, '勾掉一项');
assert((await evalJS(`document.querySelector('.memo-meta').textContent`)).includes('1/2'), '完成的项数统计正确');
await click('.memo');
await evalJS(`document.getElementById('memoPin').click()`);
await click('#memoForm button[type="submit"]');
await waitFor(`document.querySelector('.memo').classList.contains('pinned')`, '备忘置顶生效');
assert((await evalJS(`document.querySelector('.pin-flag') !== null`)) === true, '置顶标记可见');

console.log('· 备忘转成截止日');
await click('.memo');
await click('#memoToDeadlineBtn');
assert(await evalJS(`document.getElementById('editorDialog').open`), '转截止日弹窗打开');
assert((await evalJS(`document.getElementById('editTitle').value`)) === '买打印机墨盒', '标题带入备忘内容');
await click('#editorDialog [data-close]');
assert((await evalJS(`document.getElementById('editorDialog').open`)) === false, '弹窗可关闭');

console.log('· 邮件空状态');
await click('[data-tab="mail"]');
assert(await evalJS(`document.getElementById('view-mail').hidden === false`), '切换到邮件页');
assert((await evalJS(`document.querySelector('.mail-empty strong').textContent`)) === '邮件摘要还没接上', '邮件空状态文案');
await clickByText('button', '看接入步骤');
assert(await evalJS(`document.getElementById('mailSetupDialog').open`), '接入步骤弹窗打开');
await click('#mailSetupDialog [data-close]');

console.log('· 注入摘要数据后渲染');
const digest = await evalJS(`(() => {
  const s = JSON.parse(localStorage.getItem('polyu-memo.v2'));
  const iso = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toISOString().slice(0, 10); };
  s.digest = {
    generatedAt: new Date().toISOString(),
    mode: 'rules',
    items: [
      { subject: '2026/27 春季学期选课开始', from: 'REG <reg@polyu.edu.hk>', receivedAt: new Date().toISOString(), snippet: 'Add/Drop period opens next week, check your programme requirements.', tags: ['选课', '重要'], importance: 'high', suggestedDate: iso(6) },
      { subject: '税务局实习计划 2027 招生', from: 'CPS <cps@polyu.edu.hk>', receivedAt: new Date().toISOString(), snippet: 'Summer internship application deadline is approaching.', tags: ['实习'], importance: 'normal', suggestedDate: null }
    ]
  };
  localStorage.setItem('polyu-memo.v2', JSON.stringify(s));
  return { count: s.digest.items.length, suggested: s.digest.items[0].suggestedDate };
})()`);
assert(digest.count === 2, '写入了两条摘要');
await reload();
await click('[data-tab="mail"]');
await waitFor(`document.querySelectorAll('.mail-card').length === 2`, '摘要卡片渲染');
assert(await evalJS(`document.querySelector('.mail-card.high') !== null`), '重要邮件有高亮边');
assert((await evalJS(`document.getElementById('mailMeta').textContent`)).includes('2 封'), '摘要计数正确');
assert((await evalJS(`document.querySelector('.mail-card .tag').textContent`)) === '选课', '标签渲染');

console.log('· 从邮件建立截止日');
await click('.mail-card .mail-actions .btn');
await waitFor(`document.getElementById('editorDialog').open`, '截止日弹窗打开');
assert((await evalJS(`document.getElementById('editTitle').value`)).includes('选课'), '邮件标题带入');
assert((await evalJS(`document.getElementById('editDate').value`)) === digest.suggested, '邮件建议日期带入');
await click('#editorForm button[type="submit"]');
await waitFor(`JSON.parse(localStorage.getItem('polyu-memo.v2')).items.length === 3`, '新截止日写入');

console.log('· 深色主题');
await click('#settingsBtn');
await click('[data-theme-value="dark"]');
assert((await evalJS(`document.documentElement.dataset.theme`)) === 'dark', '切到深色');
await click('#settingsDialog [data-close]');
await reload();
assert((await evalJS(`document.documentElement.dataset.theme`)) === 'dark', '刷新后仍是深色');

console.log('· 同步报错路径（无效 token）');
await click('#settingsBtn');
await type('#syncToken', 'ghp_invalid_token_for_test_0000');
await type('#syncGistId', 'abcdef123456');
await click('#syncConnectBtn');
await waitFor(`document.getElementById('syncStatusText').textContent.includes('失败')`, '同步失败提示', 28000);
assert((await evalJS(`document.getElementById('syncDot').dataset.state`)) === 'error', '同步状态点变红');
assert((await evalJS(`document.getElementById('syncStatusText').textContent.includes('token') || document.getElementById('syncStatusText').textContent.includes('网络')`)), '失败原因可读');
await evalJS(`(() => { const s = JSON.parse(localStorage.getItem('polyu-memo.v2')); s.settings.sync = { token: '', gistId: '', lastSync: 0 }; localStorage.setItem('polyu-memo.v2', JSON.stringify(s)); return true; })()`);
await click('#settingsDialog [data-close]');
await reload();

console.log('· Service Worker / 离线缓存');
const sw = await evalJS(`navigator.serviceWorker.ready.then(r => !!r.active)`);
assert(sw, 'Service Worker 已激活');
const cacheInfo = await evalJS(`(async () => {
  const keys = await caches.keys();
  const cache = await caches.open(keys[0]);
  const reqs = await cache.keys();
  return {
    keys,
    count: reqs.length,
    hasApp: reqs.some(r => r.url.endsWith('app.js')),
    hasQr: reqs.some(r => r.url.endsWith('qrcode.js'))
  };
})()`);
assert(cacheInfo.hasApp, '缓存里有 app.js');
assert(cacheInfo.hasQr, '缓存里有二维码组件');
assert(cacheInfo.count >= 12, '缓存资产数量 ' + cacheInfo.count);

console.log('· 移动端布局');
await setViewport(390, 844, true);
await click('[data-tab="countdown"]');
await sleep(250);
await click('#settingsBtn');
await click('[data-theme-value="light"]');
await click('#settingsDialog [data-close]');
await sleep(250);
const overflow = await evalJS(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
assert(overflow <= 1, '手机宽度没有横向滚动');
await shot('mobile-countdown');
await click('[data-tab="memos"]');
await shot('mobile-memos');
await click('[data-tab="mail"]');
await shot('mobile-mail');
await click('[data-tab="countdown"]');
await click('#settingsBtn');
await setViewport(390, 844, true);
await shot('mobile-settings');
await click('#settingsDialog [data-close]');

console.log('· 桌面端布局');
await setViewport(1200, 900, false, 1);
await sleep(300);
await shot('desktop-countdown');
const desktopOverflow = await evalJS(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
assert(desktopOverflow <= 1, '桌面宽度没有横向滚动');
await clearViewport();

console.log('· 控制台错误');
const realErrors = consoleErrors.filter((e) => !/favicon/i.test(e) && !/status of 401/.test(e));
assert(realErrors.length === 0, '无脚本错误' + (realErrors.length ? '：' + realErrors.join(' | ') : ''));

ws.close();
console.log('\n全部通过');
