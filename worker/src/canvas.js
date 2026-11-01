// Canvas 日历订阅（.ics）解析：只取作业类事件，换算成备忘录条目。
// 订阅地址本身是凭证，所以它只放在 Worker 的 secret 里，不进仓库、不进前端。

const HKT_OFFSET = 8 * 3600 * 1000;

function unfold(text) {
  return String(text || '').replace(/\r?\n[ \t]/g, '');
}

function field(chunk, name) {
  // DTSTART 可能带参数，例如 DTSTART;VALUE=DATE:20261011
  const match = new RegExp(`^${name}(?:;[^:]*)?:(.*)$`, 'm').exec(chunk);
  return match ? match[1].trim() : '';
}

/** 把 20261006T060000Z / 20261011 / 20261006T140000+0800 解析成时间戳 */
export function parseIcsDate(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  let match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z|[+-]\d{2}:?\d{2})?$/.exec(value);
  if (match) {
    const [, y, mo, d, h, mi, s, zone] = match;
    const base = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
    if (zone === 'Z') return base;
    if (!zone) return base - HKT_OFFSET; // 没写时区就按香港时间理解
    const sign = zone[0] === '-' ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    const offset = (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60000;
    return base - sign * offset;
  }
  match = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (match) {
    const [, y, mo, d] = match;
    return Date.UTC(Number(y), Number(mo) - 1, Number(d));
  }
  return null;
}

export function parseIcsEvents(text) {
  const unfolded = unfold(text);
  return unfolded
    .split('BEGIN:VEVENT')
    .slice(1)
    .map((chunk) => chunk.split('END:VEVENT')[0])
    .map((chunk) => ({
      uid: field(chunk, 'UID'),
      start: field(chunk, 'DTSTART'),
      summary: field(chunk, 'SUMMARY'),
      description: field(chunk, 'DESCRIPTION'),
      url: field(chunk, 'URL')
    }))
    .filter((event) => event.uid);
}

/** "Assignment 1 [COMP2021_26271_A]" → { title: "Assignment 1", course: "COMP2021" } */
export function splitSummary(summary) {
  const raw = String(summary || '').trim();
  const match = /^(.*?)\s*\[([^\]]+)\]\s*$/.exec(raw);
  if (!match) return { title: raw, course: '' };
  const courseCode = match[2].split('_')[0] || '';
  return { title: match[1].trim(), course: courseCode.toUpperCase() };
}

function hktParts(timestamp) {
  const hkt = new Date(timestamp + HKT_OFFSET);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    date: `${hkt.getUTCFullYear()}-${pad(hkt.getUTCMonth() + 1)}-${pad(hkt.getUTCDate())}`,
    time: `${pad(hkt.getUTCHours())}:${pad(hkt.getUTCMinutes())}`
  };
}

/**
 * 从日历内容生成要写进备忘录的条目。
 * 只要作业事件；太老的（超过 7 天）不导，避免把往年作业翻出来。
 */
export function canvasItemsFromIcs(text, now = Date.now()) {
  const items = [];
  for (const event of parseIcsEvents(text)) {
    if (!event.uid.startsWith('event-assignment-')) continue;
    const due = parseIcsDate(event.start);
    if (due === null) continue;
    if (due < now - 7 * 86400000) continue;
    const { title, course } = splitSummary(event.summary);
    if (!title) continue;
    const { date, time } = hktParts(due);
    items.push({
      id: `cv-${event.uid.replace(/^event-assignment-/, '')}`,
      canvasUid: event.uid,
      title: course ? `${course} · ${title}` : title,
      date,
      // 只有日期没有时间的作业，就只按日期倒数，不设一个假的时间去推送
      time: /T\d{6}/.test(event.start) ? time : '',
      lead: 30,
      category: 'study',
      note: '来自 Canvas 作业日历',
      done: false,
      createdAt: now,
      updatedAt: now
    });
  }
  return items;
}

/**
 * 合并进现有清单：
 * - 已有同 id 的条目：只更新时间/日期，保留用户自己写的标题和备注（已完成也不再翻回未完成）
 * - 用户删过的（有墓碑）：不复活
 */
export function mergeCanvasItems(state, incoming, now = Date.now()) {
  const items = Array.isArray(state.items) ? state.items : [];
  const tombstones = (state.tombstones && state.tombstones.items) || {};
  const byId = new Map(items.map((item) => [item.id, item]));
  // 手动录入的老条目可能已经有一条同名作业，靠 canvasUid 认领，避免重复
  const byUid = new Map(items.filter((item) => item.canvasUid).map((item) => [item.canvasUid, item]));
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const fresh of incoming) {
    const existing = byId.get(fresh.id) || byUid.get(fresh.canvasUid);
    if (existing) {
      if (existing.done) {
        skipped += 1;
        continue;
      }
      const timeChanged = existing.date !== fresh.date || (existing.time || '') !== (fresh.time || '');
      if (timeChanged || !existing.canvasUid) {
        existing.date = fresh.date;
        if (fresh.time) existing.time = fresh.time;
        existing.canvasUid = fresh.canvasUid;
        existing.updatedAt = now;
        updated += 1;
      } else {
        skipped += 1;
      }
      byUid.set(fresh.canvasUid, existing);
      continue;
    }
    if (tombstones[fresh.id] && tombstones[fresh.id] >= fresh.updatedAt) {
      skipped += 1;
      continue;
    }
    items.push(fresh);
    byId.set(fresh.id, fresh);
    byUid.set(fresh.canvasUid, fresh);
    created += 1;
  }

  state.items = items;
  return { created, updated, skipped, total: incoming.length };
}
