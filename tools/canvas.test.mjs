import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIcsDate, parseIcsEvents, splitSummary, canvasItemsFromIcs, mergeCanvasItems } from '../worker/src/canvas.js';

// 折叠行 + 日期型 + UTC 时间型，模拟 Canvas 真实导出
const SAMPLE = `BEGIN:VCALENDAR\r
VERSION:2.0\r
BEGIN:VEVENT\r
DTSTAMP:20261010T065200Z\r
UID:event-assignment-25654\r
DTSTART:20261120T060000Z\r
SUMMARY:Assignment 1 [COMP2021_26271_A]\r
URL;VALUE=URI:https://canvas.example/courses/4405#assignment_25654\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:event-assignment-28193\r
DTSTART;VALUE=DATE:20261108\r
SUMMARY:Assignment2 - SQL Data Investiga\r
 tion [DSAI2202_26271_A]\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:event-12345\r
DTSTART:20261109T000000Z\r
SUMMARY:不是作业的日历事件\r
END:VEVENT\r
END:VCALENDAR\r
`;

test('日期解析：UTC 时间、纯日期、带时区写法', () => {
  assert.equal(parseIcsDate('20261010T060000Z'), Date.UTC(2026, 9, 10, 6, 0, 0));
  assert.equal(parseIcsDate('20261108'), Date.UTC(2026, 10, 8));
  assert.equal(parseIcsDate('20261006T140000+0800'), Date.UTC(2026, 9, 6, 6, 0, 0));
  assert.equal(parseIcsDate('坏数据'), null);
});

test('折叠行会被还原，事件字段能读到', () => {
  const events = parseIcsEvents(SAMPLE);
  assert.equal(events.length, 3);
  assert.equal(events[1].summary, 'Assignment2 - SQL Data Investigation [DSAI2202_26271_A]');
  assert.match(events[0].uid, /^event-assignment-/);
});

test('SUMMARY 拆出标题和课程代号', () => {
  assert.deepEqual(splitSummary('Assignment 1 [COMP2021_26271_A]'), { title: 'Assignment 1', course: 'COMP2021' });
  assert.deepEqual(splitSummary('随便写写'), { title: '随便写写', course: '' });
});

test('只导作业事件，换算成香港时间的日期和时间', () => {
  const now = Date.UTC(2026, 10, 1);
  const items = canvasItemsFromIcs(SAMPLE, now);
  assert.equal(items.length, 2, '非作业事件被过滤');
  const sql = items.find((item) => item.canvasUid === 'event-assignment-28193');
  assert.equal(sql.date, '2026-11-08');
  assert.equal(sql.time, '', '纯日期不造一个假时间');
  assert.equal(sql.title, 'DSAI2202 · Assignment2 - SQL Data Investigation');
  const first = items.find((item) => item.canvasUid === 'event-assignment-25654');
  assert.equal(first.date, '2026-11-20');
  assert.equal(first.time, '14:00', 'UTC 06:00 就是香港 14:00');
  assert.equal(first.category, 'study');
  assert.ok(first.id.startsWith('cv-'));
});

test('太老的作业不导入', () => {
  const now = Date.UTC(2027, 2, 1);
  assert.equal(canvasItemsFromIcs(SAMPLE, now).length, 0);
});

test('合并：新条目会加进去，重复的不重复加', () => {
  const now = Date.UTC(2026, 10, 1);
  const incoming = canvasItemsFromIcs(SAMPLE, now);
  const state = { items: [], tombstones: { items: {}, memos: {} } };
  const first = mergeCanvasItems(state, incoming, now);
  assert.deepEqual([first.created, first.updated], [2, 0]);
  const second = mergeCanvasItems(state, incoming, now + 1000);
  assert.deepEqual([second.created, second.updated], [0, 0]);
  assert.equal(state.items.length, 2);
});

test('已完成的作业不会被翻回未完成，标题也不会被覆盖', () => {
  const now = Date.UTC(2026, 10, 1);
  const incoming = canvasItemsFromIcs(SAMPLE, now);
  const sql = incoming.find((item) => item.canvasUid === 'event-assignment-28193');
  const state = {
    items: [{ ...sql, title: '我自己起的名字', done: true }],
    tombstones: { items: {}, memos: {} }
  };
  const result = mergeCanvasItems(state, incoming, now);
  assert.equal(result.created, 1);
  assert.equal(state.items[0].done, true);
  assert.equal(state.items[0].title, '我自己起的名字');
});

test('用户删掉的作业不会因为同步又冒出来', () => {
  const now = Date.UTC(2026, 10, 1);
  const incoming = canvasItemsFromIcs(SAMPLE, now);
  const id = incoming[0].id;
  const state = { items: [], tombstones: { items: { [id]: now + 5000 }, memos: {} } };
  const result = mergeCanvasItems(state, incoming, now);
  assert.equal(result.created, 1, '只加没被删的那一条');
  assert.equal(state.items.some((item) => item.id === id), false);
});

test('手动录入过的同一条作业会被认领，不会重复', () => {
  const now = Date.UTC(2026, 10, 1);
  const incoming = canvasItemsFromIcs(SAMPLE, now);
  const sql = incoming.find((item) => item.canvasUid === 'event-assignment-28193');
  const state = {
    items: [{ id: 'it-manual', title: 'SQL作业', date: '2025-01-01', time: '', canvasUid: sql.canvasUid, done: false, updatedAt: 1 }],
    tombstones: { items: {}, memos: {} }
  };
  const result = mergeCanvasItems(state, incoming, now);
  assert.equal(result.created, 1, '只新增没有对应条目的那条');
  assert.equal(result.updated, 1, '认领的那条被标记更新');
  assert.equal(state.items.length, 2);
  assert.equal(state.items.find((item) => item.id === 'it-manual').canvasUid, sql.canvasUid);
});

test('日期变了会更新，但保留用户标题', () => {
  const now = Date.UTC(2026, 10, 1);
  const incoming = canvasItemsFromIcs(SAMPLE, now);
  const target = incoming[0];
  const state = {
    items: [{ ...target, title: '我的标题', date: '2026-01-01', time: '00:00' }],
    tombstones: { items: {}, memos: {} }
  };
  const result = mergeCanvasItems(state, incoming, now);
  assert.equal(result.updated, 1);
  assert.equal(state.items[0].date, target.date);
  assert.equal(state.items[0].title, '我的标题');
});
