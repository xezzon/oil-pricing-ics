#!/usr/bin/env node
/**
 * 生成国内成品油调价日历（oil-pricing.ics）。
 *
 * 数据来源（均公开、免费、无需申请）：
 *
 * 1. 国家发展改革委「新闻发布」栏目：https://www.ndrc.gov.cn/xwdt/xwfb/
 *    权威口径的调价公告（包括“不作调整”的窗口），由价格司发布。
 * 2. NateScarlet/holiday-cn：国务院办公厅节假日安排的机器可读版本，
 *    用于按“每 10 个工作日一调”的机制推算未来的调价窗口。
 *
 * 用法：
 *   node scripts/update.mjs              # 抓取 + 生成 ics
 *   node scripts/update.mjs --pages 16   # 首次回补更多历史
 *   node scripts/update.mjs --today 2027-01-01
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..');
export const DATA_FILE = resolve(ROOT, 'data', 'adjustments.json');
export const ICS_FILE = resolve(ROOT, 'oil-pricing.ics');

// 国家发展改革委 新闻动态 / 新闻发布（index.html 为第 1 页，index_1.html 为第 2 页……）
export const LIST_BASE = 'https://www.ndrc.gov.cn/xwdt/xwfb/';
// 节假日数据：GitHub 原始地址，失败时回退到 jsDelivr 镜像
export const HOLIDAY_URLS = [
  'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/{year}.json',
  'https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json',
];

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0 Safari/537.36 oil-pricing-ics/1.0';
export const REPO = process.env.GITHUB_REPOSITORY || 'xezzon/oil-pricing-ics';
const CALENDAR_NAME = '国内成品油调价日历';
const MS_PER_DAY = 86_400_000;
const PREDICT_HORIZON_DAYS = 365;
const WORKING_DAYS_PER_CYCLE = 10;

// 公告标题形如 “2026年11月12日国内成品油价格调整”
const TITLE_DATE_RE = /^(\d{4})年(\d{1,2})月(\d{1,2})日/;
// 文章地址形如 /xwdt/xwfb/202611/t20261112_1408795.html
const URL_DATE_RE = /\/t(\d{8})_\d+\.html/;
const ANCHOR_RE = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
const TAG_RE = /<[^>]+>/g;
// 无日期前缀的公告标题，仅接受明确指向调价的句式，避免把解读、评论类文章当成调价窗口
const UNDATED_TITLE_RE = /^(?:国家|国内|我国)[^，]{0,10}成品油价格/;
const SKIP_TITLE_RE = /答记者问|解读|图解|发布会/;

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  mdash: '—',
  hellip: '…',
  middot: '·',
};

export function log(message) {
  console.error(message);
}

// --------------------------------------------------------------------------
// 日期与网络工具
// --------------------------------------------------------------------------

/** 'YYYY-MM-DD' -> UTC 零点的 Date */
export function parseDay(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

export const formatDay = (date) => date.toISOString().slice(0, 10);
export const compactDay = (date) => formatDay(date).replaceAll('-', '');
export const addDays = (date, days) => new Date(date.getTime() + days * MS_PER_DAY);

export async function fetchText(url, { retries = 3, timeoutMs = 30_000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt + 1 < retries) await sleep(1000 * 2 ** attempt);
    }
  }
  throw new Error(`下载失败 ${url}: ${lastError?.message ?? lastError}`);
}

export function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (matched, body) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : matched;
    }
    return NAMED_ENTITIES[body] ?? matched;
  });
}

// --------------------------------------------------------------------------
// 抓取国家发改委公告
// --------------------------------------------------------------------------

export const pageUrl = (index) => LIST_BASE + (index === 0 ? 'index.html' : `index_${index}.html`);

/** 由标题推断 { status, direction } */
export function classify(title) {
  if (title.includes('不作调整') || title.includes('暂不')) return { status: 'unchanged', direction: 'none' };
  if (title.includes('下调')) return { status: 'adjusted', direction: 'down' };
  if (title.includes('上调')) return { status: 'adjusted', direction: 'up' };
  return { status: 'adjusted', direction: 'unknown' };
}

