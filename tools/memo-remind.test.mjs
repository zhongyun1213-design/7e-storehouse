import test from 'node:test';
import assert from 'node:assert/strict';
import { dueMemos } from '../worker/src/index.js';

const memo = (over = {}) => ({
  id: 'm1',
  title: '这周要办',
  remindAt: '2026-11-05T09:30',
  items: [{ id: 'a', text: '取快递', done: false }, { id: 'b', text: '买牙膏', done: true }],
  ...over
});

test('备忘到点会进提醒队列', () => {
  const at = Date.parse('2026-11-05T09:30:00+08:00');
  assert.equal(dueMemos({ memos: [memo()] }, at).length, 1);
  assert.equal(dueMemos({ memos: [memo()] }, at - 60000).length, 0, '没到点');
  assert.equal(dueMemos({ memos: [memo()] }, at + 6 * 60000).length, 0, '超过补发窗口');
});

test('全勾完的备忘不提醒', () => {
  const at = Date.parse('2026-11-05T09:30:00+08:00');
  const done = memo({ items: [{ id: 'a', text: '取快递', done: true }] });
  assert.equal(dueMemos({ memos: [done] }, at).length, 0);
});

test('没设提醒时间或时间坏掉的备忘不提醒', () => {
  const at = Date.parse('2026-11-05T09:30:00+08:00');
  assert.equal(dueMemos({ memos: [memo({ remindAt: '' })] }, at).length, 0);
  assert.equal(dueMemos({ memos: [memo({ remindAt: '2026/11/05 09:30' })] }, at).length, 0);
});

test('提醒正文只带没勾的项', () => {
  const at = Date.parse('2026-11-05T09:30:00+08:00');
  const [due] = dueMemos({ memos: [memo()] }, at);
  assert.equal(due.text, '取快递');
});
