#!/usr/bin/env node
/**
 * 生成国内成品油调价日历（oil-pricing.ics）。
 *
 * 数据来源（均公开、免费、无需申请）：
 *
 * 1. 东方财富数据中心「汽柴油历史调价」：https://data.eastmoney.com/cjsj/oil_default.html
 *    结构化 JSON 接口（reportName=RPTA_WEB_YJ_BD），一次拿到调价日期、调价幅度与汽柴油价格，
 *    不需要解析网页；支持按日期过滤，只拉取本地还缺的增量。
 * 2. NateScarlet/holiday-cn：国务院办公厅节假日安排的机器可读版本，
 *    用于按“每 10 个工作日一调”的机制推算未来的调价窗口。
 *
 * 用法：
 *   node scripts/update.mjs              # 增量抓取 + 生成 ics
 *   node scripts/update.mjs --full       # 忽略缓存，重新拉取全部历史
 *   node scripts/update.mjs --today 2027-01-01
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..');
export const DATA_FILE = resolve(ROOT, 'data', 'adjustments.json');
export const HOLIDAY_CACHE_DIR = resolve(ROOT, 'data', 'holidays');
export const ICS_FILE = resolve(ROOT, 'oil-pricing.ics');

export const DATA_PAGE = 'https://data.eastmoney.com/cjsj/oil_default.html';
const API_ENDPOINT = 'https://datacenter-web.eastmoney.com/api/data/v1/get';
const API_REPORT = 'RPTA_WEB_YJ_BD';
const API_PAGE_SIZE = 1000;
// 节假日数据：GitHub 原始地址，失败时回退到 jsDelivr 镜像；拉到后落盘到 data/holidays，避免每周重复下载
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
const HISTORY_DAYS = 730; // 日历中保留的已公布窗口时长
const WORKING_DAYS_PER_CYCLE = 10;

export function log(message) {
  console.error(message);
}

// --------------------------------------------------------------------------
// 日期工具
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
          Accept: 'application/json,text/html;q=0.8,*/*;q=0.5',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          Referer: DATA_PAGE,
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

// --------------------------------------------------------------------------
// 抓取调价记录（东方财富数据中心）
// --------------------------------------------------------------------------

const isEmptyResult = (payload) => payload.success === false && payload.code === 9201;

/** 接口返回的一行 -> 调价窗口记录 */
export function toWindow(row) {
  const effective = String(row.DIM_DATE ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effective)) return null;

  const toNumber = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const gasolineChange = toNumber(row.QY_FD);
  const dieselChange = toNumber(row.CY_FD);
  let direction = 'unknown';
  if (gasolineChange !== null) {
    direction = gasolineChange > 0 ? 'up' : gasolineChange < 0 ? 'down' : 'unchanged';
  }

  return {
    // 调价窗口日＝公告日；数据中心记录的是执行日（公告当日 24 时起）
    date: formatDay(addDays(parseDay(effective), -1)),
    effective,
    gasolinePrice: toNumber(row.VALUE),
    dieselPrice: toNumber(row.CY_JG),
    gasolineChange,
    dieselChange,
    direction,
  };
}

/**
 * 拉取调价记录。
 * @param {string|null} since 只拉取执行日在此之后的数据（增量），为 null 时拉全部历史
 */
export async function fetchAdjustments(since = null) {
  const windows = [];
  let pages = 1;
  const maxPages = 20;
  for (let page = 1; page <= Math.min(pages, maxPages); page += 1) {
    const params = new URLSearchParams({
      reportName: API_REPORT,
      columns: 'ALL',
      sortColumns: 'DIM_DATE',
      sortTypes: '1',
      pageNumber: String(page),
      pageSize: String(API_PAGE_SIZE),
      source: 'WEB',
    });
    if (since) params.set('filter', `(DIM_DATE>'${since}')`);

    const payload = JSON.parse(await fetchText(`${API_ENDPOINT}?${params}`));
    if (isEmptyResult(payload)) {
      log('接口返回空数据，本地已是最新');
      break;
    }
    if (!payload.success) throw new Error(`接口返回失败：${payload.message ?? payload.code}`);

    const rows = payload.result?.data ?? [];
    for (const row of rows) {
      const window = toWindow(row);
      if (window) windows.push(window);
    }
    pages = payload.result?.pages ?? 1;
    log(`第 ${page}/${pages} 页：${rows.length} 条调价记录`);
  }
  return windows.sort((a, b) => a.date.localeCompare(b.date));
}

