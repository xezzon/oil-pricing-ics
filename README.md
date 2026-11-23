# 国内成品油调价日历（.ics）

把国家发展改革委公布的成品油调价窗口做成一份可订阅的日历，每周自动更新一次。

## 订阅

| 方式 | 地址 | 说明 |
| --- | --- | --- |
| jsDelivr（推荐） | `https://cdn.jsdelivr.net/gh/xezzon/oil-pricing-ics@main/oil-pricing.ics` | 正确返回 `text/calendar`，Google 日历、Apple 日历均可直接订阅 |
| GitHub Pages | `https://xezzon.github.io/oil-pricing-ics/oil-pricing.ics` | 需在仓库 Settings → Pages 中选择 `main` 分支根目录启用一次 |
| 仓库原始文件 | `https://raw.githubusercontent.com/xezzon/oil-pricing-ics/main/oil-pricing.ics` | 返回 `text/plain`，部分客户端（如 Google 日历）会拒绝 |

订阅时把地址填进「日历 → 通过网址添加」。自动刷新周期取决于客户端，日历本身声明了 `REFRESH-INTERVAL:P1W`
和 `X-PUBLISHED-TTL:PT6H`。

> 提醒：国内访问 GitHub 相关域名可能不稳定，订阅失败时优先换一个地址试试。

## 日历里有什么

- **已公布**（`STATUS:CONFIRMED`）：调价公告发布当天为全天事件，摘要区分「油价上调 / 油价下调 / 油价调整 /
  油价不作调整」，描述里有公告原文链接和生效时间（公布当日 24:00）。
- **预测**（`STATUS:TENTATIVE`，摘要带「（预测）」）：按「每 10 个工作日一调」的机制推算出的未来窗口，
  最长推算 1 年。公告发布后，同一天的预测事件会被同 UID 的正式事件覆盖。

`data/adjustments.json` 保存了全部已公布的窗口（含公告标题与链接），可以直接给其他程序使用；
首次运行回补 12 页公告列表（约 3 年历史），之后每周增量抓取。

## 数据源

优先级：权威 > 稳定 > 免费 > 公开（无需申请密钥）。

| 用途 | 来源 | 权威性 | 稳定性 | 成本 |
| --- | --- | --- | --- | --- |
| 调价公告 | [国家发展改革委 · 新闻发布](https://www.ndrc.gov.cn/xwdt/xwfb/) | 一手权威：价格司发布的原始公告，包含「不作调整」的窗口 | 静态 HTML 栏目页，URL 规则为 `t{YYYYMMDD}_{id}.html`，自 2021 年起可用 | 免费、公开、无需登录 |
| 节假日安排 | [NateScarlet/holiday-cn](https://github.com/NateScarlet/holiday-cn) | 转录国务院办公厅每年发布的放假安排（`papers` 字段给出原文链接） | 每年一份 JSON，GitHub 原始地址 + jsDelivr 镜像双通道 | 免费、公开 |

为什么这样选：

- 调价窗口没有任何官方接口或订阅源，权威信息只在发改委的公告里，因此直接解析新闻发布栏目而不是第三方油价站。
  第三方站点的调价日历同样是二手转录，权威性和稳定性都不如原始公告。
- 公告标题与文章地址都带日期，二者交叉校验，能剔除「答记者问」「解读」等非公告文章；2024-04-16 这类标题
  漏写日期的公告会用文章地址补位。
- 未来窗口用规则推算而不是抓「预测类」站点：机制是《石油价格管理办法》规定的每 10 个工作日一调，
  用该规则复算 2021 年底以来的 122 个窗口、121 个相邻间隔全部命中（含「不作调整」的窗口和 2026 年的临时调控），
  只有国务院节假日安排会影响工作日计数，所以只额外依赖节假日数据。
- 节假日 JSON 缺失时不会瞎猜：推算在某年数据缺失处停止，只保留已公布的窗口。

## 自动化

`.github/workflows/update.yml`（`actions/checkout@v7`、`actions/setup-node@v7`、Node.js 24）：

- `cron: "0 1 * * 1"`：每周一北京时间 09:00 跑一次；也可在 Actions 页面手动 `Run workflow`。
- 先跑 `npm test`（Node 内置测试运行器），再抓取公告、生成 `oil-pricing.ics`，内容有变化才提交。
- 抓取失败时沿用 `data/adjustments.json` 里的缓存继续生成（日历不会变空）；如果完全没有缓存则任务失败，便于发现问题。
- 抓取采用「增量 + 早停」：正常情况下只请求 1 张列表页（约 2 秒），首次或数据缺失时最多回补 12 页。

想改成每天更新，把 cron 改成 `0 1 * * *` 即可（公告一般在窗口当天 17:00 前后发布，日更的时效更好）。

## 本地使用

```bash
node scripts/update.mjs                     # 抓取 + 生成
node scripts/update.mjs --pages 20          # 首次回补更多历史
node scripts/update.mjs --today 2027-01-01  # 指定基准日，便于验证推算
npm test                                    # 单测
```

只使用 Node.js 内置模块（需要 Node 20+，依赖全局 `fetch`），没有任何第三方依赖，也不需要 `npm install`。

## 目录

```
.github/workflows/update.yml   每周自动更新
scripts/update.mjs             抓取公告、推算窗口、生成 ics
tests/update.test.mjs          解析 / 工作日 / ics 单测（node:test）
package.json                   脚本入口，无依赖
data/adjustments.json          已公布窗口的缓存（同时是数据产物）
oil-pricing.ics                生成的日历
```

## 已知限制

- 调价窗口逢节假日顺延，而国务院的次年放假安排通常要到当年 11—12 月才公布；在那之前，落在次年的预测会变少甚至为空。
- 极端情况下国家会采取临时调控（如 2026 年 3 月、9 月），这类公告仍落在 10 个工作日的时间网格上，因此不影响推算；
  但若机制本身调整（如工作日数变化），需要同步修改 `scripts/update.mjs` 里的 `WORKING_DAYS_PER_CYCLE`。
- 预测只是推算，最终以国家发展改革委公告为准。

## 许可

代码遵循仓库内 [LICENSE](LICENSE)（Apache-2.0）；日历中的公告文字版权归国家发展改革委所有。
