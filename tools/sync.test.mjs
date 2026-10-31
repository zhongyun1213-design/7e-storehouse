import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeCollection, mergeStates, newerDigest } from '../sync-core.js';

const item = (id, updatedAt, extra = {}) => ({ id, title: id, date: '2026-11-10', updatedAt, ...extra });

test('同 id 取 updatedAt 较新的一份', () => {
  const local = [item('a', 100, { title: '本地旧' })];
  const remote = [item('a', 200, { title: '远端新' })];
  const out = mergeCollection(local, remote);
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].title, '远端新');
});

test('本地更新时保留本地', () => {
  const out = mergeCollection([item('a', 300, { title: '本地新' })], [item('a', 100, { title: '远端旧' })]);
  assert.equal(out.items[0].title, '本地新');
});

test('两边不同条目取并集', () => {
  const out = mergeCollection([item('a', 100)], [item('b', 100)]);
  assert.deepEqual(out.items.map((i) => i.id).sort(), ['a', 'b']);
});

test('删除墓碑会压掉更旧的远端副本', () => {
  const out = mergeCollection([], [item('a', 100)], { a: 150 }, {});
  assert.equal(out.items.length, 0);
});

test('删除之后又编辑过的条目会复活', () => {
  const out = mergeCollection([item('a', 400, { title: '复活' })], [], { a: 150 }, {});
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].title, '复活');
});

test('墓碑取两边最大值并保留', () => {
  const out = mergeCollection([], [], { a: 100 }, { a: 300 }, 1000);
  assert.equal(out.tombstones.a, 300);
});

test('超过 90 天的墓碑会被清理', () => {
  const now = 10_000_000_000;
  const old = now - 100 * 86400000;
  const fresh = now - 10 * 86400000;
  const out = mergeCollection([], [], { a: old, b: fresh }, {}, now);
  assert.equal(out.tombstones.a, undefined);
  assert.equal(out.tombstones.b, fresh);
});

test('mergeStates 不修改入参', () => {
  const local = { items: [item('a', 100)], memos: [{ id: 'm1', text: 'x', updatedAt: 100 }], tombstones: { items: {}, memos: {} } };
  const snapshot = JSON.parse(JSON.stringify(local));
  mergeStates(local, { items: [item('b', 200)], memos: [], tombstones: {} });
  assert.deepEqual(local, snapshot);
});

test('mergeStates 同时合并截止日和备忘', () => {
  const out = mergeStates(
    { items: [item('a', 100)], memos: [{ id: 'm1', text: '本地', updatedAt: 100 }], tombstones: {} },
    { items: [item('b', 100)], memos: [{ id: 'm2', text: '远端', updatedAt: 100 }], tombstones: {} }
  );
  assert.deepEqual(out.items.map((i) => i.id).sort(), ['a', 'b']);
  assert.deepEqual(out.memos.map((m) => m.id).sort(), ['m1', 'm2']);
  assert.equal(out.version, 2);
});

test('摘要取 generatedAt 较新的一份', () => {
  const older = { generatedAt: '2026-10-30T04:30:00.000Z', items: [] };
  const newer = { generatedAt: '2026-10-31T04:30:00.000Z', items: [{ subject: 'x' }] };
  assert.equal(newerDigest(older, newer), newer);
  assert.equal(newerDigest(newer, older), newer);
  assert.equal(newerDigest(null, older), older);
});
