import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  addWorkingDays,
  buildIcs,
  fetchAdjustments,
  formatDay,
  latestEffective,
  loadHolidays,
  mergeWindows,
  MissingHolidayError,
  parseDay,
  summaryOf,
  toWindow,
  visibleWindows,
} from '../scripts/update.mjs';

const API_ROW = { DIM_DATE: '2026-11-13 00:00:00', VALUE: 9660, CY_JG: 8600, QY_FD: -645, CY_FD: -625 };
const WINDOW = {
  date: '2026-11-12',
  effective: '2026-11-13',
  gasolinePrice: 9660,
  dieselPrice: 8600,
  gasolineChange: -645,
  dieselChange: -625,
  direction: 'down',
};

// 2026 年 9—10 月的放假与调休安排
const HOLIDAYS_2026 = new Map(
  Object.entries({
    '2026-09-20': false, // 调休上班的周日
    '2026-09-25': true,
    '2026-09-26': true,
    '2026-09-27': true,
    '2026-10-01': true,
    '2026-10-02': true,
    '2026-10-03': true,
    '2026-10-04': true,
    '2026-10-05': true,
    '2026-10-06': true,
    '2026-10-07': true,
    '2026-10-10': false, // 调休上班的周六
  }),
);
const COVERED_2026 = new Set([2026]);

const originalFetch = globalThis.fetch;
const jsonResponse = (payload) => new Response(JSON.stringify(payload), { status: 200 });

/** 用假的 fetch 替换网络请求，收集请求过的 URL */
function stubFetch(responses) {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return jsonResponse(responses[urls.length - 1]);
  };
  return urls;
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('toWindow 把执行日换算成调价窗口日', () => {
  assert.deepEqual(toWindow(API_ROW), WINDOW);
  assert.equal(toWindow({ DIM_DATE: null }), null);
});

test('toWindow 处理幅度缺失与持平', () => {
  assert.equal(toWindow({ DIM_DATE: '2000-06-06 00:00:00', VALUE: 2935, CY_JG: 2430 }).direction, 'unknown');
  assert.equal(toWindow({ ...API_ROW, QY_FD: 0 }).direction, 'unchanged');
  assert.equal(toWindow({ ...API_ROW, QY_FD: 345 }).direction, 'up');
});

test('fetchAdjustments 按页码翻页并组装过滤条件', async () => {
  const urls = stubFetch([
    {
      success: true,
      result: { pages: 2, data: [API_ROW] },
    },
    {
      success: true,
      result: { pages: 2, data: [{ ...API_ROW, DIM_DATE: '2026-10-30 00:00:00', VALUE: 10305, QY_FD: 345 }] },
    },
  ]);
  const windows = await fetchAdjustments('2026-09-30');

  assert.equal(windows.length, 2);
  assert.deepEqual(windows.map((window) => window.date), ['2026-10-29', '2026-11-12']);
  assert.equal(new URL(urls[0]).searchParams.get('filter'), "(DIM_DATE>'2026-09-30')");
  assert.equal(new URL(urls[1]).searchParams.get('pageNumber'), '2');
});

test('fetchAdjustments 空结果不算错误', async () => {
  stubFetch([{ success: false, code: 9201, message: '返回数据为空' }]);
  assert.deepEqual(await fetchAdjustments('2026-11-13'), []);
});

test('fetchAdjustments 接口失败时抛错', async () => {
  stubFetch([{ success: false, code: 500, message: 'boom' }]);
  await assert.rejects(() => fetchAdjustments(null), /boom/);
});

test('mergeWindows 按窗口日合并并去重', () => {
  const older = { ...WINDOW, date: '2026-10-29', effective: '2026-10-30' };
  const merged = mergeWindows([older, WINDOW], [{ ...WINDOW, gasolinePrice: 9600 }]);
  assert.deepEqual(merged.map((window) => window.date), ['2026-10-29', '2026-11-12']);
  assert.equal(merged[1].gasolinePrice, 9600);
});

test('latestEffective 给出增量抓取的起点', () => {
  assert.equal(latestEffective([]), '');
  assert.equal(
    latestEffective([WINDOW, { ...WINDOW, date: '2026-10-29', effective: '2026-10-30' }]),
    '2026-11-13',
  );
});

test('addWorkingDays 跳过假期、计入调休上班日', () => {
  assert.equal(
    formatDay(addWorkingDays(parseDay('2026-09-24'), 10, HOLIDAYS_2026, COVERED_2026)),
    '2026-10-15',
  );
  assert.equal(
    formatDay(addWorkingDays(parseDay('2026-10-15'), 10, HOLIDAYS_2026, COVERED_2026)),
    '2026-10-29',
  );
});