/** 从一个列表页中提取成品油调价公告 */
export function parseListPage(pageHtml) {
  const items = [];
  for (const match of pageHtml.matchAll(ANCHOR_RE)) {
    const [, href, rawTitle] = match;
    const title = decodeEntities(rawTitle.replace(TAG_RE, ''))
      .replace(/[\s\u00a0]+/g, ' ')
      .trim();
    if (!title || !title.includes('成品油') || SKIP_TITLE_RE.test(title)) continue;

    const urlDate = URL_DATE_RE.exec(href);
    if (!urlDate) continue;
    const compact = urlDate[1];
    const published = parseDay(`${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`);

    const titleDate = TITLE_DATE_RE.exec(title);
    let announced;
    if (titleDate) {
      announced = new Date(Date.UTC(Number(titleDate[1]), Number(titleDate[2]) - 1, Number(titleDate[3])));
    } else if (UNDATED_TITLE_RE.test(title)) {
      // 极少数公告标题不带日期（如 2024-04-16），用文章地址里的日期
      announced = published;
    } else {
      continue;
    }
    if (formatDay(announced) !== formatDay(published)) {
      // 标题日期与文章日期不一致，说明多半是评论/转发类文章
      log(`跳过日期不一致的条目：${title}`);
      continue;
    }

    items.push({
      date: formatDay(announced),
      title,
      url: href.startsWith('http') ? href : LIST_BASE + href.replace(/^[./]+/, ''),
      ...classify(title),
    });
  }
  return items;
}

/** 按日期合并，优先保留标题带日期的那一条公告 */
export function mergeItems(found, items) {
  for (const item of items) {
    const current = found.get(item.date);
    if (!current) {
      found.set(item.date, item);
      continue;
    }
    if (TITLE_DATE_RE.test(item.title) && !TITLE_DATE_RE.test(current.title)) {
      found.set(item.date, item);
    }
  }
}

export async function collectWindows(cached, maxPages) {
  const known = new Set(cached.map((item) => item.date));
  const found = new Map();
  for (let page = 0; page < maxPages; page += 1) {
    const items = parseListPage(await fetchText(pageUrl(page)));
    mergeItems(found, items);
    log(`第 ${page + 1} 页：${items.length} 条成品油公告`);
    if (known.size > 0 && items.length > 0 && items.every((item) => known.has(item.date))) {
      // 该页公告都已入库，更早的页面不会再带来新数据
      break;
    }
  }
  return [...found.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// --------------------------------------------------------------------------
// 节假日与调价窗口推算
// --------------------------------------------------------------------------

export class MissingHolidayError extends Error {
  constructor(day) {
    super(day);
    this.name = 'MissingHolidayError';
  }
}

/** 返回 { holidays: Map<日期, 是否放假>, covered: Set<年份> } */
export async function loadHolidays(years) {
  const holidays = new Map();
  const covered = new Set();
  for (const year of [...years].sort((a, b) => a - b)) {
    for (const template of HOLIDAY_URLS) {
      const url = template.replace('{year}', String(year));
      try {
        const payload = JSON.parse(await fetchText(url, { retries: 2, timeoutMs: 20_000 }));
        if (payload.year !== year || !Array.isArray(payload.days) || payload.days.length === 0) continue;
        for (const entry of payload.days) holidays.set(entry.date, Boolean(entry.isOffDay));
        covered.add(year);
        log(`已加载 ${year} 年节假日安排（${payload.days.length} 天）`);
        break;
      } catch (error) {
        log(`节假日数据不可用 ${url}: ${error.message}`);
      }
    }
  }
  return { holidays, covered };
}

/** 从 start 起第 count 个工作日：放假不算，调休上班日算 */
export function addWorkingDays(start, count, holidays, covered) {
  let current = start;
  let remaining = count;
  while (remaining > 0) {
    current = addDays(current, 1);
    if (!covered.has(current.getUTCFullYear())) throw new MissingHolidayError(formatDay(current));
    const isOffDay = holidays.get(formatDay(current));
    if (isOffDay === true) continue;
    if (isOffDay === false) {
      remaining -= 1; // 调休上班的周末
      continue;
    }
    const weekday = current.getUTCDay();
    if (weekday !== 0 && weekday !== 6) remaining -= 1;
  }
  return current;
}

/** 按“每 10 个工作日一调”推算尚未公布的窗口 */
export async function predictWindows(windows, today, horizon) {
  if (windows.length === 0) return [];
  const last = parseDay(windows.at(-1).date);
  const years = new Set();
  for (let year = last.getUTCFullYear(); year <= horizon.getUTCFullYear(); year += 1) years.add(year);
  const { holidays, covered } = await loadHolidays(years);

  const predicted = [];
  let current = last;
  for (let step = 0; step < 60; step += 1) {
    try {
      current = addWorkingDays(current, WORKING_DAYS_PER_CYCLE, holidays, covered);
    } catch (error) {
      if (!(error instanceof MissingHolidayError)) throw error;
      log(`缺少 ${error.message} 的节假日数据，停止推算`);
      break;
    }
    if (current > horizon) break;
    if (current >= today) predicted.push(current);
  }
  return predicted;
}

// --------------------------------------------------------------------------
// 生成 ics
// --------------------------------------------------------------------------

export function escapeText(value) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\n/g, '\\n');
}

