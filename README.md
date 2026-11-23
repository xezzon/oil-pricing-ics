# 国内成品油调价日历（.ics）

把国内成品油调价窗口做成一份可订阅的日历：已公布的调价带价格和幅度，未来的窗口提前一年就能看到。每周自动更新。

## 订阅

| 方式 | 地址 | 说明 |
| --- | --- | --- |
| jsDelivr（推荐） | `https://cdn.jsdelivr.net/gh/xezzon/oil-pricing-ics@gh/oil-pricing.ics` | 正确返回 `text/calendar`，Google 日历、Apple 日历均可直接订阅 |
| GitHub Pages | `https://xezzon.github.io/oil-pricing-ics/oil-pricing.ics` | 需在仓库 Settings → Pages 中选择 `gh` 分支根目录启用一次 |
| 仓库原始文件 | `https://raw.githubusercontent.com/xezzon/oil-pricing-ics/gh/oil-pricing.ics` | 返回 `text/plain`，部分客户端（如 Google 日历）会拒绝 |

订阅时把地址填进「日历 → 通过网址添加」。自动刷新周期取决于客户端，日历本身声明了 `REFRESH-INTERVAL:P1W`
和 `X-PUBLISHED-TTL:PT6H`。

> 提醒：国内访问 GitHub 相关域名可能不稳定，订阅失败时优先换一个地址试试。

## 日历里有什么

- **已公布**（`STATUS:CONFIRMED`）：调价窗口日当天的全天事件，摘要区分「油价上调 / 油价下调 / 油价调整」，
  描述里有汽油、柴油价格、较上期的涨跌幅度，以及执行时间（窗口日 24:00，即次日 0 时起执行新价格）。
- **预测**（`STATUS:TENTATIVE`，摘要带「（预测）」）：按「每 10 个工作日一调」的机制推算出的未来窗口，
  提前一年列出，公告发布后同一天的预测会被同 UID 的正式事件覆盖。

日历内保留最近两年的已公布窗口；`data/adjustments.json` 里是 2000 年以来的全部记录，可以直接给其他程序使用。

## 数据源

优先级：权威 > 稳定 > 免费 > 公开（无需申请密钥）。

| 用途 | 来源 | 特点 |
| --- | --- | --- |
| 调价记录 | [东方财富数据中心 · 汽柴油历史调价](https://data.eastmoney.com/cjsj/oil_default.html)<br>`datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_WEB_YJ_BD` | 结构化 JSON，直接给出执行日、汽柴油价格、涨跌幅度；无需解析网页，不会被页面改版打断；支持 `filter` 按日期增量拉取 |
| 节假日安排 | [NateScarlet/holiday-cn](https://github.com/NateScarlet/holiday-cn) | 国务院办公厅放假安排的机器可读版本（`papers` 字段带原文链接），每年一份 JSON；拉取后缓存在 `data/holidays/` |

选型说明：

- **不解析网页**：上一版直接抓国家发展改革委的新闻发布栏目，靠正则解析列表页。页面结构一变、标题写法一变就会漏数据，
  而且 2024-04-16 这类标题漏写日期的公告要靠文章 URL 兜底。东方财富的数据中心接口是 JSON，字段固定，抓取逻辑只有几十行。
- **时效更好**：发改委只在窗口当天傍晚发公告，页面一改版或抓取失败就整周没有新数据；数据中心的调价记录在调价落地后即更新，
  并且自带幅度，日历可以直接显示“下调 645 元/吨”而不是只有日期。
- **未来窗口**：没有任何官方或商业接口会发布未来的调价日历（数据中心的“预计下次调价窗口”也是前端按同一规则算的），
  所以未来窗口用机制推算：每 10 个工作日一个窗口，只有国务院节假日安排会影响工作日计数。
  用该规则复算 2021 年底以来的 122 个窗口、121 个相邻间隔全部命中（含“不作调整”的窗口和 2026 年的临时调控）。
- **增量拉取**：接口支持 `filter=(DIM_DATE>'2026-11-13')`。脚本用本地缓存里最新的执行日做起点，
  只请求比它更新的记录，已经写进 `data/adjustments.json` / `oil-pricing.ics` 的数据不会重复拉取；
  本地已是最新时接口返回空，一次请求即可结束。需要重建时用 `--full`。
- 节假日 JSON 拉取后落盘缓存（往年不再联网），刷新失败时退回缓存，预测不会因为网络抖动而凭空消失。

## 自动化

`.github/workflows/update.yml`（`actions/checkout@v7`、`actions/setup-node@v7`、Node.js 24）：

- `cron: "0 1 * * 1"`：每周一北京时间 09:00 跑一次；也可在 Actions 页面手动 `Run workflow`。
- 先跑 `npm test`（Node 内置测试运行器），再增量抓取并生成 `oil-pricing.ics`，内容有变化才提交。
- 抓取失败时沿用 `data/adjustments.json` 的缓存继续生成（日历不会变空）；完全没有缓存时任务失败，便于发现问题。
- 一次正常运行的网络开销：1 个接口请求 + 当年/次年两个节假日 JSON；实测不到 1 秒。

想让已公布数据更快出现，把 cron 改成 `0 1 * * *`（每天）即可，增量模式下开销几乎不变。

## 本地使用

```bash
node scripts/update.mjs              # 增量抓取 + 生成
node scripts/update.mjs --full       # 忽略缓存，重新拉全部历史
node scripts/update.mjs --today 2027-01-01   # 指定基准日，便于验证推算
npm test                             # 单测
```

只使用 Node.js 内置模块（需要 Node 20+，依赖全局 `fetch`），没有任何第三方依赖，也不需要 `npm install`。

## 目录

```
.github/workflows/update.yml   每周自动更新
scripts/update.mjs             增量抓取、推算窗口、生成 ics
tests/update.test.mjs          接口解析 / 增量 / 工作日 / ics 单测（node:test）
package.json                   脚本入口，无依赖
data/adjustments.json          2000 年以来的调价记录（缓存兼数据产物）
data/holidays/YYYY.json        节假日安排缓存
oil-pricing.ics                生成的日历
```

## 已知限制

- 数据中心只记录**真正调了价**的窗口，「不作调整」的窗口没有记录。这类窗口在被推算出来后如果始终没有正式记录，
  过期后就会从日历里消失（不会显示成已调整）。
- 数据中心是二手数据，最终以国家发展改革委公告为准（`data/adjustments.json` 只存事实字段，不做解读）。
- 调价窗口逢节假日顺延，而国务院的次年放假安排通常要到当年 11—12 月才公布；在那之前，落在次年的预测会变少甚至为空。
- 极端情况下国家会采取临时调控（如 2026 年 3 月、9 月），这类调价仍落在 10 个工作日的时间网格上，不影响推算；
  若机制本身调整（如工作日数变化），需要同步修改 `scripts/update.mjs` 里的 `WORKING_DAYS_PER_CYCLE`。
- 预测只是推算，最终以公告为准。

## 许可

代码遵循仓库内 [LICENSE](LICENSE)（Apache-2.0）；调价数据与节假日安排版权归原始发布方所有。
