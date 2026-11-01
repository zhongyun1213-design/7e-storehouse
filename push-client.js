// 浏览器这一侧的 Web Push：订阅、退订、发给 Worker 登记、发测试推送。
import { PUSH_WORKER, PUSH_VAPID_PUBLIC_KEY } from './push-config.js';

const OVERRIDE_KEY = 'polyu-push-worker';

export function workerUrl() {
  let override = '';
  try {
    override = localStorage.getItem(OVERRIDE_KEY) || '';
  } catch (err) {
    override = '';
  }
  return String(override || PUSH_WORKER || '').replace(/\/+$/, '');
}

export function pushSupported() {
  return typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window;
}

export function isIOS() {
  return /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function isStandalone() {
  return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
}

export function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

async function readyRegistration() {
  if (!pushSupported()) throw new Error('这个浏览器不支持 Web Push');
  return navigator.serviceWorker.ready;
}

export async function currentSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  try {
    return await reg.pushManager.getSubscription();
  } catch (err) {
    return null;
  }
}

async function post(path, body) {
  const base = workerUrl();
  if (!base) throw new Error('推送服务还没部署好');
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(15000)
  });
  let data = null;
  try {
    data = await res.json();
  } catch (err) {
    data = null;
  }
  if (!res.ok) throw new Error((data && data.error) || `推送服务返回 ${res.status}`);
  return data;
}

export async function enablePush() {
  const base = workerUrl();
  if (!base) throw new Error('推送服务还没部署好，等 Worker 地址填上再开');
  if (isIOS() && !isStandalone()) throw new Error('iPhone 要先把应用添加到主屏幕，再从主屏幕打开，才能开推送');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('没有拿到通知权限');
  const reg = await readyRegistration();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(PUSH_VAPID_PUBLIC_KEY)
    });
  }
  await post('/sub', sub.toJSON());
  return sub;
}

export async function disablePush() {
  const sub = await currentSubscription();
  if (!sub) return false;
  const endpoint = sub.endpoint;
  try {
    await sub.unsubscribe();
  } catch (err) {
    /* 浏览器已经自己清掉了 */
  }
  try {
    await post('/unsub', { endpoint });
  } catch (err) {
    /* 服务端失败也先让本机断干净 */
  }
  return true;
}

export async function sendTestPush() {
  return post('/test', {});
}

/** 让 Worker 立刻拉一次 Canvas 作业日历 */
export async function triggerCanvasSync() {
  return post('/canvas', {});
}
