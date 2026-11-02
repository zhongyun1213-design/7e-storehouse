import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIcs } from '../worker/src/ics.js';

const state = {
  items: [
    { id: 'a', title: 'COMP 作业', date: '2026-11-10', time: '14:00', note: '交 PDF', done: false },
    { id: 'b', title: 'SQL 作业', date: '2026-11-08', done: false },
    { id: 'c', title: '已经交了', date: '2026-11-05', time: '09:00', done: true }
  ],
  memos: [
    { id: 'm1', title: '这周要办', remindAt: '2026-11-05T09:30', items: [{ id: 'x', text: '取快递', done: false }, { id: 'y', text: '买牙膏', done: true }] },
    { id: 'm2', title: '全勾完了', remindAt: '2026-11-06T09:30', items: [{ id: 'z', text: '做完', done: true }] }
  ]
};

test('生成的日历结构完整', () => {
  const ics = buildIcs(state, Date.UTC(2026, 10, 2));
  assert.ok(ics.startsWith('BEGIN:VCALENDAR'));
  assert.ok(ics.trimEnd().endsWith('END:VCALENDAR'));
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 3, '完成的不导出，全勾完的备忘也不导出');
});

test('带时间的截止日生成定时事件并提前 30 分钟提醒', () => {
  const ics = buildIcs(state, Date.UTC(2026, 10, 2));
  assert.match(ics, /UID:item-a@polyu-memo/);
  assert.match(ics, /DTSTART:20261110T060000Z/);
  const block = ics.split('BEGIN:VEVENT').find((chunk) => chunk.includes('UID:item-a@polyu-memo'));
  assert.match(block, /TRIGGER:-PT30M/);
});

test('只有日期的截止日生成全天事件', () => {
  const ics = buildIcs(state, Date.UTC(2026, 10, 2));
  assert.match(ics, /DTSTART;VALUE=DATE:20261108/);
  assert.match(ics, /DTEND;VALUE=DATE:20261109/);
});

test('备忘只带没勾的项，且不做提前提醒', () => {
  const ics = buildIcs(state, Date.UTC(2026, 10, 2));
  const block = ics.split('BEGIN:VEVENT').find((chunk) => chunk.includes('UID:memo-m1@polyu-memo'));
  assert.match(block, /SUMMARY:这周要办/);
  assert.match(block, /DESCRIPTION:取快递/);
  assert.doesNotMatch(block, /买牙膏/);
  assert.doesNotMatch(block, /VALARM/);
});

test('逗号和分号会被转义', () => {
  const ics = buildIcs({ items: [{ id: 'q', title: 'A,B;C', date: '2026-11-10', time: '10:00', done: false }], memos: [] }, 0);
  assert.match(ics, /SUMMARY:A\\,B\\;C/);
});
