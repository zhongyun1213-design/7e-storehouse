'use strict';

import { mergeStates } from './sync-core.js';
import { buildSyncLink, parseSyncHash } from './sync-link.js';
import { BUILD } from './version.js';
import { pushSupported, isStandalone, workerUrl, currentSubscription, enablePush, disablePush, sendTestPush, triggerCanvasSync } from './push-client.js';

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
  memoHeading: $('memoHeading'),
  memoItems: $('memoItems'),
  memoAddItem: $('memoAddItem'),
  memoRemind: $('memoRemind'),
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
  aboutLine: $('aboutLine'),
  canvasSyncBtn: $('canvasSyncBtn'),
  checkUpdateBtn: $('checkUpdateBtn'),
  pushToggleBtn: $('pushToggleBtn'),
  pushTestBtn: $('pushTestBtn'),
  pushStatus: $('pushStatus'),
  editTime: $('editTime'),
  editLead: $('editLead'),
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
    time: /^\d{2}:\d{2}$/.test(raw.time || '') ? raw.time : '',
    lead: Number.isFinite(Number(raw.lead)) && Number(raw.lead) >= 0 ? Number(raw.lead) : 30,
    canvasUid: typeof raw.canvasUid === 'string' ? raw.canvasUid : '',
    done: Boolean(raw.done),
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Number(raw.createdAt) || Date.now()
  };
}

function normalizeMemo(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const items = [];
  if (Array.isArray(raw.items)) {
    raw.items.forEach((item, i) => {
      if (!item || typeof item.text !== 'string' || !item.text.trim()) return;
      items.push({
        id: String(item.id || `mi-${index}-${i}`),
        text: String(item.text).slice(0, 200),
        done: Boolean(item.done)
      });
    });
  }
  if (!items.length && typeof raw.text === 'string' && raw.text.trim()) {
    items.push({ id: `mi-${index}-0`, text: raw.text.trim().slice(0, 200), done: false });
  }
  if (!items.length) return null;
  return {
    id: String(raw.id || `me-${Date.now()}-${index}`),
    title: typeof raw.title === 'string' ? raw.title.slice(0, 40) : '',
    items: items.slice(0, 30),
    remindAt: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw.remindAt || '') ? raw.remindAt : '',
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
        item.time ? el('span', { class: 'item-time', text: item.time }) : null,
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

function fmtRemind(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value || '');
  if (!match) return '';
  return `${Number(match[2])}月${Number(match[3])}日 ${match[4]}:${match[5]}`;
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
    const doneCount = memo.items.filter((item) => item.done).length;
    const rows = memo.items.map((item) => el('li', { class: `memo-item${item.done ? ' is-done' : ''}` },
      el('button', {
        class: 'memo-check',
        type: 'button',
        'aria-pressed': String(item.done),
        'aria-label': item.done ? `把「${item.text}」标回未完成` : `把「${item.text}」标记完成`,
        onclick: (event) => {
          event.stopPropagation();
          toggleMemoItem(memo.id, item.id);
        }
      }, el('span', { class: 'box', text: item.done ? '✓' : '' })),
      el('span', { class: 'memo-item-text', text: item.text })));

    els.memoList.append(el('div', {
      class: `memo${memo.pinned ? ' pinned' : ''}`,
      role: 'button',
      tabindex: '0',
      onclick: () => openMemo(memo),
      onkeydown: (event) => {
        if (event.key === 'Enter' || event.key === ' ') openMemo(memo);
      }
    },
      memo.title ? el('span', { class: 'memo-heading', text: memo.title }) : null,
      el('ul', { class: 'memo-items-view' }, rows),
      el('span', { class: 'memo-meta' },
        memo.pinned ? el('span', { class: 'pin-flag' }, '置顶') : null,
        memo.remindAt ? el('span', { class: 'memo-remind', text: `提醒 ${fmtRemind(memo.remindAt)}` }) : null,
        el('span', { text: `${doneCount}/${memo.items.length}` }))));
  }
}

