import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addWorkingDays,
  buildIcs,
  classify,
  decodeEntities,
  formatDay,
  mergeItems,
  parseDay,
  parseListPage,
  MissingHolidayError,
} from '../scripts/update.mjs';

const LIST_PAGE = `
<ul class="u-list">
  <li><a href="./202611/t20261112_1408795.html" title="x">2026年11月12日国内成品油价格调整</a></li>
  <li><a href="./202610/t20261029_1408449.html">2026年10月29日国家再次实施调控，成品油价格适当调整</a></li>
  <li><a href="./202610/t20261015_1408170.html">2026年10月15日国内成品油价格不作调整</a></li>
  <li><a href="./202404/t20240416_1365703.html">国内成品油价格按机制调整</a></li>
  <li><a href="./202203/t20220317_1234567.html">国家发展改革委有关负责同志就成品油价格调整答记者问</a></li>
  <li><a href="./202206/t20220629_7654321.html">国际油价超过每桶130美元调控上限后国内成品油价格暂不再上调</a></li>
  <li><a href="./202611/t20261123_1409024.html">关于印发《&ldquo;一老一小&rdquo;服务体系建设实施方案》的通知</a></li>
</ul>
`;

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

test('parseListPage 只保留调价公告', () => {
  const items = parseListPage(LIST_PAGE);
  assert.deepEqual(
    items.map((item) => item.date),
    ['2026-11-12', '2026-10-29', '2026-10-15', '2024-04-16'],
  );
});

test('parseListPage 分类调价方向', () => {
  const byDate = new Map(parseListPage(LIST_PAGE).map((item) => [item.date, item]));
  assert.equal(byDate.get('2026-10-15').status, 'unchanged');
  assert.equal(byDate.get('2026-10-15').direction, 'none');
  assert.equal(byDate.get('2026-11-12').direction, 'unknown');
  assert.equal(classify('2025年4月17日24时起国内成品油价格按机制上调').direction, 'up');
  assert.equal(classify('2024年5月29日国内成品油价格按机制不作调整').direction, 'none');
});

test('parseListPage 用文章日期补全无日期标题', () => {
  const item = parseListPage(LIST_PAGE).find((entry) => entry.date === '2024-04-16');
  assert.equal(item.title, '国内成品油价格按机制调整');
  assert.equal(item.url, 'https://www.ndrc.gov.cn/xwdt/xwfb/202404/t20240416_1365703.html');
});

test('mergeItems 优先保留标题带日期的公告', () => {
  const undated = {
    date: '2024-04-16',
    title: '国内成品油价格按机制调整',
    url: 'https://example.com/a.html',
    status: 'adjusted',
    direction: 'unknown',
  };
  const dated = { ...undated, title: '2024年4月16日国内成品油价格按机制调整' };
  const found = new Map();
  mergeItems(found, [undated]);
  mergeItems(found, [dated]);
  assert.equal(found.get('2024-04-16').title, dated.title);
});

test('decodeEntities 解码常见实体', () => {
  assert.equal(decodeEntities('A&amp;B&#44;&ldquo;中&rdquo;'), 'A&B,“中”');
});

test('addWorkingDays 跳过假期、计入调休上班日', () => {
  const from1 = addWorkingDays(parseDay('2026-09-24'), 10, HOLIDAYS_2026, COVERED_2026);
  assert.equal(formatDay(from1), '2026-10-15');
  const from2 = addWorkingDays(parseDay('2026-10-15'), 10, HOLIDAYS_2026, COVERED_2026);
  assert.equal(formatDay(from2), '2026-10-29');
});

test('addWorkingDays 缺少节假日数据时报错', () => {
  assert.throws(
    () => addWorkingDays(parseDay('2026-12-25'), 10, HOLIDAYS_2026, COVERED_2026),
    MissingHolidayError,
  );
});

const WINDOW = {
  date: '2026-11-12',
  title: '2026年11月12日国内成品油价格调整',
  url: 'https://www.ndrc.gov.cn/xwdt/xwfb/202611/t20261112_1408795.html',
  status: 'adjusted',
  direction: 'down',
};

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
});

test('buildIcs 每行不超过 75 字节且折行可还原', () => {
  const ics = buildIcs([WINDOW], [parseDay('2026-11-26')], '20261123T043000Z');
  const unfolded = ics.replace(/\r\n /g, '');
  assert.ok(!unfolded.includes('\n '));
  for (const line of ics.split('\r\n')) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, line);
  }
  assert.equal(
    unfolded.split('\r\n').find((line) => line.startsWith('DESCRIPTION:')),
    'DESCRIPTION:' +
      '国家发展改革委公告：2026年11月12日国内成品油价格调整\\n公告日期：2026-11-12\\n' +
      '新价格自公布当日 24:00 起执行。\\n原文：https://www.ndrc.gov.cn/xwdt/xwfb/202611/t20261112_1408795.html',
  );
});

test('buildIcs 转义特殊字符', () => {
  const ics = buildIcs([{ ...WINDOW, title: '汽,柴油价格;下调' }], [], '20261123T043000Z');
  assert.ok(ics.includes('汽\\,柴油价格\\;下调'));
  assert.ok(!ics.replace(/\r\n/g, '').includes('\n'));
});
