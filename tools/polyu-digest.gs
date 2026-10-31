/**
 * PolyU 备忘录 · 每日邮件摘要（Google Apps Script）
 * ------------------------------------------------------------
 * 作用：每天固定时间读 Gmail 里「学校」标签下的邮件，挑出值得看的，
 *       把摘要写进你 PolyU 备忘录的同一个私有 Gist，App 里「邮件」页直接显示。
 *
 * 一次性配置（约 15 分钟）：
 *   1. Outlook 里设规则，把 PolyU 邮件转发到你的 Gmail（例如 7et3rnity@gmail.com）。
 *   2. Gmail 里建过滤器：来自 polyu / connect.polyu.hk 的邮件打上「学校」标签。
 *   3. 在 PolyU 备忘录 → 设置 → 同步，填 GitHub token 并「连接 / 新建」，拿到 Gist ID。
 *   4. 打开 script.google.com → 新建项目 → 把本文件内容整份粘贴进去。
 *   5. 改下面 CONFIG 里的 GIST_ID 和 GITHUB_TOKEN（token 只勾 Gist 读写）。
 *   6. 项目设置 → 时区选 (GMT+08:00) 香港；先手动运行一次 testDigest 看日志。
 *   7. 运行 installTrigger，之后每天 12:30 自动跑（想改时间就改 installTrigger 里的 12 / 30）。
 *
 * 注意：token 写在脚本里，只存在你自己的 Google 账号，别把项目分享给别人。
 */

const CONFIG = {
  GIST_ID: '在这里填你的 Gist ID',
  GITHUB_TOKEN: '在这里填 GitHub token（只要 Gist 读写权限）',
  LABEL: '学校',
  WINDOW_DAYS: 2,
  MAX_THREADS: 30,
  MAX_ITEMS: 12,
  TIMEZONE: 'Asia/Hong_Kong'
};

const CATEGORY_RULES = [
  { tag: '缴费', re: /学费|缴费|费用|tuition|fee|payment|invoice/i },
  { tag: '选课', re: /选课|加选|退选|add\s*\/?\s*drop|subject\s+registration|course\s+selection|timetable|课表/i },
  { tag: '学业', re: /考试|考核|作业|论文|assignment|exam|assessment|thesis|submission/i },
  { tag: '住宿', re: /宿舍|舍堂|住宿|hall|hostel|accommodation|residence/i },
  { tag: '签证', re: /签证|签注|visa|immigration|逗留/i },
  { tag: '实习', re: /实习|internship|placement|work\s+experience/i },
  { tag: '活动', re: /讲座|工作坊|研讨会|比赛|活动|seminar|workshop|competition|recruitment\s+talk|career\s+fair/i },
  { tag: '奖学金', re: /奖学金|scholarship|bursary|grant/i }
];

const URGENT_RE = /urgent|important|action\s+required|deadline|截止|务必|尽快|立即|reminder|final\s+call/i;

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12
};

function dailyDigest() {
  const digest = buildDigest();
  writeDigest(digest);
  Logger.log('已写入摘要：%s 封，生成时间 %s', digest.items.length, digest.generatedAt);
}

function testDigest() {
  const digest = buildDigest();
  Logger.log(JSON.stringify(digest, null, 2));
  return digest;
}

function buildDigest() {
  const now = new Date();
  const query = `label:${CONFIG.LABEL} newer_than:${CONFIG.WINDOW_DAYS}d -in:spam -in:trash`;
  const threads = GmailApp.search(query, 0, CONFIG.MAX_THREADS);
  const seen = {};
  const items = [];

  for (const thread of threads) {
    const messages = thread.getMessages();
    const message = messages[messages.length - 1];
    const id = message.getId();
    if (seen[id]) continue;
    seen[id] = true;

    const subject = (message.getSubject() || '').trim();
    const from = (message.getFrom() || '').trim();
    const receivedAt = message.getDate().toISOString();
    const body = (message.getPlainBody() || '').replace(/\s+/g, ' ').trim();
    const haystack = `${subject} ${body.slice(0, 600)}`;

    const tags = [];
    for (const rule of CATEGORY_RULES) {
      if (rule.re.test(haystack)) tags.push(rule.tag);
    }
    const importance = URGENT_RE.test(haystack) ? 'high' : 'normal';
    if (importance === 'high' && tags.indexOf('重要') < 0) tags.unshift('重要');

    items.push({
      id: id,
      subject: subject || '（无主题）',
      from: from,
      receivedAt: receivedAt,
      snippet: body.slice(0, 220),
      tags: tags.slice(0, 4),
      importance: importance,
      suggestedDate: extractDate(haystack, now),
      url: 'https://mail.google.com/mail/u/0/#all/' + id
    });
  }

  items.sort((a, b) => {
    if (a.importance !== b.importance) return a.importance === 'high' ? -1 : 1;
    return String(b.receivedAt).localeCompare(String(a.receivedAt));
  });

  return {
    generatedAt: now.toISOString(),
    mode: 'rules',
    windowDays: CONFIG.WINDOW_DAYS,
    scanned: threads.length,
    items: items.slice(0, CONFIG.MAX_ITEMS)
  };
}

