// 纯函数：多设备合并逻辑。不碰 DOM，可以直接用 Node 测试。

const DAY = 86400000;

function tsOf(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 合并一个集合（截止日或备忘）。
 * 规则：同 id 取 updatedAt 较新的一份；删除用 tombstone（删除时间戳）压制旧数据；
 * 删除后又编辑过的条目会「复活」，因为它的 updatedAt 晚于删除时间。
 */
export function mergeCollection(localItems = [], remoteItems = [], localTomb = {}, remoteTomb = {}, now = Date.now()) {
  const tombstones = { ...(localTomb || {}) };
  for (const [id, ts] of Object.entries(remoteTomb || {})) {
    tombstones[id] = Math.max(tsOf(tombstones[id]), tsOf(ts));
  }

  const byId = new Map();
  for (const item of [...(localItems || []), ...(remoteItems || [])]) {
    if (!item || typeof item.id !== 'string' || !item.id) continue;
    const prev = byId.get(item.id);
    if (!prev || tsOf(item.updatedAt) > tsOf(prev.updatedAt)) byId.set(item.id, item);
  }

  const items = [];
  for (const item of byId.values()) {
    const deletedAt = tsOf(tombstones[item.id]);
    if (deletedAt && deletedAt >= tsOf(item.updatedAt)) continue;
    items.push(item);
  }

  const cutoff = now - 90 * DAY;
  const prunedTomb = {};
  for (const [id, ts] of Object.entries(tombstones)) {
    if (tsOf(ts) >= cutoff) prunedTomb[id] = tsOf(ts);
  }

  return { items, tombstones: prunedTomb };
}

export function newerDigest(a, b) {
  const at = tsOf(a && a.generatedAt ? Date.parse(a.generatedAt) : 0);
  const bt = tsOf(b && b.generatedAt ? Date.parse(b.generatedAt) : 0);
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;
  return bt > at ? b : a;
}

export function mergeStates(local, remote, now = Date.now()) {
  const l = local || {};
  const r = remote || {};
  const items = mergeCollection(l.items, r.items, l.tombstones && l.tombstones.items, r.tombstones && r.tombstones.items, now);
  const memos = mergeCollection(l.memos, r.memos, l.tombstones && l.tombstones.memos, r.tombstones && r.tombstones.memos, now);

  return {
    version: 2,
    items: items.items,
    memos: memos.items,
    tombstones: { items: items.tombstones, memos: memos.tombstones },
    digest: newerDigest(l.digest, r.digest),
    updatedAt: now
  };
}