/** 按 RFC 5545 折行：每行不超过 75 字节，折行不切断 UTF-8 字符 */
export function foldLine(line) {
  const chunks = [];
  let current = '';
  for (const char of line) {
    const limit = chunks.length === 0 ? 75 : 74; // 续行行首的单个空格占 1 字节
    if (Buffer.byteLength(current + char, 'utf8') > limit) {
      chunks.push(current);
      current = char;
    } else {
      current += char;
    }
  }
  chunks.push(current);
  return chunks.map((chunk, index) => (index === 0 ? chunk : ` ${chunk}`)).join('\r\n');
}

export function summaryOf(window) {
  if (window.status === 'unchanged') return '油价不作调整';
  if (window.direction === 'up') return '油价上调';
  if (window.direction === 'down') return '油价下调';
  return '油价调整';
}

function confirmedEvent(window, stamp) {
  const day = parseDay(window.date);
  const effect =
    window.status === 'unchanged'
      ? '本轮调价窗口不调整成品油价格。'
      : '新价格自公布当日 24:00 起执行。';
  const description = [
    `国家发展改革委公告：${window.title}`,
    `公告日期：${window.date}`,
    effect,
    `原文：${window.url}`,
  ].join('\n');
  return [
    'BEGIN:VEVENT',
    `UID:oil-pricing-${compactDay(day)}@${REPO}`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${compactDay(day)}`,
    `DTEND;VALUE=DATE:${compactDay(addDays(day, 1))}`,
    `SUMMARY:${escapeText(summaryOf(window))}`,
    `DESCRIPTION:${escapeText(description)}`,
    'CATEGORIES:油价',
    'STATUS:CONFIRMED',
    'TRANSP:TRANSPARENT',
    `URL:${window.url}`,
    'END:VEVENT',
  ];
}

function predictedEvent(day, stamp) {
  const description = [
    '按“每 10 个工作日一调”的机制推算出的调价窗口，尚未公布，',
    '最终以国家发展改革委公告为准。',
    `数据来源：${LIST_BASE}`,
  ].join('\n');
  return [
    'BEGIN:VEVENT',
    `UID:oil-pricing-${compactDay(day)}@${REPO}`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${compactDay(day)}`,
    `DTEND;VALUE=DATE:${compactDay(addDays(day, 1))}`,
    `SUMMARY:${escapeText('调价窗口（预测）')}`,
    `DESCRIPTION:${escapeText(description)}`,
    'CATEGORIES:油价',
    'STATUS:TENTATIVE',
    'TRANSP:TRANSPARENT',
    `URL:${LIST_BASE}`,
    'END:VEVENT',
  ];
}