export const latestEffective = (windows) =>
  windows.reduce((latest, window) => (window.effective > latest ? window.effective : latest), '');

/** 按窗口日合并，新数据覆盖旧数据 */
export function mergeWindows(cached, fetched) {
  const merged = new Map(cached.map((window) => [window.date, window]));
  for (const window of fetched) merged.set(window.date, window);
  return [...merged.values()].sort((a, b) => a.date.localeCompare(b.date));
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
export async function loadHolidays(years, { today = new Date(), cacheDir = HOLIDAY_CACHE_DIR } = {}) {
  const holidays = new Map();
  const covered = new Set();
  for (const year of [...years].sort((a, b) => a - b)) {
    // 往年安排已经定稿，直接用本地缓存；当年与次年可能刚发布或微调，尝试刷新
    const payload = await loadHolidayYear(year, {
      cacheDir,
      refresh: year >= today.getUTCFullYear(),
    });
    if (!payload) continue;
    for (const entry of payload.days) holidays.set(entry.date, Boolean(entry.isOffDay));
    covered.add(year);
    log(`已加载 ${year} 年节假日安排（${payload.days.length} 天）`);
  }
  return { holidays, covered };
}

/** 读取某一年的节假日安排，优先本地缓存；刷新失败时退回缓存 */
async function loadHolidayYear(year, { cacheDir, refresh }) {
  const file = resolve(cacheDir, `${year}.json`);
  const cached = await readCacheFile(file);
  if (cached && !refresh) return cached;

  for (const template of HOLIDAY_URLS) {
    const url = template.replace('{year}', String(year));
    try {
      const text = await fetchText(url, { retries: 1, timeoutMs: 8000 });
      const payload = JSON.parse(text);
      if (payload.year !== year || !Array.isArray(payload.days) || payload.days.length === 0) continue;
      await mkdir(cacheDir, { recursive: true });
      await writeFile(file, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
      return payload;
    } catch (error) {
      log(`节假日数据不可用 ${url}: ${error.message}`);
    }
  }
  if (cached) log(`${year} 年节假日数据刷新失败，使用本地缓存`);
  return cached;
}

async function readCacheFile(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
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
  const { holidays, covered } = await loadHolidays(years, { today });

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
  if (window.direction === 'up') return '油价上调';
  if (window.direction === 'down') return '油价下调';
  if (window.direction === 'unchanged') return '油价不作调整';
  return '油价调整';
}

const signed = (value) => (value > 0 ? `+${value}` : String(value));

function confirmedEvent(window, stamp) {
  const day = parseDay(window.date);
  const effective = parseDay(window.effective);
  const priceLine = (label, price, change) => {
    if (price === null) return null;
    const suffix = change === null ? '' : `（较上期 ${signed(change)} 元/吨）`;
    return `${label}：${price} 元/吨${suffix}`;
  };
  const description = [
    `执行时间：${window.date} 24:00（即 ${window.effective} 00:00 起执行新价格）`,
    priceLine('汽油', window.gasolinePrice, window.gasolineChange),
    priceLine('柴油', window.dieselPrice, window.dieselChange),
    `数据来源：东方财富数据中心 ${DATA_PAGE}`,
  ]
    .filter(Boolean)
    .join('\n');

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
    `URL:${DATA_PAGE}`,
    'END:VEVENT',
  ];
}

function predictedEvent(day, stamp) {
  const description = [
    '按“每 10 个工作日一调”的机制推算出的调价窗口，尚未公布，',
    '最终以国家发展改革委公告为准。',
    `数据来源：${DATA_PAGE}`,
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
    `URL:${DATA_PAGE}`,
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
    `X-WR-CALDESC:${escapeText('国内成品油调价窗口。数据来源：东方财富数据中心。')}`,
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

/** 日历只保留最近一段时间内的已公布窗口，更早的记录仍在 data/adjustments.json 里 */
export const visibleWindows = (windows, today) => {
  const floor = addDays(today, -HISTORY_DAYS);
  return windows.filter((window) => parseDay(window.date) >= floor);
};

/** '2026-11-23T12:36:21Z' -> '20261123T123621Z' */
export const stampOf = (updatedIso) => updatedIso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

// --------------------------------------------------------------------------
// 主流程
// --------------------------------------------------------------------------

export async function loadCache() {
  try {
    const payload = JSON.parse(await readFile(DATA_FILE, 'utf8'));
    const windows = Array.isArray(payload.windows) ? payload.windows : [];
    if (windows.some((window) => typeof window.effective !== 'string')) {
      log('缓存是旧格式，重新拉取全部历史');
      return { source: DATA_PAGE, updated: null, windows: [] };
    }
    return { source: DATA_PAGE, updated: null, ...payload, windows };
  } catch (error) {
    if (error.code !== 'ENOENT') log(`缓存文件不可用，重新生成：${error.message}`);
    return { source: DATA_PAGE, updated: null, windows: [] };
  }
}

function parseArgs(argv) {
  const args = { today: null, full: false, help: false };
  for (const flag of argv) {
    if (flag === '--full') args.full = true;
    else if (flag === '--help' || flag === '-h') args.help = true;
    else if (flag.startsWith('--today=')) args.today = flag.slice('--today='.length);
    else throw new Error(`未知参数：${flag}`);
  }
  if (args.today && !/^\d{4}-\d{2}-\d{2}$/.test(args.today)) throw new Error('--today 需要 YYYY-MM-DD');
  return args;
}

const USAGE = '用法：node scripts/update.mjs [--full] [--today YYYY-MM-DD]';

export async function main(argv = []) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const today = args.today ? parseDay(args.today) : parseDay(formatDay(new Date()));
  const cache = await loadCache();
  const cached = [...cache.windows].sort((a, b) => a.date.localeCompare(b.date));

  const since = args.full ? null : latestEffective(cached) || null;
  let fetched;
  try {
    if (since) log(`增量抓取：只取执行日晚于 ${since} 的记录（已在缓存中的不再重复拉取）`);
    fetched = await fetchAdjustments(since);
  } catch (error) {
    log(`抓取失败：${error.message}`);
    if (cached.length === 0) {
      log('没有任何缓存数据，放弃生成');
      return 1;
    }
    log('沿用上次缓存的数据继续生成');
    fetched = [];
  }

  const windows = mergeWindows(cached, fetched);
  const changed = JSON.stringify(windows) !== JSON.stringify(cached);
  const updated = changed || !cache.updated ? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') : cache.updated;
  if (!changed) log('调价记录没有变化');
  else log(`新增 ${windows.length - cached.length} 条调价记录`);

  const horizon = addDays(today, PREDICT_HORIZON_DAYS);
  const predicted = await predictWindows(windows, today, horizon);
  if (predicted.length > 0) log(`推算出的后续窗口：${predicted.map(formatDay).join('、')}`);

  await mkdir(dirname(DATA_FILE), { recursive: true });
  await writeFile(
    DATA_FILE,
    JSON.stringify({ source: DATA_PAGE, updated, windows }, null, 2) + '\n',
    'utf8',
  );
  const visible = visibleWindows(windows, today);
  await writeFile(ICS_FILE, buildIcs(visible, predicted, stampOf(updated)), 'utf8');
  log(
    `已写入 data/adjustments.json（${windows.length} 条记录）与 oil-pricing.ics` +
      `（${visible.length} 条已公布 + ${predicted.length} 条预测）`,
  );
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
