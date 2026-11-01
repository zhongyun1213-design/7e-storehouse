'use strict';

import { mergeStates } from './sync-core.js';
import { buildSyncLink, parseSyncHash } from './sync-link.js';

const STORAGE_KEY = 'polyu-memo.v2';
const LEGACY_KEY = 'hkcd.v1';
const DATA_FILE = 'polyu-memo.json';
const DIGEST_FILE = 'polyu-digest.json';
const MS_DAY = 86400000;

const CATEGORIES = {
  tuition: { label: '缴费', color: '#b42318' },
  calendar: { label: '校历', color: '#9d2235' },
  housing: { label: '住宿', color: '#0e7490' },
  visa: { label: '签证', color: '#a16207' },
  study: { label: '学业', color: '#6d28d9' },
  activity: { label: '活动', color: '#be185d' },
  internship: { label: '实习', color: '#047857' },
  life: { label: '生活', color: '#475569' }
};

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const $ = (id) => document.getElementById(id);

const els = {
  todayLabel: $('todayLabel'),
  syncDot: $('syncDot'),
  syncText: $('syncText'),
  settingsBtn: $('settingsBtn'),
  tabs: Array.from(document.querySelectorAll('.tabs button')),
  views: { countdown: $('view-countdown'), memos: $('view-memos'), mail: $('view-mail') },
  hero: $('hero'),
  heroPill: $('heroPill'),
  heroNum: $('heroNum'),
  heroUnit: $('heroUnit'),
  heroTitle: $('heroTitle'),
  heroMeta: $('heroMeta'),
  heroBar: $('heroBar'),
  heroNote: $('heroNote'),
  chips: $('categoryChips'),
  toggleDone: $('toggleDoneBtn'),
  list: $('list'),
  memoList: $('memoList'),
  memoCount: $('memoCount'),
  mailList: $('mailList'),
  mailMeta: $('mailMeta'),
  refreshMailBtn: $('refreshMailBtn'),
  mailDot: $('mailDot'),
  addBtn: $('addBtn'),
  editorDialog: $('editorDialog'),
  editorForm: $('editorForm'),
  editorTitle: $('editorTitle'),
  editId: $('editId'),
  editTitle: $('editTitle'),
  editDate: $('editDate'),
  editCategory: $('editCategory'),
  editNote: $('editNote'),
  formError: $('formError'),
  deleteBtn: $('deleteBtn'),
  memoDialog: $('memoDialog'),
  memoForm: $('memoForm'),
  memoTitle: $('memoTitle'),
  memoId: $('memoId'),
  memoText: $('memoText'),
  memoPin: $('memoPin'),
  memoDeleteBtn: $('memoDeleteBtn'),
  memoToDeadlineBtn: $('memoToDeadlineBtn'),
  settingsDialog: $('settingsDialog'),
  themeSegmented: $('themeSegmented'),
  syncToken: $('syncToken'),
  syncGistId: $('syncGistId'),
  syncConnectBtn: $('syncConnectBtn'),
  syncNowBtn: $('syncNowBtn'),
  syncStatusText: $('syncStatusText'),
  syncDesc: $('syncDesc'),
  qrBtn: $('qrBtn'),
  qrPanel: $('qrPanel'),
  qrCanvas: $('qrCanvas'),
  notifyBtn: $('notifyBtn'),
  notifyStatus: $('notifyStatus'),
  installBtn: $('installBtn'),
  exportBtn: $('exportBtn'),
  importBtn: $('importBtn'),
  importFile: $('importFile'),
  clearAllBtn: $('clearAllBtn'),
  mailSetupDialog: $('mailSetupDialog'),
  toast: $('toast')
};

let state = null;
let tab = 'countdown';
let filter = 'all';
let showDone = false;
let syncing = false;
let syncError = '';
let syncTimer = null;
let qrTimer = null;
let deferredInstall = null;
let lastRenderedDay = '';
let toastTimer = null;

