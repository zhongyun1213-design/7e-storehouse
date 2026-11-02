import { sendPush, parseSubscription } from './webpush.js';
import { canvasItemsFromIcs, mergeCanvasItems } from './canvas.js';
import { buildIcs } from './ics.js';

const HKT_OFFSET = 8 * 60 * 60 * 1000;
const CATCH_UP_MS = 5 * 60 * 1000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      // 这个 Worker 只服务单用户的静态前端，不带 cookie，所以放开跨域即可
      'access-control-allow-origin': '*'
    }
  });
}

function cors(origin) {
  return {
    'access-control-allow-origin': origin || '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400'
  };
}

function keyFor(endpoint) {
  return `sub:${b64Body(endpoint)}`;
}

function b64Body(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function listSubs(env) {
  const listed = await env.SUBS.list({ prefix: 'sub:' });
  const subs = [];
  for (const key of listed.keys) {
    const raw = await env.SUBS.get(key.name);
    if (!raw) continue;
    try {
      subs.push({ key: key.name, ...JSON.parse(raw) });
    } catch (err) {
      /* 坏数据直接跳过 */
    }
  }
  return subs;
}

export async function loadState(env) {
  const headers = { Authorization: `Bearer ${env.GH_TOKEN}`, 'User-Agent': 'polyu-memo-push', Accept: 'application/vnd.github+json' };
  const res = await fetch(`https://api.github.com/gists/${env.GH_GIST}`, { headers });
  if (!res.ok) throw new Error(`读取 Gist 失败 ${res.status}`);
  const gist = await res.json();
  const file = gist.files && gist.files['polyu-memo.json'];
  if (!file) throw new Error('Gist 里没有 polyu-memo.json');
  let content = file.content || '';
  if (file.truncated && file.raw_url) {
    const raw = await fetch(file.raw_url, { headers });
    content = await raw.text();
  }
  return JSON.parse(content);
}

export async function saveState(env, state) {
  const headers = {
    Authorization: `Bearer ${env.GH_TOKEN}`,
    'User-Agent': 'polyu-memo-push',
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json'
  };
  const res = await fetch(`https://api.github.com/gists/${env.GH_GIST}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ files: { 'polyu-memo.json': { content: JSON.stringify(state, null, 2) } } })
  });
  if (!res.ok) throw new Error(`写入 Gist 失败 ${res.status}`);
}

/** 拉一次 Canvas 作业日历，合并进 Gist。 */
export async function syncCanvas(env, now = Date.now()) {
  if (!env.CANVAS_ICS_URL) return { ok: false, reason: 'no-feed' };
  const res = await fetch(env.CANVAS_ICS_URL, {
    cache: 'no-store',
    headers: {
      // Canvas 的 WAF 会拦没有浏览器 UA 的请求（Cloudflare 出口容易被判成爬虫）
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      Accept: 'text/calendar,text/plain,*/*',
      'Accept-Language': 'zh-HK,zh;q=0.9,en;q=0.8'
    }
  });
  if (!res.ok) throw new Error(`拉取 Canvas 日历失败 ${res.status}`);
  const incoming = canvasItemsFromIcs(await res.text(), now);
  const state = await loadState(env);
  const result = mergeCanvasItems(state, incoming, now);
  if (result.created || result.updated) await saveState(env, state);
  return { ok: true, ...result };
}

/** 每天香港时间 7 点跑一次，用 KV 记当天已跑过。 */
async function maybeSyncCanvas(env, now = Date.now()) {
  if (!env.CANVAS_ICS_URL) return;
  const hkt = new Date(now + 8 * 3600 * 1000);
  if (hkt.getUTCHours() !== 7) return;
  const day = hkt.toISOString().slice(0, 10);
  const key = `canvas:${day}`;
  if (await env.SENT.get(key)) return;
  try {
    const result = await syncCanvas(env, now);
    await env.SENT.put(key, JSON.stringify(result), { expirationTtl: 7 * 86400 });
  } catch (err) {
    console.warn('canvas sync failed', String(err));
  }
}

/** 算出这一分钟该推哪些条目。纯函数，方便单测。 */
export function dueItems(state, now = Date.now()) {
  const items = Array.isArray(state && state.items) ? state.items : [];
  const out = [];
  for (const item of items) {
    if (!item || item.done) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item.date || '')) continue;
    if (!/^\d{2}:\d{2}$/.test(item.time || '')) continue;
    const lead = Number.isFinite(Number(item.lead)) ? Math.max(0, Number(item.lead)) : 30;
    const deadline = Date.parse(`${item.date}T${item.time}:00+08:00`);
    if (!Number.isFinite(deadline)) continue;
    const remindAt = deadline - lead * 60000;
    if (now < remindAt || now >= remindAt + CATCH_UP_MS) continue;
    out.push({ id: String(item.id || ''), title: String(item.title || '未命名'), date: item.date, time: item.time, lead, deadline, remindAt });
  }
  return out;
}

/** 备忘的「提醒时间」到点了没有。纯函数，方便单测。 */
export function dueMemos(state, now = Date.now()) {
  const memos = Array.isArray(state && state.memos) ? state.memos : [];
  const out = [];
  for (const memo of memos) {
    if (!memo || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(memo.remindAt || '')) continue;
    const pending = (memo.items || []).filter((item) => !item.done);
    if (!pending.length) continue; // 全勾完了就不提醒
    const at = Date.parse(`${memo.remindAt}:00+08:00`);
    if (!Number.isFinite(at)) continue;
    if (now < at || now >= at + CATCH_UP_MS) continue;
    out.push({
      id: String(memo.id || ''),
      at,
      title: String(memo.title || '').trim(),
      text: pending.map((item) => item.text).slice(0, 3).join('；')
    });
  }
  return out;
}

function payloadForMemo(memo) {
  return JSON.stringify({
    title: 'PolyU 备忘录 · 该做了',
    body: memo.title ? `${memo.title}：${memo.text}` : memo.text,
    tag: `polyu-memo-${memo.id}`,
    url: './'
  });
}

function payloadFor(item) {
  const when = item.time;
  return JSON.stringify({
    title: 'PolyU 备忘录 · 快到了',
    body: `${item.title}（今天 ${when} 截止，提前 ${item.lead} 分钟提醒）`,
    tag: `polyu-${item.id}`,
    url: './'
  });
}

export async function runDue(env, now = Date.now()) {
  const state = await loadState(env);
  const due = dueItems(state, now);
  const memoDue = dueMemos(state, now);
  const jobs = [
    ...due.map((item) => ({ key: `sent:${item.id}:${item.remindAt}`, payload: payloadFor(item) })),
    ...memoDue.map((memo) => ({ key: `sent:memo:${memo.id}:${memo.at}`, payload: payloadForMemo(memo) }))
  ];
  if (!jobs.length) return { checked: 0, sent: 0, skipped: 0 };
  const subs = await listSubs(env);
  if (!subs.length) return { checked: jobs.length, sent: 0, skipped: 0, reason: 'no-subscribers' };
  let sent = 0;
  let skipped = 0;
  for (const job of jobs) {
    if (await env.SENT.get(job.key)) {
      skipped += 1;
      continue;
    }
    let delivered = 0;
    for (const sub of subs) {
      try {
        const result = await sendPush(sub, job.payload, env.VAPID_PRIVATE_JWK, env.VAPID_SUBJECT || 'mailto:polyu-memo@example.com');
        if (result.ok) delivered += 1;
        else if (result.status === 404 || result.status === 410) await env.SUBS.delete(sub.key);
        else console.warn('push failed', result.status, result.error);
      } catch (err) {
        console.warn('push error', String(err));
      }
    }
    if (delivered > 0) {
      sent += 1;
      await env.SENT.put(job.key, String(now), { expirationTtl: 3 * 86400 });
    }
  }
  return { checked: jobs.length, sent, skipped };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });

    if (url.pathname === '/health') return json({ ok: true, subscribers: (await listSubs(env)).length });

    if (url.pathname === '/sub' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch (err) {
        return json({ ok: false, error: 'JSON 解析失败' }, 400);
      }
      try {
        const sub = parseSubscription(body);
        await env.SUBS.put(keyFor(sub.endpoint), JSON.stringify({ endpoint: sub.endpoint, keys: body.keys, addedAt: Date.now(), ua: request.headers.get('user-agent') || '' }));
        return json({ ok: true, subscribers: (await listSubs(env)).length });
      } catch (err) {
        return json({ ok: false, error: String(err.message || err) }, 400);
      }
    }

    if (url.pathname === '/unsub' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch (err) {
        return json({ ok: false, error: 'JSON 解析失败' }, 400);
      }
      const endpoint = String((body && body.endpoint) || '');
      if (!endpoint) return json({ ok: false, error: '缺少 endpoint' }, 400);
      await env.SUBS.delete(keyFor(endpoint));
      return json({ ok: true, subscribers: (await listSubs(env)).length });
    }

    if (url.pathname === '/test' && request.method === 'POST') {
      const subs = await listSubs(env);
      if (!subs.length) return json({ ok: false, error: '还没有订阅' }, 400);
      const payload = JSON.stringify({ title: 'PolyU 备忘录 · 测试推送', body: '这条推送走的是 Web Push，跟截止提醒同一条通道。', tag: 'polyu-test', url: './' });
      const results = [];
      for (const sub of subs) {
        try {
          const r = await sendPush(sub, payload, env.VAPID_PRIVATE_JWK, env.VAPID_SUBJECT || 'mailto:polyu-memo@example.com');
          results.push({ status: r.status, ok: r.ok });
          if (r.status === 404 || r.status === 410) await env.SUBS.delete(sub.key);
        } catch (err) {
          results.push({ status: 0, ok: false, error: String(err) });
        }
      }
      return json({ ok: results.some((r) => r.ok), results });
    }

    if (url.pathname === '/canvas' && request.method === 'POST') {
      try {
        return json(await syncCanvas(env));
      } catch (err) {
        return json({ ok: false, error: String(err.message || err) }, 500);
      }
    }

    if (url.pathname === '/calendar.ics') {
      const token = url.searchParams.get('t') || '';
      if (!env.CALENDAR_TOKEN || token !== env.CALENDAR_TOKEN) {
        return new Response('forbidden', { status: 403 });
      }
      try {
        const state = await loadState(env);
        return new Response(buildIcs(state), {
          headers: { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'no-store' }
        });
      } catch (err) {
        return new Response('error: ' + String(err.message || err), { status: 500 });
      }
    }

    return json({ ok: false, error: 'not found' }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDue(env).catch((err) => console.error('runDue failed', String(err))));
    ctx.waitUntil(maybeSyncCanvas(env));
  }
};