function toggleMemoItem(memoId, itemId) {
  const memo = state.memos.find((m) => m.id === memoId);
  if (!memo) return;
  const item = memo.items.find((it) => it.id === itemId);
  if (!item) return;
  item.done = !item.done;
  memo.updatedAt = Date.now();
  save();
  renderMemos();
  scheduleSync();
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

    const snippetNode = mail.snippet ? el('p', { class: 'mail-snippet', text: mail.snippet }) : null;
    const expandBtn = mail.snippet && mail.snippet.length > 120
      ? el('button', {
        class: 'link-btn',
        type: 'button',
        onclick: () => {
          const expanded = snippetNode.classList.toggle('expanded');
          expandBtn.textContent = expanded ? '收起' : '展开全文';
        }
      }, '展开全文')
      : null;

    els.mailList.append(el('article', { class: `mail-card${mail.importance === 'high' ? ' high' : ''}` },
      el('div', { class: 'mail-top' },
        el('span', { class: 'mail-from', text: shortenFrom(mail.from) }),
        el('span', { class: 'mail-when', text: mail.receivedAt ? timeLabel(Date.parse(mail.receivedAt)) : '' })),
      el('h3', { class: 'mail-subject', text: mail.subject || '（无主题）' }),
      snippetNode,
      expandBtn,
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
  els.editTime.value = data.time || '';
  els.editLead.value = String(Number.isFinite(Number(data.lead)) ? Number(data.lead) : 30);
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
    time: /^\d{2}:\d{2}$/.test(els.editTime.value) ? els.editTime.value : '',
    lead: Number(els.editLead.value) >= 0 ? Number(els.editLead.value) : 30,
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

function memoItemRow(text = '', done = false) {
  const input = el('input', { type: 'text', maxlength: '120', placeholder: '例如：买牙膏', value: text });
  const check = el('input', { type: 'checkbox', class: 'memo-item-check' });
  check.checked = done;
  const remove = el('button', { class: 'icon-btn small', type: 'button', 'aria-label': '删除这一项' }, '✕');
  remove.addEventListener('click', () => row.remove());
  const row = el('div', { class: 'memo-item-row' }, check, input, remove);
  return row;
}

function collectMemoRows() {
  return [...els.memoItems.querySelectorAll('.memo-item-row')]
    .map((row, index) => {
      const input = row.querySelector('input[type="text"]');
      const check = row.querySelector('input[type="checkbox"]');
      const text = input ? input.value.trim() : '';
      if (!text) return null;
      return { id: row.dataset.itemId || `mi-${Date.now().toString(36)}-${index}`, text: text.slice(0, 200), done: Boolean(check && check.checked) };
    })
    .filter(Boolean);
}

function openMemo(memo = null) {
  els.memoId.value = memo ? memo.id : '';
  els.memoTitle.textContent = memo ? '编辑备忘' : '新备忘';
  els.memoHeading.value = memo ? memo.title || '' : '';
  els.memoRemind.value = memo ? memo.remindAt || '' : '';
  els.memoPin.checked = memo ? memo.pinned : false;
  els.memoItems.replaceChildren();
  const rows = memo ? memo.items : [null];
  rows.forEach((item, index) => {
    const row = memoItemRow(item ? item.text : '', item ? item.done : false);
    if (item) row.dataset.itemId = item.id;
    els.memoItems.append(row);
    if (!memo && index === 0) setTimeout(() => row.querySelector('input[type="text"]').focus(), 40);
  });
  els.memoDeleteBtn.hidden = !memo;
  els.memoToDeadlineBtn.hidden = !memo;
  els.memoDialog.showModal();
  if (memo) setTimeout(() => els.memoHeading.focus(), 40);
}

function submitMemo(event) {
  event.preventDefault();
  const items = collectMemoRows();
  if (!items.length) {
    toast('先写点内容');
    return;
  }
  const id = els.memoId.value;
  const payload = {
    title: els.memoHeading.value.trim().slice(0, 40),
    items,
    remindAt: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(els.memoRemind.value) ? els.memoRemind.value : '',
    pinned: els.memoPin.checked
  };
  if (id) {
    const memo = state.memos.find((m) => m.id === id);
    if (memo) Object.assign(memo, payload, { updatedAt: Date.now() });
  } else {
    state.memos.push({ id: `me-${Date.now().toString(36)}`, createdAt: Date.now(), updatedAt: Date.now(), ...payload });
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
  const rows = collectMemoRows();
  if (!rows.length) {
    toast('先写点内容');
    return;
  }
  const heading = els.memoHeading.value.trim() || rows[0].text;
  const note = rows.map((row) => row.text).join('；').slice(0, 120);
  closeDialog(els.memoDialog);
  openEditor(null, { title: heading.slice(0, 40), note, category: 'calendar' });
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

/* ---------------- 平台判断 ---------------- */

function isIOS() {
  return /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/* ---------------- Web Push ---------------- */

async function refreshPushUI() {
  if (!els.pushStatus) return;
  els.pushTestBtn.hidden = true;
  if (!pushSupported()) {
    els.pushStatus.textContent = '这个浏览器不支持 Web Push；电脑上先靠上面的「打开应用时提醒」。';
    els.pushToggleBtn.hidden = true;
    return;
  }
  if (isIOS() && !isStandalone()) {
    els.pushStatus.textContent = 'iPhone 要先把应用「添加到主屏幕」，再从主屏幕打开，才能开启推送。';
    els.pushToggleBtn.hidden = true;
    return;
  }
  if (!workerUrl()) {
    els.pushStatus.textContent = '推送服务还没部署好（Worker 地址一填上就能开）。';
    els.pushToggleBtn.hidden = true;
    return;
  }
  els.pushToggleBtn.hidden = false;
  let sub = null;
  try {
    sub = await currentSubscription();
  } catch (err) {
    sub = null;
  }
  if (sub) {
    els.pushToggleBtn.textContent = '关闭推送';
    els.pushTestBtn.hidden = false;
    els.pushStatus.textContent = Notification.permission === 'granted'
      ? '这台设备已开启推送：到点前按你设的提前量推一条系统通知。'
      : '这台设备登记过了，但系统通知权限被关掉了，去浏览器设置里放开。';
  } else {
    els.pushToggleBtn.textContent = '开启推送';
    els.pushStatus.textContent = '还没开启。开启后会登记这台设备，到点前按提前量推送。';
  }
}

async function onPushToggle() {
  els.pushToggleBtn.disabled = true;
  try {
    const sub = await currentSubscription().catch(() => null);
    if (sub) {
      await disablePush();
      toast('已关闭推送');
    } else {
      await enablePush();
      toast('推送已开启');
    }
  } catch (err) {
    toast(err.message || '推送操作失败');
  } finally {
    els.pushToggleBtn.disabled = false;
    await refreshPushUI();
  }
}

async function onPushTest() {
  els.pushTestBtn.disabled = true;
  try {
    await sendTestPush();
    toast('测试推送已发出');
  } catch (err) {
    toast(err.message || '测试推送失败');
  } finally {
    els.pushTestBtn.disabled = false;
  }
}

/* ---------------- Canvas 作业导入 ---------------- */

async function onCanvasSync() {
  els.canvasSyncBtn.disabled = true;
  els.canvasSyncBtn.textContent = '正在从 Canvas 拉取…';
  try {
    const result = await triggerCanvasSync();
    if (result && result.ok === false && result.reason === 'no-feed') {
      toast('还没配置 Canvas 订阅地址');
    } else {
      await syncNow(true);
      toast(`Canvas：新增 ${result.created || 0} 条，更新 ${result.updated || 0} 条，跳过 ${result.skipped || 0} 条`);
    }
  } catch (err) {
    toast(err.message || '拉取 Canvas 失败');
  } finally {
    els.canvasSyncBtn.disabled = false;
    els.canvasSyncBtn.textContent = '从 Canvas 拉作业';
  }
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

/* ---------------- install / sw / 更新 ---------------- */

const hadController = 'serviceWorker' in navigator && Boolean(navigator.serviceWorker.controller);
let updateCheckedAt = 0;
let reloadingForUpdate = false;

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (!/^https?:$/.test(location.protocol)) return;
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker 注册失败', err));
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloadingForUpdate) return;
    reloadingForUpdate = true;
    toast('已更新，正在刷新…');
    setTimeout(() => location.reload(), 400);
  });
  setTimeout(() => checkForUpdate(false), 4000);
}

async function checkForUpdate(manual = false) {
  if (!('serviceWorker' in navigator)) {
    if (manual) toast('这个浏览器不支持 Service Worker');
    return;
  }
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) {
      if (manual) toast('Service Worker 还没装好');
      return;
    }
    await reg.update();
    updateCheckedAt = Date.now();
    if (manual) {
      const pending = reg.installing || reg.waiting;
      toast(pending ? '发现新版本，正在切换…' : `已经是最新版本（${BUILD}）`);
    }
  } catch (err) {
    if (manual) toast('检查更新失败，稍后再试');
  }
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
    refreshPushUI();
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
  els.memoAddItem.addEventListener('click', () => {
    const row = memoItemRow('');
    els.memoItems.append(row);
    row.querySelector('input[type="text"]').focus();
  });
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

  els.pushToggleBtn.addEventListener('click', onPushToggle);
  els.pushTestBtn.addEventListener('click', onPushTest);
  els.checkUpdateBtn.addEventListener('click', () => checkForUpdate(true));
  els.canvasSyncBtn.addEventListener('click', onCanvasSync);
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

  setupSwipe();

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (lastRenderedDay !== todayISO()) renderAll();
    if (Date.now() - updateCheckedAt > 5 * 60 * 1000) checkForUpdate(false);
    if (state.settings.sync.token && state.settings.sync.gistId) syncNow(false);
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

/* ---------------- 左右滑动切板块 ---------------- */

const TAB_ORDER = ['countdown', 'memos', 'mail'];
let swipeStart = null;

function setupSwipe() {
  const root = document.querySelector('.app');
  if (!root) return;
  const dialogOpen = () => [...document.querySelectorAll('dialog')].some((dialog) => dialog.open);

  root.addEventListener('touchstart', (event) => {
    if (event.touches.length !== 1 || dialogOpen()) {
      swipeStart = null;
      return;
    }
    const touch = event.touches[0];
    swipeStart = { x: touch.clientX, y: touch.clientY, at: Date.now() };
  }, { passive: true });

  root.addEventListener('touchend', (event) => {
    if (!swipeStart || dialogOpen()) {
      swipeStart = null;
      return;
    }
    const touch = event.changedTouches[0];
    const dx = touch.clientX - swipeStart.x;
    const dy = touch.clientY - swipeStart.y;
    const elapsed = Date.now() - swipeStart.at;
    swipeStart = null;
    if (elapsed > 900) return;
    if (Math.abs(dx) < 70 || Math.abs(dy) > 60 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
    const index = TAB_ORDER.indexOf(tab);
    const nextIndex = dx < 0 ? index + 1 : index - 1;
    if (index < 0 || nextIndex < 0 || nextIndex >= TAB_ORDER.length) return;
    setTab(TAB_ORDER[nextIndex]);
  }, { passive: true });
}

function boot() {
  state = loadState();
  applyTheme();
  consumeSyncHash();
  wire();
  if (els.aboutLine) els.aboutLine.textContent = `PolyU 备忘录 · ${BUILD} · 本地优先`;
  setTab('countdown');
  renderAll();
  registerServiceWorker();
  if (state.settings.sync.token && state.settings.sync.gistId) setTimeout(() => syncNow(false), 800);
}

boot();