/* ---------------- dates ---------------- */

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function isoOf(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dateOf(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function todayISO() {
  return isoOf(startOfToday());
}

function daysUntil(iso) {
  return Math.round((dateOf(iso) - startOfToday()) / MS_DAY);
}

function dateFromOffset(days) {
  const d = startOfToday();
  d.setDate(d.getDate() + days);
  return isoOf(d);
}

function shortDate(iso) {
  const d = dateOf(iso);
  return d.getFullYear() === new Date().getFullYear()
    ? `${d.getMonth() + 1}月${d.getDate()}日`
    : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function fullDate(iso) {
  const d = dateOf(iso);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 · 周${WEEKDAYS[d.getDay()]}`;
}

function daysLabel(n) {
  if (n < 0) return `已过期 ${-n} 天`;
  if (n === 0) return '今天截止';
  if (n === 1) return '明天截止';
  return `还有 ${n} 天`;
}

function urgencyClass(n) {
  if (n < 0) return 'over';
  if (n <= 3) return 'hot';
  if (n <= 7) return 'warn';
  return 'calm';
}

function timeLabel(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/* ---------------- state ---------------- */

function defaultState() {
  return {
    version: 2,
    items: [],
    memos: [],
    tombstones: { items: {}, memos: {} },
    digest: null,
    settings: { theme: 'auto', sync: { token: '', gistId: '', lastSync: 0 } },
    meta: { lastNotify: null, lastSeenDigest: null }
  };
}

function normalizeItem(raw, index = 0) {
  if (!raw || typeof raw.title !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.date || '')) return null;
  return {
    id: String(raw.id || `it-${Date.now()}-${index}`),
    title: String(raw.title).slice(0, 80),
    date: raw.date,
    category: CATEGORIES[raw.category] ? raw.category : 'calendar',
    note: typeof raw.note === 'string' ? raw.note.slice(0, 300) : '',
    done: Boolean(raw.done),
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Number(raw.createdAt) || Date.now()
  };
}

function normalizeMemo(raw, index = 0) {
  if (!raw || typeof raw.text !== 'string' || !raw.text.trim()) return null;
  return {
    id: String(raw.id || `me-${Date.now()}-${index}`),
    text: String(raw.text).slice(0, 1000),
    pinned: Boolean(raw.pinned),
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Number(raw.createdAt) || Date.now()
  };
}

function normalize(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== 'object') return base;
  const items = Array.isArray(raw.items) ? raw.items.map(normalizeItem).filter(Boolean) : [];
  const memos = Array.isArray(raw.memos) ? raw.memos.map(normalizeMemo).filter(Boolean) : [];
  const tombstones = { items: {}, memos: {} };
  for (const key of ['items', 'memos']) {
    const src = raw.tombstones && raw.tombstones[key];
    if (src && typeof src === 'object') {
      for (const [id, ts] of Object.entries(src)) {
        if (Number.isFinite(Number(ts))) tombstones[key][id] = Number(ts);
      }
    }
  }
  return {
    version: 2,
    items,
    memos,
    tombstones,
    digest: raw.digest && Array.isArray(raw.digest.items) && raw.digest.generatedAt ? raw.digest : null,
    settings: {
      theme: ['auto', 'light', 'dark'].includes(raw.settings && raw.settings.theme) ? raw.settings.theme : 'auto',
      sync: {
        token: raw.settings && raw.settings.sync && typeof raw.settings.sync.token === 'string' ? raw.settings.sync.token : '',
        gistId: raw.settings && raw.settings.sync && typeof raw.settings.sync.gistId === 'string' ? raw.settings.sync.gistId : '',
        lastSync: Number(raw.settings && raw.settings.sync && raw.settings.sync.lastSync) || 0
      }
    },
    meta: {
      lastNotify: (raw.meta && raw.meta.lastNotify) || null,
      lastSeenDigest: (raw.meta && raw.meta.lastSeenDigest) || null
    }
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return normalize(JSON.parse(raw));
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const old = JSON.parse(legacy);
      const migrated = normalize({
        items: (old.items || []).filter((it) => !it.demo),
        memos: [],
        settings: { theme: old.settings && old.settings.theme }
      });
      return migrated;
    }
  } catch (err) {
    console.warn('读取本地数据失败', err);
  }
  return defaultState();
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.warn('保存失败', err);
    toast('保存失败：浏览器存储不可用');
  }
}

/* ---------------- helpers ---------------- */

function el(tag, props, ...children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function hexToRgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2400);
}

/* ---------------- theme ---------------- */

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme() {
  const pref = state.settings.theme;
  const resolved = pref === 'auto' ? (darkQuery.matches ? 'dark' : 'light') : pref;
  document.documentElement.dataset.theme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'dark' ? '#12100f' : '#f6f2ef');
  els.themeSegmented.querySelectorAll('button').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.themeValue === pref));
  });
}

darkQuery.addEventListener('change', () => {
  if (state.settings.theme === 'auto') applyTheme();
});

/* ---------------- tabs ---------------- */

function setTab(next) {
  tab = next;
  document.body.dataset.tab = next;
  for (const btn of els.tabs) {
    const selected = btn.dataset.tab === next;
    btn.setAttribute('aria-selected', String(selected));
  }
  for (const [key, view] of Object.entries(els.views)) view.hidden = key !== next;
  if (next === 'mail') {
    markDigestSeen();
    els.addBtn.setAttribute('aria-label', '同步邮件');
  } else if (next === 'memos') {
    els.addBtn.setAttribute('aria-label', '添加备忘');
  } else {
    els.addBtn.setAttribute('aria-label', '添加截止日');
  }
}

/* ---------------- rendering ---------------- */

function renderHeader() {
  const d = new Date();
  const active = state.items.filter((it) => !it.done && daysUntil(it.date) >= 0).length;
  const overdue = state.items.filter((it) => !it.done && daysUntil(it.date) < 0).length;
  const parts = [`${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 · 周${WEEKDAYS[d.getDay()]}`, `${active} 项待办`];
  if (overdue) parts.push(`${overdue} 项过期`);
  els.todayLabel.textContent = parts.join(' · ');
  lastRenderedDay = todayISO();
}

function renderChips() {
  els.chips.replaceChildren();
  const entries = [['all', '全部'], ...Object.entries(CATEGORIES).map(([key, c]) => [key, c.label])];
  for (const [key, label] of entries) {
    els.chips.append(el('button', {
      class: 'chip',
      type: 'button',
      'aria-pressed': String(filter === key),
      onclick: () => {
        filter = key;
        renderChips();
        renderCountdown();
      }
    }, label));
  }
}

function renderHero() {
  const next = state.items
    .filter((it) => !it.done && daysUntil(it.date) >= 0)
    .sort((a, b) => a.date.localeCompare(b.date))[0];

  els.hero.classList.toggle('is-empty', !next);
  els.hero.classList.remove('is-hot');

  if (!next) {
    els.heroNum.textContent = '—';
    els.heroNum.classList.remove('is-today');
    els.heroUnit.textContent = '';
    els.heroTitle.textContent = state.items.length ? '接下来没有排程' : '清单还是空的';
    els.heroMeta.textContent = state.items.length ? '可以喘口气，也可以提前记下下学期的事' : '点右下角的加号，把第一个截止日记下来';
    els.heroPill.hidden = true;
    els.heroNote.textContent = '';
    els.heroBar.style.width = '0%';
    return;
  }

  const days = daysUntil(next.date);
  const cat = CATEGORIES[next.category] || CATEGORIES.calendar;
  els.heroNum.classList.toggle('is-today', days === 0);
  els.heroNum.textContent = days === 0 ? '今天' : String(days);
  els.heroUnit.textContent = days === 0 ? '截止' : '天后';
  els.heroTitle.textContent = next.title;
  els.heroMeta.textContent = fullDate(next.date);
  els.heroNote.textContent = next.note || '';
  els.heroPill.hidden = false;
  els.heroPill.textContent = cat.label;
  els.heroPill.style.color = cat.color;
  els.heroPill.style.background = hexToRgba(cat.color, 0.13);
  els.hero.classList.toggle('is-hot', days <= 3);
  els.heroBar.style.width = `${days <= 0 ? 100 : Math.max(5, Math.min(100, 100 - days * 3))}%`;
  els.heroBar.style.background = days <= 3
    ? 'linear-gradient(90deg, #d97706, #b42318)'
    : 'linear-gradient(90deg, var(--accent), var(--accent-2))';
}

function buildItem(item) {
  const days = daysUntil(item.date);
  const cat = CATEGORIES[item.category] || CATEGORIES.calendar;
  const done = item.done;

  const check = el('button', {
    class: 'check',
    type: 'button',
    'aria-label': done ? `把「${item.title}」标记为未完成` : `把「${item.title}」标记为已完成`,
    'aria-pressed': String(done),
    onclick: (event) => {
      event.stopPropagation();
      toggleDone(item.id);
    }
  }, el('span', { class: 'box' },
    el('svg', { viewBox: '0 0 24 24', width: '13', height: '13', fill: 'none', stroke: 'currentColor', 'stroke-width': '3', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
      el('path', { d: 'M4 12.5 9.5 18 20 6.5' }))));

  return el('li', {
    class: `item${done ? ' is-done' : ''}${!done && days < 0 ? ' is-overdue' : ''}`,
    dataset: { id: item.id }
  },
    check,
    el('button', { class: 'item-main', type: 'button', onclick: () => openEditor(item) },
      el('span', { class: 'item-title', text: item.title }),
      el('span', { class: 'item-meta' },
        el('span', { class: 'pill', style: `color:${cat.color};background:${hexToRgba(cat.color, 0.12)}` }, cat.label),
        el('span', { text: shortDate(item.date) }),
        el('span', { class: `days ${done ? 'calm' : urgencyClass(days)}`, text: done ? '已完成' : daysLabel(days) })),
      item.note ? el('span', { class: 'item-note', text: item.note }) : null));
}

function buildGroup(title, items, extraClass = '') {
  return el('section', { class: 'group' },
    el('h2', { class: `group-title ${extraClass}`.trim() }, title, el('span', { text: `${items.length} 项` })),
    el('ul', { class: 'items' }, items.map(buildItem)));
}

function renderCountdown() {
  renderHero();
  const filtered = state.items.filter((it) => filter === 'all' || it.category === filter);
  const active = filtered.filter((it) => !it.done);
  const overdue = active.filter((it) => daysUntil(it.date) < 0).sort((a, b) => a.date.localeCompare(b.date));
  const upcoming = active.filter((it) => daysUntil(it.date) >= 0).sort((a, b) => a.date.localeCompare(b.date));
  const done = filtered.filter((it) => it.done).sort((a, b) => b.date.localeCompare(a.date));

  const nodes = [];
  if (overdue.length) nodes.push(buildGroup('已过期', overdue, 'overdue'));
  const byMonth = new Map();
  for (const item of upcoming) {
    const key = item.date.slice(0, 7);
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(item);
  }
  for (const [key, items] of byMonth) {
    const [y, m] = key.split('-');
    nodes.push(buildGroup(`${y}年${Number(m)}月`, items));
  }
  if (showDone && done.length) nodes.push(buildGroup('已完成', done));

  els.list.replaceChildren();
  if (!nodes.length) {
    const filteredOut = filter !== 'all' || (!showDone && filtered.some((it) => it.done));
    els.list.append(el('div', { class: 'empty' },
      el('strong', { text: filteredOut ? '这个筛选下没有条目' : '还没有截止日' }),
      filteredOut ? '换个类别看看，或者点右下角加一条。' : '缴费、选课、宿舍续住、签证续期，先把最近的一个记下来。'));
    return;
  }
  nodes.forEach((n) => els.list.append(n));
  els.toggleDone.setAttribute('aria-pressed', String(showDone));
  els.toggleDone.textContent = showDone ? '隐藏已完成' : '显示已完成';
}

function renderMemos() {
  const memos = [...state.memos].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
  const pinned = memos.filter((m) => m.pinned).length;
  els.memoCount.textContent = memos.length ? `${memos.length} 条${pinned ? ` · ${pinned} 条置顶` : ''}` : '';

  els.memoList.replaceChildren();
  if (!memos.length) {
    els.memoList.append(el('div', { class: 'memo-empty' },
      el('strong', { text: '还没有备忘' }),
      '想到就记，比记在脑子里靠谱。点右下角的加号。'));
    return;
  }
  for (const memo of memos) {
    els.memoList.append(el('button', {
      class: `memo${memo.pinned ? ' pinned' : ''}`,
      type: 'button',
      onclick: () => openMemo(memo)
    },
      el('span', { class: 'memo-text', text: memo.text }),
      el('span', { class: 'memo-meta' },
        memo.pinned ? el('span', { class: 'pin-flag' }, '置顶') : null,
        el('span', { text: `更新于 ${timeLabel(memo.updatedAt)}` }))));
  }
}

function renderMail() {
  const digest = state.digest;
  els.mailList.replaceChildren();

  if (!digest || !Array.isArray(digest.items)) {
    els.mailMeta.textContent = '';
    els.mailDot.hidden = true;
    els.mailList.append(el('div', { class: 'mail-empty' },
      el('strong', { text: '邮件摘要还没接上' }),
      '接通之后，每天 12:30 会把学校邮件里值得看的挑出来，缴费、选课、活动一目了然。',
      el('button', { class: 'btn ghost block', type: 'button', onclick: () => els.mailSetupDialog.showModal() }, '看接入步骤')));
    return;
  }

  const generated = new Date(digest.generatedAt);
  els.mailMeta.textContent = `生成于 ${timeLabel(generated.getTime())} · ${digest.items.length} 封${digest.mode === 'rules' ? ' · 规则筛选' : ''}`;
  els.mailDot.hidden = !state.meta.lastSeenDigest || state.meta.lastSeenDigest >= digest.generatedAt;

  if (!digest.items.length) {
    els.mailList.append(el('div', { class: 'mail-empty' },
      el('strong', { text: '这两天的学校邮件都很安静' }),
      '没有值得单独拎出来的邮件，也算好消息。'));
    return;
  }

  for (const mail of digest.items) {
    const tags = Array.isArray(mail.tags) ? mail.tags.slice(0, 4) : [];
    const suggested = /^\d{4}-\d{2}-\d{2}$/.test(mail.suggestedDate || '') ? mail.suggestedDate : '';
    const actions = el('div', { class: 'mail-actions' },
      el('button', {
        class: 'btn ghost small',
        type: 'button',
        onclick: () => addFromMail(mail, false)
      }, suggested ? '加进倒计时' : '设为截止日'),
      el('button', {
        class: 'btn ghost small',
        type: 'button',
        onclick: () => addFromMail(mail, true)
      }, '存成备忘'));
    if (mail.url) {
      actions.append(el('a', { class: 'btn ghost small', href: mail.url, target: '_blank', rel: 'noopener noreferrer' }, '打开邮件'));
    }

    els.mailList.append(el('article', { class: `mail-card${mail.importance === 'high' ? ' high' : ''}` },
      el('div', { class: 'mail-top' },
        el('span', { class: 'mail-from', text: shortenFrom(mail.from) }),
        el('span', { class: 'mail-when', text: mail.receivedAt ? timeLabel(Date.parse(mail.receivedAt)) : '' })),
      el('h3', { class: 'mail-subject', text: mail.subject || '（无主题）' }),
      mail.snippet ? el('p', { class: 'mail-snippet', text: mail.snippet }) : null,
      tags.length ? el('div', { class: 'mail-tags' },
        tags.map((t) => el('span', { class: `tag${t === '重要' ? ' accent' : ''}`, text: t })),
        suggested ? el('span', { class: 'tag accent', text: `提到 ${shortDate(suggested)}` }) : null) : null,
      actions));
  }
}

function shortenFrom(from) {
  const text = String(from || '');
  const match = text.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>/);
  return (match ? match[1] : text).slice(0, 40) || '未知发件人';
}

function markDigestSeen() {
  if (state.digest && state.digest.generatedAt) {
    state.meta.lastSeenDigest = state.digest.generatedAt;
    save();
    els.mailDot.hidden = true;
  }
}

function renderSyncUI() {
  const sync = state.settings.sync;
  const configured = Boolean(sync.token && sync.gistId);
  const failed = Boolean(syncError) && !syncing;
  els.syncDot.dataset.state = syncing ? 'syncing' : failed ? 'error' : configured ? 'ok' : 'off';
  els.syncText.textContent = syncing ? '同步中' : failed ? '失败' : configured ? (sync.lastSync ? '已同步' : '待同步') : '未同步';

  if (failed) {
    els.syncStatusText.textContent = `同步失败：${syncError}`;
    els.syncStatusText.className = 'sync-status error';
    els.syncDesc.textContent = '同步没有成功。检查 token 是否有效、有没有 Gist 读写权限，或者网络能不能连上 GitHub。';
    return;
  }
  if (syncing) {
    els.syncStatusText.textContent = '正在同步…';
    els.syncStatusText.className = 'sync-status';
    return;
  }
  if (configured) {
    els.syncStatusText.textContent = sync.lastSync ? `上次同步：${timeLabel(sync.lastSync)}` : '已配置，等待第一次同步';
    els.syncStatusText.className = 'sync-status ok';
    els.syncDesc.textContent = '已开启：改动会自动合并到这台设备和你的私有 Gist 之间。';
  } else {
    els.syncStatusText.textContent = '尚未配置同步';
    els.syncStatusText.className = 'sync-status';
  }
}

function renderAll() {
  renderHeader();
  renderChips();
  renderCountdown();
  renderMemos();
  renderMail();
  renderSyncUI();
}

/* ---------------- deadline actions ---------------- */

function toggleDone(id) {
  const item = state.items.find((it) => it.id === id);
  if (!item) return;
  item.done = !item.done;
  item.updatedAt = Date.now();
  save();
  renderCountdown();
  renderHeader();
  toast(item.done ? '完成，清单轻了一点' : '已恢复');
  scheduleSync();
}

function openEditor(item = null, preset = null) {
  const data = item || preset || {};
  els.editId.value = item ? item.id : '';
  els.editorTitle.textContent = item ? '编辑截止日' : '添加截止日';
  els.editTitle.value = data.title || '';
  els.editDate.value = data.date || dateFromOffset(7);
  els.editCategory.value = data.category || (filter !== 'all' ? filter : 'calendar');
  els.editNote.value = data.note || '';
  els.formError.hidden = true;
  els.deleteBtn.hidden = !item;
  els.editorDialog.showModal();
  setTimeout(() => els.editTitle.focus(), 40);
}

function submitEditor(event) {
  event.preventDefault();
  const title = els.editTitle.value.trim();
  const date = els.editDate.value;
  if (!title) {
    els.formError.textContent = '写个标题吧，之后才认得出这是哪件事。';
    els.formError.hidden = false;
    els.editTitle.focus();
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    els.formError.textContent = '选一个截止日期。';
    els.formError.hidden = false;
    return;
  }
  const payload = {
    title: title.slice(0, 40),
    date,
    category: CATEGORIES[els.editCategory.value] ? els.editCategory.value : 'calendar',
    note: els.editNote.value.trim().slice(0, 120)
  };
  const id = els.editId.value;
  if (id) {
    const item = state.items.find((it) => it.id === id);
    if (item) Object.assign(item, payload, { updatedAt: Date.now() });
  } else {
    state.items.push({ id: `it-${Date.now().toString(36)}`, done: false, createdAt: Date.now(), updatedAt: Date.now(), ...payload });
  }
  save();
  closeDialog(els.editorDialog);
  renderAll();
  toast(id ? '已更新' : '已添加');
  scheduleSync();
  checkNotifications();
}

function deleteItem() {
  const id = els.editId.value;
  const item = state.items.find((it) => it.id === id);
  if (!item) return;
  if (!window.confirm(`删除「${item.title}」？`)) return;
  state.items = state.items.filter((it) => it.id !== id);
  state.tombstones.items[id] = Date.now();
  save();
  closeDialog(els.editorDialog);
  renderAll();
  toast('已删除');
  scheduleSync();
}

/* ---------------- memo actions ---------------- */

function openMemo(memo = null) {
  els.memoId.value = memo ? memo.id : '';
  els.memoTitle.textContent = memo ? '编辑备忘' : '新备忘';
  els.memoText.value = memo ? memo.text : '';
  els.memoPin.checked = memo ? memo.pinned : false;
  els.memoDeleteBtn.hidden = !memo;
  els.memoToDeadlineBtn.hidden = !memo;
  els.memoDialog.showModal();
  setTimeout(() => els.memoText.focus(), 40);
}

function submitMemo(event) {
  event.preventDefault();
  const text = els.memoText.value.trim();
  if (!text) {
    toast('先写点内容');
    els.memoText.focus();
    return;
  }
  const id = els.memoId.value;
  if (id) {
    const memo = state.memos.find((m) => m.id === id);
    if (memo) Object.assign(memo, { text, pinned: els.memoPin.checked, updatedAt: Date.now() });
  } else {
    state.memos.push({ id: `me-${Date.now().toString(36)}`, text, pinned: els.memoPin.checked, createdAt: Date.now(), updatedAt: Date.now() });
  }
  save();
  closeDialog(els.memoDialog);
  renderMemos();
  toast(id ? '已更新' : '已记下');
  scheduleSync();
}

function deleteMemo() {
  const id = els.memoId.value;
  if (!id) return;
  if (!window.confirm('删除这条备忘？')) return;
  state.memos = state.memos.filter((m) => m.id !== id);
  state.tombstones.memos[id] = Date.now();
  save();
  closeDialog(els.memoDialog);
  renderMemos();
  toast('已删除');
  scheduleSync();
}

function memoToDeadline() {
  const text = els.memoText.value.trim();
  if (!text) {
    toast('先写点内容');
    return;
  }
  const firstLine = text.split('\n')[0].slice(0, 40);
  closeDialog(els.memoDialog);
  openEditor(null, { title: firstLine, note: text.slice(0, 120), category: 'study' });
}

/* ---------------- mail actions ---------------- */

function guessCategory(mail) {
  const blob = `${mail.subject || ''} ${(mail.tags || []).join(' ')}`;
  if (/实习|intern/i.test(blob)) return 'internship';
  if (/活动|讲座|工作坊|比赛|招聘|seminar|workshop/i.test(blob)) return 'activity';
  if (/宿舍|住宿|hall/i.test(blob)) return 'housing';
  if (/签证|visa|签注/i.test(blob)) return 'visa';
  if (/缴费|学费|费用|奖学金|tuition|fee/i.test(blob)) return 'tuition';
  if (/选课|课表|考试|校历|add|drop|timetable|exam/i.test(blob)) return 'calendar';
  return 'study';
}

function addFromMail(mail, asMemo) {
  if (asMemo) {
    state.memos.push({
      id: `me-${Date.now().toString(36)}`,
      text: `${mail.subject || '（无主题）'}\n${mail.snippet || ''}\n——来自 ${shortenFrom(mail.from)}`,
      pinned: false,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    save();
    renderMemos();
    toast('已存成备忘');
    scheduleSync();
    return;
  }
  const date = /^\d{4}-\d{2}-\d{2}$/.test(mail.suggestedDate || '') ? mail.suggestedDate : dateFromOffset(3);
  openEditor(null, {
    title: (mail.subject || '邮件里的截止日').slice(0, 40),
    date,
    category: guessCategory(mail),
    note: `来自 ${shortenFrom(mail.from)}`.slice(0, 120)
  });
}

/* ---------------- sync ---------------- */

async function github(path, options = {}) {
  const token = state.settings.sync.token;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (options.body) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(`https://api.github.com${path}`, {
      ...options,
      headers: { ...headers, ...(options.headers || {}) },
      signal: AbortSignal.timeout(15000)
    });
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new Error(timeout ? '网络超时，连不上 GitHub' : '网络请求失败（断网或被拦截）');
  }
  if (!res.ok) {
    const err = new Error(res.status === 401 ? 'token 无效或没有 Gist 权限' : res.status === 404 ? 'Gist 不存在，检查 ID' : `GitHub 返回 ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function docForSync() {
  return {
    version: 2,
    items: state.items,
    memos: state.memos,
    tombstones: state.tombstones,
    updatedAt: Date.now()
  };
}

function setSyncStatus(message, kind = '') {
  els.syncStatusText.textContent = message;
  els.syncStatusText.className = `sync-status${kind ? ` ${kind}` : ''}`;
}

function scheduleSync() {
  const sync = state.settings.sync;
  if (!sync.token || !sync.gistId) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow(false), 1800);
}

async function syncNow(manual = false) {
  const sync = state.settings.sync;
  if (!sync.token || !sync.gistId) {
    if (manual) toast('先在设置里填 token 和 Gist');
    return;
  }
  if (syncing) return;
  syncing = true;
  syncError = '';
  renderSyncUI();
  setSyncStatus('正在同步…');
  try {
    const gist = await github(`/gists/${sync.gistId}`);
    let remote = null;
    const dataFile = gist.files && gist.files[DATA_FILE];
    if (dataFile) {
      let content = dataFile.content || '';
      if (dataFile.truncated && dataFile.raw_url) {
        const raw = await fetch(dataFile.raw_url, { headers: { Authorization: `Bearer ${sync.token}` } });
        if (raw.ok) content = await raw.text();
      }
      try {
        remote = content ? JSON.parse(content) : null;
      } catch (err) {
        console.warn('远端数据无法解析', err);
      }
    }

    const merged = mergeStates(
      { items: state.items, memos: state.memos, tombstones: state.tombstones },
      remote ? { items: remote.items, memos: remote.memos, tombstones: remote.tombstones } : null
    );
    state.items = merged.items;
    state.memos = merged.memos;
    state.tombstones = merged.tombstones;

    const digestFile = gist.files && gist.files[DIGEST_FILE];
    if (digestFile && digestFile.content) {
      try {
        const parsed = JSON.parse(digestFile.content);
        if (parsed && Array.isArray(parsed.items) && parsed.generatedAt) {
          if (!state.digest || String(parsed.generatedAt) > String(state.digest.generatedAt)) {
            state.digest = parsed;
          }
        }
      } catch (err) {
        console.warn('摘要解析失败', err);
      }
    }

    await github(`/gists/${sync.gistId}`, {
      method: 'PATCH',
      body: JSON.stringify({ files: { [DATA_FILE]: { content: JSON.stringify(docForSync(), null, 2) } } })
    });

    sync.lastSync = Date.now();
    syncError = '';
    save();
    renderAll();
    setSyncStatus(`上次同步：${timeLabel(sync.lastSync)}`, 'ok');
    if (manual) toast('已同步');
  } catch (err) {
    console.warn('同步失败', err);
    syncError = err.message;
    setSyncStatus(`同步失败：${err.message}`, 'error');
    if (manual) toast(`同步失败：${err.message}`);
  } finally {
    syncing = false;
    renderSyncUI();
  }
}

async function connectSync() {
  const token = els.syncToken.value.trim();
  let gistId = els.syncGistId.value.trim();
  if (!token) {
    toast('先填 GitHub token');
    els.syncToken.focus();
    return;
  }
  state.settings.sync.token = token;
  els.syncConnectBtn.disabled = true;
  try {
    if (!gistId) {
      setSyncStatus('正在创建私有 Gist…');
      const created = await github('/gists', {
        method: 'POST',
        body: JSON.stringify({
          description: 'PolyU 备忘录 同步数据',
          public: false,
          files: {
            [DATA_FILE]: { content: JSON.stringify(docForSync(), null, 2) },
            [DIGEST_FILE]: { content: JSON.stringify({ generatedAt: null, items: [] }, null, 2) }
          }
        })
      });
      gistId = created.id;
      els.syncGistId.value = gistId;
      toast('已创建私有 Gist');
    }
    state.settings.sync.gistId = gistId;
    save();
    renderSyncUI();
    await syncNow(true);
  } catch (err) {
    console.warn(err);
    syncError = err.message;
    setSyncStatus(`连接失败：${err.message}`, 'error');
    toast(`连接失败：${err.message}`);
    renderSyncUI();
  } finally {
    els.syncConnectBtn.disabled = false;
  }
}

/* ---------------- 扫码导入 ---------------- */

function appBaseUrl() {
  return `${location.origin}${location.pathname.replace(/[^/]*$/, '')}`;
}

function hideQrPanel() {
  clearTimeout(qrTimer);
  if (!els.qrPanel || els.qrPanel.hidden) return;
  const ctx = els.qrCanvas.getContext('2d');
  ctx.clearRect(0, 0, els.qrCanvas.width, els.qrCanvas.height);
  els.qrPanel.hidden = true;
}

function renderQrPanel() {
  const sync = state.settings.sync;
  if (!sync.token || !sync.gistId) {
    hideQrPanel();
    toast('先在电脑上连好同步，再生成二维码');
    return;
  }
  if (typeof window.qrcode !== 'function') {
    toast('二维码组件没加载出来，刷新页面再试');
    return;
  }
  let link;
  try {
    link = buildSyncLink(appBaseUrl(), sync);
  } catch (err) {
    toast(err.message || '生成二维码失败');
    return;
  }
  const qr = window.qrcode(0, 'M');
  qr.addData(link);
  qr.make();

  const quiet = 4;
  const count = qr.getModuleCount();
  const total = count + quiet * 2;
  const scale = total > 80 ? 3 : 4;
  const canvas = els.qrCanvas;
  canvas.width = total * scale;
  canvas.height = total * scale;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000000';
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (qr.isDark(row, col)) ctx.fillRect((col + quiet) * scale, (row + quiet) * scale, scale, scale);
    }
  }

  els.qrPanel.hidden = false;
  clearTimeout(qrTimer);
  qrTimer = setTimeout(hideQrPanel, 180000);
}

/* ---------------- notifications ---------------- */

function notificationsSupported() {
  return typeof window.Notification !== 'undefined';
}

function isIOS() {
  return /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function sendNotification(title, body) {
  if (!notificationsSupported() || Notification.permission !== 'granted') return;
  if (navigator.serviceWorker && navigator.serviceWorker.ready) {
    navigator.serviceWorker.ready
      .then((reg) => reg.showNotification(title, { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'polyu-due' }))
      .catch(() => { try { new Notification(title, { body }); } catch (err) { /* 忽略 */ } });
  } else {
    try { new Notification(title, { body }); } catch (err) { /* 忽略 */ }
  }
}

function updateNotifyUI() {
  if (!notificationsSupported()) {
    els.notifyStatus.textContent = '这个浏览器不支持系统通知，清单里的天数会标红提醒你。';
    els.notifyBtn.hidden = true;
    return;
  }
  if (isIOS()) {
    els.notifyStatus.textContent = 'iPhone 上的网页推送要等下一版（需要装到主屏幕并接推送服务）。现在先靠 App 里的标红和「已过期」分组。';
    els.notifyBtn.hidden = true;
    return;
  }
  els.notifyBtn.hidden = false;
  if (Notification.permission === 'granted') {
    els.notifyStatus.textContent = '提醒已开启：打开应用时，3 天内到期的条目会弹通知。';
    els.notifyBtn.textContent = '发一条测试通知';
  } else if (Notification.permission === 'denied') {
    els.notifyStatus.textContent = '通知权限被拒绝了，可以在浏览器的网站设置里重新允许。';
    els.notifyBtn.textContent = '重新申请';
  } else {
    els.notifyStatus.textContent = '开启后，临近截止（3 天内）会弹一次浏览器通知。';
    els.notifyBtn.textContent = '开启提醒';
  }
}

async function onNotifyClick() {
  if (!notificationsSupported()) return;
  if (Notification.permission === 'granted') {
    sendNotification('测试通知', '提醒功能正常，临近截止时会像这样提醒你。');
    return;
  }
  const permission = await Notification.requestPermission();
  updateNotifyUI();
  if (permission === 'granted') {
    sendNotification('提醒已开启', '3 天内的截止日会通知你。');
    toast('提醒已开启');
  } else {
    toast('没有拿到通知权限');
  }
}

function checkNotifications() {
  if (!notificationsSupported() || Notification.permission !== 'granted') return;
  const today = todayISO();
  if (state.meta.lastNotify === today) return;
  const due = state.items
    .filter((it) => !it.done && daysUntil(it.date) >= 0 && daysUntil(it.date) <= 3)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!due.length) return;
  sendNotification('PolyU 备忘录 · 快到了', due.map((it) => `${it.title}（${daysLabel(daysUntil(it.date))}）`).join('；'));
  state.meta.lastNotify = today;
  save();
}

/* ---------------- data ---------------- */

function exportData() {
  const payload = {
    app: 'polyu-memo',
    version: 2,
    exportedAt: new Date().toISOString(),
    items: state.items,
    memos: state.memos,
    settings: { theme: state.settings.theme }
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `PolyU备忘录-${todayISO()}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('已导出 JSON');
}

async function importData(file) {
  try {
    const parsed = JSON.parse(await file.text());
    const incoming = Array.isArray(parsed) ? parsed : parsed.items;
    if (!Array.isArray(incoming)) throw new Error('format');
    const imported = incoming.map(normalizeItem).filter(Boolean);
    const importedMemos = Array.isArray(parsed.memos) ? parsed.memos.map(normalizeMemo).filter(Boolean) : [];
    const merged = mergeStates(
      { items: state.items, memos: state.memos, tombstones: state.tombstones },
      { items: imported, memos: importedMemos, tombstones: {} }
    );
    state.items = merged.items;
    state.memos = merged.memos;
    state.tombstones = merged.tombstones;
    save();
    renderAll();
    scheduleSync();
    toast(`导入了 ${imported.length} 条截止日${importedMemos.length ? `、${importedMemos.length} 条备忘` : ''}`);
  } catch (err) {
    console.warn(err);
    toast('导入失败：不是有效的 JSON 备份');
  }
}

function clearAll() {
  if (!window.confirm('清空全部截止日和备忘？这个操作会同步到其他设备，不能撤销。')) return;
  const now = Date.now();
  for (const it of state.items) state.tombstones.items[it.id] = now;
  for (const m of state.memos) state.tombstones.memos[m.id] = now;
  state.items = [];
  state.memos = [];
  save();
  renderAll();
  scheduleSync();
  closeDialog(els.settingsDialog);
  toast('已清空');
}

/* ---------------- install / sw ---------------- */

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (!/^https?:$/.test(location.protocol)) return;
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker 注册失败', err));
}

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstall = event;
  els.installBtn.hidden = false;
});