export function buildIcs(windows, predicted, stamp) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//${REPO}//CN`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(CALENDAR_NAME)}`,
    `X-WR-CALDESC:${escapeText('国内成品油调价窗口。数据来源：国家发展改革委新闻发布栏目。')}`,
    'X-WR-TIMEZONE:Asia/Shanghai',
    'REFRESH-INTERVAL;VALUE=DURATION:P1W',
    'X-PUBLISHED-TTL:PT6H',
    `SOURCE;VALUE=URI:https://github.com/${REPO}`,
  ];

  const events = [
    ...windows.map((window) => ({ day: parseDay(window.date), kind: 'confirmed', window })),
    ...predicted.map((day) => ({ day, kind: 'predicted', window: null })),
  ].sort((a, b) => a.day - b.day || a.kind.localeCompare(b.kind));

  for (const event of events) {
    lines.push(...(event.kind === 'confirmed' ? confirmedEvent(event.window, stamp) : predictedEvent(event.day, stamp)));
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

/** '2026-11-23T12:36:21Z' -> '20261123T123621Z' */
export const stampOf = (updatedIso) => updatedIso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

// --------------------------------------------------------------------------
// 主流程
// --------------------------------------------------------------------------

export async function loadCache() {
  try {
    const payload = JSON.parse(await readFile(DATA_FILE, 'utf8'));
    return { source: LIST_BASE, updated: null, windows: [], ...payload };
  } catch (error) {
    if (error.code !== 'ENOENT') log(`缓存文件不可用，重新生成：${error.message}`);
    return { source: LIST_BASE, updated: null, windows: [] };
  }
}

function parseArgs(argv) {
  const args = { pages: 12, today: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--pages') args.pages = Number(argv[(index += 1)]);
    else if (flag === '--today') args.today = argv[(index += 1)];
    else if (flag === '--help' || flag === '-h') args.help = true;
    else throw new Error(`未知参数：${flag}`);
  }
  if (!Number.isInteger(args.pages) || args.pages < 1) throw new Error('--pages 需要正整数');
  if (args.today && !/^\d{4}-\d{2}-\d{2}$/.test(args.today)) throw new Error('--today 需要 YYYY-MM-DD');
  return args;
}

const USAGE = `用法：node scripts/update.mjs [--pages 12] [--today YYYY-MM-DD]`;

export async function main(argv = []) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const today = args.today ? parseDay(args.today) : parseDay(formatDay(new Date()));
  const cache = await loadCache();
  const cached = [...cache.windows].sort((a, b) => a.date.localeCompare(b.date));

  let fetched;
  try {
    fetched = await collectWindows(cached, args.pages);
  } catch (error) {
    log(`抓取失败：${error.message}`);
    if (cached.length === 0) {
      log('没有任何缓存数据，放弃生成');
      return 1;
    }
    log('沿用上次缓存的数据继续生成');
    fetched = cached;
  }

  const merged = new Map(cached.map((item) => [item.date, item]));
  mergeItems(merged, fetched);
  const windows = [...merged.values()].sort((a, b) => a.date.localeCompare(b.date));

  const changed = JSON.stringify(windows) !== JSON.stringify(cached);
  const updated = changed || !cache.updated ? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') : cache.updated;
  if (!changed) log('调价公告没有变化');

  const horizon = addDays(today, PREDICT_HORIZON_DAYS);
  const predicted = await predictWindows(windows, today, horizon);
  if (predicted.length > 0) log(`推算出的后续窗口：${predicted.map(formatDay).join('、')}`);

  await mkdir(dirname(DATA_FILE), { recursive: true });
  await writeFile(
    DATA_FILE,
    JSON.stringify({ source: LIST_BASE, updated, windows }, null, 2) + '\n',
    'utf8',
  );
  await writeFile(ICS_FILE, buildIcs(windows, predicted, stampOf(updated)), 'utf8');
  log(`已写入 data/adjustments.json（${windows.length} 条公告）与 oil-pricing.ics（${predicted.length} 条预测）`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      log(`意外错误：${error.stack ?? error}`);
      process.exitCode = 1;
    });
}
