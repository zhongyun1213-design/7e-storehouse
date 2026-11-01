const CACHE = 'polyu-memo-v7';
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'version.js',
  'sync-core.js',
  'sync-link.js',
  'qrcode.js',
  'push-client.js',
  'push-config.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

// 代码类资源：网络优先，保证「打开一次就是新版本」。
const SHELL = /\.(?:js|css|webmanifest|json)$/;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 逐个 add，任何一个 404 都不会拖垮整次安装（整批 addAll 失败会让 iOS 一直卡在旧版本）
    await Promise.allSettled(ASSETS.map((url) => cache.add(new Request(url, { cache: 'no-cache' }))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

async function putInCache(request, response) {
  const copy = response.clone();
  const cache = await caches.open(CACHE);
  await cache.put(request, copy);
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(new Request(request, { cache: 'no-cache' }));
        if (response && response.ok) putInCache('index.html', response);
        return response;
      } catch (err) {
        const cached = await caches.match('index.html');
        return cached || Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = (await caches.match(request)) || (await caches.match(request, { ignoreSearch: true }));
    const network = fetch(new Request(request, { cache: 'no-cache' }))
      .then((response) => {
        if (response && response.ok) putInCache(request, response);
        return response;
      })
      .catch(() => null);

    if (SHELL.test(url.pathname)) {
      const fresh = await network;
      if (fresh) return fresh;
      return cached || Response.error();
    }
    return cached || (await network) || Response.error();
  })());
});

self.addEventListener('push', (event) => {
  let data = { title: 'PolyU 备忘录', body: '有新的提醒', tag: 'polyu-push', url: './' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch (err) {
    if (event.data) data.body = event.data.text();
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'PolyU 备忘录', {
      body: data.body || '',
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      tag: data.tag || 'polyu-push',
      data: { url: data.url || './' }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow(target);
    })
  );
});
