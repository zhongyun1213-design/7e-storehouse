// 发版前跑一次：把 index.html 里 app.js / styles.css 的地址带上版本号。
// 这样即使设备上还跑着旧的 Service Worker，HTML 变了就会去拿新的 JS（缓存键不一样）。
// 用法：node tools/stamp.mjs

import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const versionSource = readFileSync(new URL('version.js', root), 'utf8');
const match = /BUILD = '([^']+)'/.exec(versionSource);
if (!match) throw new Error('version.js 里找不到 BUILD');

const slug = match[1].replace(/[^\w.]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
const htmlPath = new URL('index.html', root);
let html = readFileSync(htmlPath, 'utf8');

const before = html;
html = html
  .replace(/styles\.css(?:\?v=[^"']*)?/g, `styles.css?v=${slug}`)
  .replace(/app\.js(?:\?v=[^"']*)?/g, `app.js?v=${slug}`);

if (html === before) {
  console.log('index.html 已经是最新的版本戳：' + slug);
} else {
  writeFileSync(htmlPath, html, 'utf8');
  console.log('已写入版本戳：' + slug);
}