function extractDate(text, now) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const candidates = [];
  let m;

  const full = /(20\d{2})\s*[年\-/.]\s*(\d{1,2})\s*[月\-/.]\s*(\d{1,2})/g;
  while ((m = full.exec(text)) !== null) {
    candidates.push(makeDate(Number(m[1]), Number(m[2]), Number(m[3])));
  }

  const cn = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/g;
  while ((m = cn.exec(text)) !== null) {
    candidates.push(makeDate(now.getFullYear(), Number(m[1]), Number(m[2])));
  }

  const dmy = /(\d{1,2})\s*(jan|feb|mar|apr|may|jun|jul|aug|sept|sep|oct|nov|dec)[a-z]*\.?,?\s*(20\d{2})?/gi;
  while ((m = dmy.exec(text)) !== null) {
    const month = MONTHS[m[2].toLowerCase()];
    if (month) candidates.push(makeDate(Number(m[3] || now.getFullYear()), month, Number(m[1])));
  }

  const mdy = /(jan|feb|mar|apr|may|jun|jul|aug|sept|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(20\d{2})?/gi;
  while ((m = mdy.exec(text)) !== null) {
    const month = MONTHS[m[1].toLowerCase()];
    if (month) candidates.push(makeDate(Number(m[3] || now.getFullYear()), month, Number(m[2])));
  }

  const valid = candidates
    .filter((d) => d && !isNaN(d.getTime()))
    .map((d) => {
      // 只写月日时，如果已经过去一个多月，认为说的是明年
      if (d.getFullYear() === now.getFullYear() && d.getTime() < today.getTime() - 30 * 86400000) {
        d.setFullYear(d.getFullYear() + 1);
      }
      return d;
    })
    .filter((d) => d.getTime() >= today.getTime() && d.getTime() <= today.getTime() + 365 * 86400000)
    .sort((a, b) => a.getTime() - b.getTime());

  return valid.length ? Utilities.formatDate(valid[0], CONFIG.TIMEZONE, 'yyyy-MM-dd') : '';
}

function makeDate(year, month, day) {
  if (!year || !month || !day) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return new Date(year, month - 1, day);
}

function writeDigest(digest) {
  if (!CONFIG.GIST_ID || CONFIG.GIST_ID.indexOf('在这里') === 0) {
    throw new Error('还没填 CONFIG.GIST_ID');
  }
  const response = UrlFetchApp.fetch('https://api.github.com/gists/' + CONFIG.GIST_ID, {
    method: 'patch',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + CONFIG.GITHUB_TOKEN,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    payload: JSON.stringify({
      files: {
        'polyu-digest.json': { content: JSON.stringify(digest, null, 2) }
      }
    }),
    muteHttpExceptions: true
  });
  const code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('写入 Gist 失败 ' + code + '：' + response.getContentText().slice(0, 300));
  }
}

/** 每天 12:30 跑一次。重复运行不会叠加多个触发器。 */
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach((trigger) => {
    if (trigger.getHandlerFunction() === 'dailyDigest') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('dailyDigest')
    .timeBased()
    .atHour(12)
    .nearMinute(30)
    .everyDays(1)
    .inTimezone(CONFIG.TIMEZONE)
    .create();
  Logger.log('触发器已安装：每天 12:30（%s）', CONFIG.TIMEZONE);
}