test('addWorkingDays 缺少节假日数据时报错', () => {
  assert.throws(
    () => addWorkingDays(parseDay('2026-12-25'), 10, HOLIDAYS_2026, COVERED_2026),
    MissingHolidayError,
  );
});

test('summaryOf 依据幅度给出摘要', () => {
  assert.equal(summaryOf(WINDOW), '油价下调');
  assert.equal(summaryOf({ ...WINDOW, direction: 'up' }), '油价上调');
  assert.equal(summaryOf({ ...WINDOW, direction: 'unchanged' }), '油价不作调整');
  assert.equal(summaryOf({ ...WINDOW, direction: 'unknown' }), '油价调整');
});

test('visibleWindows 只保留最近两年的已公布窗口', () => {
  const windows = [
    { ...WINDOW, date: '2024-01-01', effective: '2024-01-02' },
    { ...WINDOW, date: '2024-12-01', effective: '2024-12-02' },
  ];
  assert.deepEqual(
    visibleWindows(windows, parseDay('2026-11-23')).map((window) => window.date),
    ['2024-12-01'],
  );
});

test('loadHolidays 往年用本地缓存，当年才联网刷新', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'oil-holidays-'));
  test.after(() => rm(cacheDir, { recursive: true, force: true }));
  const year2025 = { year: 2025, days: [{ date: '2025-01-01', isOffDay: true }] };
  await writeFile(join(cacheDir, '2025.json'), JSON.stringify(year2025));
  await writeFile(join(cacheDir, '2026.json'), JSON.stringify({ year: 2026, days: [] }));

  const urls = stubFetch([{ year: 2026, days: [{ date: '2026-01-01', isOffDay: true }] }]);
  const { holidays, covered } = await loadHolidays(new Set([2025, 2026]), {
    today: parseDay('2026-06-01'),
    cacheDir,
  });

  assert.equal(urls.length, 1, '只应刷新当年数据');
  assert.ok(urls[0].includes('2026.json'));
  assert.ok(covered.has(2025) && covered.has(2026));
  assert.equal(holidays.get('2025-01-01'), true);
  assert.deepEqual(JSON.parse(await readFile(join(cacheDir, '2026.json'), 'utf8')).days, [
    { date: '2026-01-01', isOffDay: true },
  ]);
});

test('loadHolidays 刷新失败时退回本地缓存', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'oil-holidays-'));
  test.after(() => rm(cacheDir, { recursive: true, force: true }));
  await writeFile(
    join(cacheDir, '2026.json'),
    JSON.stringify({ year: 2026, days: [{ date: '2026-10-01', isOffDay: true }] }),
  );
  globalThis.fetch = async () => {
    throw new Error('network down');
  };

  const { holidays, covered } = await loadHolidays(new Set([2026]), {
    today: parseDay('2026-06-01'),
    cacheDir,
  });
  assert.ok(covered.has(2026));
  assert.equal(holidays.get('2026-10-01'), true);
});

test('loadHolidays 无缓存且无网络时跳过该年', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'oil-holidays-'));
  test.after(() => rm(cacheDir, { recursive: true, force: true }));
  globalThis.fetch = async () => {
    throw new Error('network down');
  };
  const { covered } = await loadHolidays(new Set([2027]), { today: parseDay('2026-06-01'), cacheDir });
  assert.equal(covered.size, 0);
});

test('buildIcs 结构完整', () => {
  const ics = buildIcs([WINDOW], [parseDay('2026-11-26')], '20261123T043000Z');
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  assert.equal(ics.match(/BEGIN:VEVENT/g).length, 2);
  assert.ok(ics.includes('STATUS:CONFIRMED'));
  assert.ok(ics.includes('STATUS:TENTATIVE'));
  assert.ok(ics.includes('SUMMARY:油价下调'));
  assert.ok(ics.includes('DTSTART;VALUE=DATE:20261112'));
  assert.ok(ics.includes('DTEND;VALUE=DATE:20261113'));
  assert.ok(ics.includes('UID:oil-pricing-20261112@'));
  assert.ok(ics.replace(/\r\n /g, '').includes('汽油：9660 元/吨（较上期 -645 元/吨）'));
});

test('buildIcs 每行不超过 75 字节且折行可还原', () => {
  const ics = buildIcs([WINDOW], [parseDay('2026-11-26')], '20261123T043000Z');
  const unfolded = ics.replace(/\r\n /g, '');
  for (const line of ics.split('\r\n')) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, line);
  }
  assert.ok(
    unfolded
      .split('\r\n')
      .some((line) => line.startsWith('DESCRIPTION:执行时间：2026-11-12 24:00')),
  );
});

test('buildIcs 转义特殊字符', () => {
  const ics = buildIcs([{ ...WINDOW, date: '2026-11-12' }], [], '20261123T043000Z');
  assert.ok(!ics.replace(/\r\n/g, '').includes('\n'));
});
