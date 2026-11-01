import { sendPush, parseSubscription } from './webpush.js';

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
  if (!due.length) return { checked: 0, sent: 0, skipped: 0 };
  const subs = await listSubs(env);
  if (!subs.length) return { checked: due.length, sent: 0, skipped: 0, reason: 'no-subscribers' };
  let sent = 0;
  let skipped = 0;
  for (const item of due) {
    const dedupeKey = `sent:${item.id}:${item.remindAt}`;
    if (await env.SENT.get(dedupeKey)) {
      skipped += 1;
      continue;
    }
    const payload = payloadFor(item);
    let delivered = 0;
    for (const sub of subs) {
      try {
        const result = await sendPush(sub, payload, env.VAPID_PRIVATE_JWK, env.VAPID_SUBJECT || 'mailto:polyu-memo@example.com');
        if (result.ok) delivered += 1;
        else if (result.status === 404 || result.status === 410) await env.SUBS.delete(sub.key);
        else console.warn('push failed', result.status, result.error);
      } catch (err) {
        console.warn('push error', String(err));
      }
    }
    if (delivered > 0) {
      sent += 1;
      await env.SENT.put(dedupeKey, String(now), { expirationTtl: 3 * 86400 });
    }
  }
  return { checked: due.length, sent, skipped };
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

    return json({ ok: false, error: 'not found' }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDue(env).catch((err) => console.error('runDue failed', String(err))));
  }
};
