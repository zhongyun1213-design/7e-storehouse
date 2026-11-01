// 用 Chrome 自己的安装性检查，确认 PWA 可安装（manifest / service worker / 图标）。
const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes('7e-storehouse'))
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

await send('Page.enable');
const manifest = await send('Page.getAppManifest');
const install = await send('Page.getInstallabilityErrors');
console.log('manifest url:', manifest.result?.url);
console.log('manifest errors:', JSON.stringify(manifest.result?.errors || []));
console.log('installability errors:', JSON.stringify(install.result?.installabilityErrors || []));
ws.close();
