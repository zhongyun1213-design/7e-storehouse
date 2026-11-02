// 把清单生成 iCalendar（.ics）订阅源：截止日 + 带提醒时间的备忘。
// 只依赖标准字符串处理，Worker 和测试都能直接跑。

const HKT_OFFSET = 8 * 3600 * 1000;

function pad(value) {
  return String(value).padStart(2, '0');
}

function escapeText(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function utcStamp(timestamp) {
  const d = new Date(timestamp);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function dateOnly(value) {
  return value.replace(/-/g, '');
}

function nextDay(value) {
  const d = new Date(`${value}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

function eventBlock({ uid, stamp, start, end, summary, description, alarmMinutes }) {
  const lines = [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${utcStamp(stamp)}`,
    `DTSTART:${utcStamp(start)}`,
    `DTEND:${utcStamp(end)}`,
    `SUMMARY:${escapeText(summary)}`,
    `DESCRIPTION:${escapeText(description)}`
  ];
  if (alarmMinutes > 0) {
    lines.push(
      'BEGIN:VALARM',
      `TRIGGER:-PT${alarmMinutes}M`,
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeText(summary)}`,
      'END:VALARM'
    );
  }
  lines.push('END:VEVENT');
  return lines.join('\r\n');
}

function allDayBlock({ uid, stamp, date, summary, description }) {
  return [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${utcStamp(stamp)}`,
    `DTSTART;VALUE=DATE:${dateOnly(date)}`,
    `DTEND;VALUE=DATE:${nextDay(date)}`,
    `SUMMARY:${escapeText(summary)}`,
    `DESCRIPTION:${escapeText(description)}`,
    'BEGIN:VALARM',
    'TRIGGER:-PT9H',
    'ACTION:DISPLAY',
    `DESCRIPTION:${escapeText(summary)}`,
    'END:VALARM',
    'END:VEVENT'
  ].join('\r\n');
}

/**
 * 生成整份日历。
 * - 未完成的截止日：有具体时间就生成定时事件（提前 30 分钟提醒），只有日期就生成全天事件（当天 09:00 提醒）。
 * - 有提醒时间、还有没勾完的备忘：生成 15 分钟的事件。
 */
export function buildIcs(state, now = Date.now()) {
  const events = [];
  const items = Array.isArray(state && state.items) ? state.items : [];
  const memos = Array.isArray(state && state.memos) ? state.memos : [];

  for (const item of items) {
    if (!item || item.done) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item.date || '')) continue;
    const summary = String(item.title || '截止日').slice(0, 120);
    const description = item.note || '来自 PolyU 备忘录';
    if (/^\d{2}:\d{2}$/.test(item.time || '')) {
      const start = Date.parse(`${item.date}T${item.time}:00+08:00`);
      if (!Number.isFinite(start)) continue;
      events.push(eventBlock({
        uid: `item-${item.id}@polyu-memo`,
        stamp: now,
        start,
        end: start + 30 * 60000,
        summary,
        description,
        alarmMinutes: 30
      }));
    } else {
      events.push(allDayBlock({
        uid: `item-${item.id}@polyu-memo`,
        stamp: now,
        date: item.date,
        summary,
        description
      }));
    }
  }

  for (const memo of memos) {
    if (!memo || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(memo.remindAt || '')) continue;
    const pending = (memo.items || []).filter((entry) => entry && !entry.done).map((entry) => entry.text);
    if (!pending.length) continue;
    const start = Date.parse(`${memo.remindAt}:00+08:00`);
    if (!Number.isFinite(start)) continue;
    events.push(eventBlock({
      uid: `memo-${memo.id}@polyu-memo`,
      stamp: now,
      start,
      end: start + 15 * 60000,
      summary: memo.title || pending[0],
      description: pending.join('；'),
      alarmMinutes: 0
    }));
  }

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//PolyU Memo//ZH-HK',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:PolyU 备忘录',
    'X-WR-TIMEZONE:Asia/Hong_Kong',
    ...events,
    'END:VCALENDAR',
    ''
  ].join('\r\n');
}