window.addEventListener('appinstalled', () => {
  deferredInstall = null;
  els.installBtn.hidden = true;
  toast('已安装到桌面');
});

async function onInstallClick() {
  if (!deferredInstall) {
    toast('浏览器菜单里选「安装应用」也可以');
    return;
  }
  deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall = null;
  els.installBtn.hidden = true;
}

/* ---------------- dialogs ---------------- */

function closeDialog(dialog) {
  if (dialog && dialog.open) dialog.close();
  if (dialog === els.settingsDialog) hideQrPanel();
}

/* ---------------- wiring ---------------- */

function wire() {
  els.tabs.forEach((btn) => btn.addEventListener('click', () => setTab(btn.dataset.tab)));

  els.addBtn.addEventListener('click', () => {
    if (tab === 'memos') openMemo(null);
    else if (tab === 'mail') syncNow(true);
    else openEditor(null);
  });

  els.settingsBtn.addEventListener('click', () => {
    els.syncToken.value = state.settings.sync.token;
    els.syncGistId.value = state.settings.sync.gistId;
    updateNotifyUI();
    renderSyncUI();
    els.settingsDialog.showModal();
  });

  els.syncDot.addEventListener('click', () => {
    els.syncToken.value = state.settings.sync.token;
    els.syncGistId.value = state.settings.sync.gistId;
    renderSyncUI();
    els.settingsDialog.showModal();
  });

  els.editorForm.addEventListener('submit', submitEditor);
  els.deleteBtn.addEventListener('click', deleteItem);
  els.memoForm.addEventListener('submit', submitMemo);
  els.memoDeleteBtn.addEventListener('click', deleteMemo);
  els.memoToDeadlineBtn.addEventListener('click', memoToDeadline);

  els.toggleDone.addEventListener('click', () => {
    showDone = !showDone;
    renderCountdown();
  });

  els.themeSegmented.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-theme-value]');
    if (!btn) return;
    state.settings.theme = btn.dataset.themeValue;
    save();
    applyTheme();
  });

  els.syncConnectBtn.addEventListener('click', connectSync);
  els.syncNowBtn.addEventListener('click', () => syncNow(true));
  els.qrBtn.addEventListener('click', renderQrPanel);
  els.refreshMailBtn.addEventListener('click', () => syncNow(true));

  els.notifyBtn.addEventListener('click', onNotifyClick);
  els.installBtn.addEventListener('click', onInstallClick);
  els.exportBtn.addEventListener('click', exportData);
  els.importBtn.addEventListener('click', () => els.importFile.click());
  els.importFile.addEventListener('change', async () => {
    const file = els.importFile.files && els.importFile.files[0];
    if (file) await importData(file);
    els.importFile.value = '';
  });
  els.clearAllBtn.addEventListener('click', clearAll);

  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => closeDialog($(btn.dataset.close)));
  });

  for (const dialog of [els.editorDialog, els.memoDialog, els.settingsDialog, els.mailSetupDialog]) {
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
      if (!inside) closeDialog(dialog);
    });
  }

  els.editCategory.append(...Object.entries(CATEGORIES).map(([key, c]) => el('option', { value: key, text: c.label })));

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (lastRenderedDay !== todayISO()) renderAll();
    if (state.settings.sync.token && state.settings.sync.gistId) syncNow(false);
    checkNotifications();
  });

  setInterval(() => {
    if (lastRenderedDay !== todayISO()) renderAll();
    if (!document.hidden && state.settings.sync.token && state.settings.sync.gistId) syncNow(false);
  }, 5 * 60 * 1000);
}

/* ---------------- boot ---------------- */

function consumeSyncHash() {
  if (!location.hash.includes('#s=')) return;
  const imported = parseSyncHash(location.hash);
  const cleanUrl = location.pathname + location.search;
  if (!imported) {
    history.replaceState(null, '', cleanUrl);
    toast('二维码里的同步信息无效，重新生成一张');
    return;
  }
  state.settings.sync.token = imported.token;
  state.settings.sync.gistId = imported.gistId;
  state.settings.sync.lastSync = 0;
  save();
  history.replaceState(null, '', cleanUrl);
  setTimeout(() => {
    renderSyncUI();
    toast('已导入同步配置，开始同步…');
  }, 500);
}

function boot() {
  state = loadState();
  applyTheme();
  consumeSyncHash();
  wire();
  setTab('countdown');
  renderAll();
  registerServiceWorker();
  if (state.settings.sync.token && state.settings.sync.gistId) setTimeout(() => syncNow(false), 800);
  setTimeout(checkNotifications, 1200);
}

boot();
