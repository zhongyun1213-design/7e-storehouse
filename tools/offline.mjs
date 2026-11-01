// 离线验证：切断网络后刷新，页面应完全由 Service Worker 缓存提供。
const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = targets.find((t) => t.type === 'page' && (t.url.includes('4173') || t.url.includes('7e-storehouse')))
  || targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
const send = (method, params = {}) => new Promise((resolve) => {
  const i = ++id;
  pending.set(i, resolve);
  ws.send(JSON.stringify({ id: i, method, params }));
});
const evalJS = async (expression) => {
  const m = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return m.result.result.value;
};

await send('Network.enable');
await send('Page.enable');
await send('Runtime.enable');

const before = await evalJS(`document.title`);
console.log('在线标题:', before);

await send('Network.emulateNetworkConditions', {
  offline: true,
  latency: 0,
  downloadThroughput: 0,
  uploadThroughput: 0
});
await send('Page.reload', { ignoreCache: false });
await new Promise((r) => setTimeout(r, 2500));

const state = await evalJS(`({
  title: document.title,
  hero: document.getElementById('heroTitle') ? document.getElementById('heroTitle').textContent : null,
  items: document.querySelectorAll('.item').length,
  memo: document.querySelectorAll('.memo').length,
  online: navigator.onLine
})`);
console.log('离线状态:', JSON.stringify(state));

await send('Network.emulateNetworkConditions', {
  offline: false,
  latency: 0,
  downloadThroughput: -1,
  uploadThroughput: -1
});

const ok = state.title.includes('PolyU') && state.hero && state.online === false;
console.log(ok ? '离线刷新通过' : '离线刷新失败');
ws.close();
process.exitCode = ok ? 0 : 1;
