# Kimi Code 额度重置提醒器 · 方案定稿

## 1. 背景与核心认知

Kimi Code 有三层额度（[官方文档](https://www.kimi.com/code/docs/kimi-code/membership.html)）：

| 层级 | 周期 | 重置方式 |
|---|---|---|
| 5 小时窗口 | 5h | **固定时刻表**，与使用行为无关（用户实测确认） |
| 周额度 | 7 天 | 以订阅日为起点固定刷新 |
| 月额度 | 按计费周期 |  billing cycle 开始日刷新 |

关键洞察：**额度只可能在 CLI 运行时被打满**，所以"打满信号"总能由本地 hook 发出；而计时和推送全部放云端，之后关掉 Kimi Code、关机都不影响提醒送达。

## 2. 总体架构

```
本机（Kimi Code CLI）                          云端（GitHub）
┌─────────────────────────────┐      ┌──────────────────────────────┐
│ Hook A: SessionStart        │      │ Workflow A (repository_      │
│   启动时查询用量/重置时间    │─────▶│   dispatch) 接收信号，        │
│   → 同步到云端               │      │   更新 state.json             │
│ Hook B: StopFailure         │      │ Workflow B (cron */5min)     │
│   额度 403 错误 → 发信号     │─────▶│   检查时刻表边界，            │
│ （信号走 repository_dispatch）│      │   到点 → 双通道推送           │
└─────────────────────────────┘      │ Workflow C (workflow_        │
                                     │   dispatch) 手动校准/月额度信号│
                                     └───────────┬──────────────────┘
                                                 ▼
                              企业微信群机器人 webhook（无梯子，手机+电脑）
                              ntfy.sh topic（有梯子，App+浏览器）
```

## 3. 云端状态（仓库内 state.json）

```json
{
  "five_h_anchor": "2026-09-06T01:30:00+08:00",
  "five_h_used": 0,
  "five_h_limit": 0,
  "weekly_next": "2026-09-11T14:00:00+08:00",
  "weekly_used": 0,
  "weekly_limit": 0,
  "five_h_exhausted": false,
  "weekly_exhausted": false,
  "monthly_exhausted_until": null,
  "monthly_anchor": "2026-09-05T14:00:18Z",
  "last_sync": "2026-09-05T10:00:00+08:00"
}
```

- `five_h_anchor`：任意一个 5h 窗口边界，之后按 +5h 无限递推
- `weekly_next`：下次周重置时间，推送后 +7d 递推
- `weekly_exhausted` / `monthly_exhausted_until`：高层级闸门，决定低层级提醒是否静默
- `five_h_exhausted`：只影响文案分级（打满过用 ✅，否则 ℹ️），不再作为发送条件

## 4. 分层提醒逻辑（核心规则）

**设计原则：纯层级闸门，不看用量百分比。**
提醒的意义是让用户在月计费周期内尽可能把额度用起来——哪怕上周期用量是 0%，重置提醒也照发。低层级重置是否有意义，只取决于更高层级是否可用：周打满了，5h 重置也用不了，不推；月打满了，5h 和周重置都没意义，全静默。

**5 小时层**：cron 每 5 分钟检查是否跨过 `anchor + 5h·k` 边界——
- 跨过边界 且 周/月未耗尽 → **一律推**「5小时额度已重置」（上周期打满过用 ✅，没打满用 ℹ️），清 `five_h_exhausted`
- 周或月耗尽期间 → 一律静默（5h 重置了也「不能用」，不推）
- 不再设用量阈值：用量 <80% 甚至 0% 都照常提醒

**周层**：到达 `weekly_next`——
- 月未耗尽 → **一律推**「周额度已重置」（打满过 ✅，否则 ℹ️）；月耗尽期间静默
- 无论是否推送：`weekly_next += 7d`，清 `five_h_exhausted` 和 `weekly_exhausted`（周重置后 5h 必然也是满的）

**月层**：
- 月额度耗尽（手动信号，见 §7）→ 置 `monthly_exhausted_until` → 期间所有提醒静默
- 到达该时间 → 推「✅ 月额度已重置」，清空全部标志

**效果**（对应需求）：
- 周/月都没光 → 每个 5h 边界都提醒，鼓励把额度用起来 ✅
- 周提前用光、月没光 → 5h 提醒自动静默（重置了也没用），只推周重置 ✅
- 月用光 → 全静默直到月重置 ✅

## 5. 本地信号：两个 hook

### Hook A · SessionStart（启动同步）

每次启动 Kimi Code 时执行脚本：

1. 扫 `~/.kimi-code/server/instances/` 找存活实例（pid + heartbeat 判断）
2. 用 `~/.kimi-code/server.token` 作为 bearer，调 `GET http://127.0.0.1:<port>/api/v1/oauth/usage`
3. 拿到两个窗口的 `{used, limit, reset_at}` → repository_dispatch 发云端
4. 云端据此：校准 anchor/weekly_next、更新 used/limit、若 `used>=limit` 则补置 exhausted 标志（**兜住 hook B 漏接的情况**）
5. 本地服务没在跑 → 静默跳过（fail-open），不影响 CLI 启动

副作用收益：每次启动都在验证「固定时刻表」假设——云端比对计算边界与上报的 `reset_at`，偏差超阈值自动纠正 anchor。

### Hook B · StopFailure（打满信号）

额度 403 报错触发：

1. 从 payload/错误文本识别错误类型：`5-hour` / `weekly` / `monthly`
2. repository_dispatch 发云端，只带类型标记（不需要带时间，云端有时刻表）
3. 脚本把原始 payload 落盘到 `~/.kimi-code/hooks/logs/`，供首次调试（验证 payload 能否区分三种错误）
4. 之后你关掉 Kimi Code 即可，云端接手计时

config.toml 配置形态：

```toml
[[hooks]]
event = "SessionStart"
command = "node ~/.kimi-code/hooks/quota-sync.mjs"
timeout = 15

[[hooks]]
event = "StopFailure"
command = "node ~/.kimi-code/hooks/quota-signal.mjs"
timeout = 10

[[hooks]]
event = "SessionEnd"
command = "node ~/.kimi-code/hooks/quota-close.mjs"
timeout = 10
```

### Hook C · SessionEnd（关闭快照）

关闭 CLI 时查一次用量发 `quota-close`，云端拼「额度快照」推送：三层剩余量 + 各自重置时间 + 「最早恢复可用」时间（层级 月 > 周 > 5h——月打满时显示月重置，因为周/5h 重置了也用不了）。三层全空时不推（没啥可说的）。

本机需存一个 GitHub fine-grained PAT（仅授单个仓库 Contents 读写 + Actions 触发），放在脚本同目录的本地文件里（不进任何仓库）。

## 6. 云端：三个 workflow

| Workflow | 触发 | 职责 |
|---|---|---|
| A · signal | repository_dispatch | 解析信号（sync / exhausted_5h / exhausted_weekly / exhausted_monthly），更新 state.json 并提交 |
| B · tick | cron `*/5 * * * *`（兜底）+ repository_dispatch `tick-wake`（准点，见 §6.2） | 按 §4 规则检查边界，到点调两个推送渠道，推进时刻表，提交 state.json |
| C · manual | workflow_dispatch | 手动校准 anchor/weekly_next；手动发月额度信号（月额度耗尽时在 GitHub 网页/App 点一下，填月重置时间） |

推送实现：各路独立 try/catch，一路失败不挡另一路——
- 企业微信群机器人：POST **text** 到 webhook URL（国内链路，配「微信插件」后普通微信也能收）。**必须用 `msgtype: text` 而不是 markdown**：微信插件（原企业号）官方明确不支持展示 markdown 消息，markdown 在微信端只会显示「暂不支持此消息类型，点击前往企业微信查看」（实测确认）；text 则企业微信群、手机微信、PC 微信三端均完整可读。排版损失（无加粗/彩色）用 emoji 和换行补偿，短通知完全够用
- ntfy.sh：POST 到自造复杂 topic（手机 App + 电脑浏览器订阅）
- Bark（iOS）：POST /push JSON；级别分级——额度用光 / 有效重置为 `active`（亮屏），SessionEnd 关闭快照为 `passive`（仅通知列表）且 `ttl=86400`（历史记录保留 1 天）
- WxPusher（微信服务号）：**标准应用推送**为唯一推荐模式——POST `/api/send/message` 带 `appToken + uids + summary + content`（contentType=1 文本）。应用消息以服务号会话进**微信主聊天列表**（与企业号插件的两层折叠不同），未免打扰时有横幅通知；微信 8.0.50+ 灰度折叠服务号，但**置顶的服务号不折叠**——关注后置顶 + 关免打扰即保住强提醒。凭据等同密码，只存 GitHub Secrets（`WXPUSHER_APPTOKEN` + `WXPUSHER_UID`）。
  - 2026-09-06 实测修正：**极简 SPT（GET `/api/send/message/<SPT>/<内容>`）弃用**——SPT 消息落在「服务通知」聚合入口，不进微信主聊天列表、无横幅提醒，达不到强提醒目标。SPT 另有一个坑：它是 GET 路径参数，文本里的半角 `/` 编码成 `%2F` 会被服务端 Tomcat 拒绝（HTTP 400），必须先把 `/` 换成全角 `／`（push.mjs 已内置该处理；应用模式走 POST body，无此问题）。
  - 落地待办（改代码前先做）：当前 push.mjs 是「SPT 优先于 appToken」——要么在 Secrets 里删掉 `WXPUSHER_SPT`（零代码改动即可切到应用模式），要么把 push.mjs 改为应用模式优先。✅ 已落地（2026-09-06）：应用已建，Secrets 已写入 `WXPUSHER_APPTOKEN` + `WXPUSHER_UID` 并删除 `WXPUSHER_SPT`（走零代码改动路线），dev 分支 test_push 日志四路全通（wecom/bark/wxpusher ok，ntfy 未配置跳过）。
  - 候选通道·微信 ClawBot（官方 iLink Bot API，**直连官方、不走 WxPusher 集成渠道**，2026-09-06 调研结论）：微信 2025 年起官方开放的个人 Bot API，接入域名 `ilinkai.weixin.qq.com`，HTTP/JSON 接口（`getupdates` 长轮询收消息 + `sendmessage` 发消息，回复必须原样带 inbound 消息的 `context_token`），有官方法律条款背书、无封号风险。实测短板（对本项目低频告警场景是硬伤）：① 对话框不进聊天列表和通讯录、置顶无效，只能搜索找到；② 24h 激活窗口——用户 24h 内未主动给 Bot 发消息，下发消息直接丢弃，且每次激活限 10 条。结论：**暂不接**；官方放开激活限制或会话可见性后再评估，届时作为 push.mjs 的独立通道直连接入。

### 6.0 微信插件（普通微信接收企业微信消息，2026-09-06 增补）

目标：PC 端不开企业微信客户端也能收到提醒。机制：注册企业微信后自动开通的「微信插件」（原企业号），成员用个人微信扫码关注后，企业微信的应用消息和会话消息会同步进微信（公众号形态，手机 + PC 微信都收）。群机器人发到内部群的消息属于会话消息，随群同步，**群无需变外部、机器人无需改动**。

配置四步（一次性）：
1. 管理后台（work.weixin.qq.com）→ 我的企业 → 微信插件 → 拿「邀请关注」二维码（7 天有效，过期重生成）
2. 同页面确认**未勾选**「成员使用微信插件时需要使用企业微信客户端」
3. 个人微信扫码关注 → 插件出现在「通讯录 → 公众号」
4. 插件设置里开「接收企业消息」；手机企业微信 → 设置 → 新消息通知 → **取消勾选**「仅在企业微信中接收消息」（90% 收不到消息是这个开关）

已知怪癖：PC 微信看过的消息手机端不再显示角标（官方行为）；全员群超 2000 人不同步（单人企业无影响）。

配合上面 WeCom 通道的 text 类型，微信端即可直接读到完整内容。

Secrets：`WECOM_WEBHOOK`、`WXPUSHER_APPTOKEN` + `WXPUSHER_UID`（SPT 已弃用，见 §6）、`NTFY_TOPIC`、`GH_PAT`（workflow 内提交 state 用，可选）。

### 6.1 测试隔离与防呆（2026-09-06 增补）

目标：经常测试，但测试数据绝不污染 main 的正常循环，测试推送也不与真实推送混淆。同一 Bark key、同一企业微信群即可，不需要第二套通道。

**天然边界**（GitHub 机制，零成本）：
- cron 定时（tick）和 repository_dispatch（本机 hook 信号）只在默认分支 main 上运行——测试无法通过这两个入口碰到线上状态
- 测试一律走 workflow_dispatch 手动选 `dev/multi-platform` 分支，dev 持有独立的 `state.json`，与 main 完全隔离

**防呆护栏**（堵住唯一残留的人为风险）：
- signal / tick 两个 workflow 的 job 加守卫：`workflow_dispatch` 触发且 `ref == main` 时直接报错退出。「忘选 dev 分支」从「悄悄污染线上 state」变成「显式失败提醒」
- manual workflow 例外：它本来就是用来校准 main 线上状态的（set_anchor / set_weekly_next / set_monthly_anchor / monthly_cap），不加守卫

**消息打标**（解决「同一通道分不清真假推送」）：
- 非 main 分支运行时，workflow 给脚本注入 `PUSH_TEST=1`
- `push.mjs` 读到该变量后：所有通道标题加 `[测试] ` 前缀；Bark 的 `group` 从「Kimi Code 额度」换成「Kimi Code 额度 · 测试」——Bark 分组是每条消息的参数而非按 key 划分，同一 key 下两组消息在 App 里分开展示
- 无需新增任何 secret / variable

**残余风险**：concurrency 组（quota-tick / quota-signal）为仓库级共享，dev 测试运行时 main 的 cron 最多排队几分钟，对重置提醒无影响，忽略。

### 6.2 外部 cron 叫醒（2026-09-06 增补，准点增强）

背景：GitHub 对高频 schedule 是尽力而为调度，**实测 `*/5` cron 在本仓库退化为 2~4 小时才跑一次**（2026-09-06 运行记录：22:05 / 23:53 / 03:45）。时刻表状态机本身不受影响（anchor 照样正确推进），但重置提醒会迟到几小时。

解法：tick.yml 增加 `repository_dispatch` 触发（类型 `tick-wake`），用外部免费 cron 服务每 5 分钟打一次 GitHub API 叫醒 tick；原 cron 保留为兜底（外部服务挂了也只是退回 2~4 小时慢速，不丢提醒）。

**外部服务配置**（以 cron-job.org 为例，任何能发自定义 header 的定时 HTTP 服务都行）：
1. 注册 cron-job.org → 新建 cronjob，间隔 5 分钟
2. URL：`https://api.github.com/repos/<owner>/<repo>/dispatches`，方法 POST
3. Headers：`Authorization: Bearer <fine-grained PAT>`、`Accept: application/vnd.github+json`、`Content-Type: application/json`
4. Body：`{"event_type":"tick-wake"}`
5. PAT 复用本机 hook 那个即可（repository_dispatch 已在用），或单独开一个仅 Actions 读写的

安全性：PAT 存放在第三方服务里，所以用**最小权限的 fine-grained PAT**（仅限这一个仓库）；泄露影响面 = 能往这个仓库发 dispatch/改文件，随时可在 GitHub 后台吊销。

触发链路已验证（2026-09-06）：本机 POST dispatches `tick-wake` → tick 在 main 上运行成功。repository_dispatch 只跑默认分支，天然落在 main（PUSH_TEST=0，真实推送）。

## 7. 月额度的处理（已升级为锚点自动递推）

- 月额度错误触发 StopFailure，信号自动发；云端按 `monthly_anchor`（订阅时刻，当前为 2026-09-05T14:00:18Z，即每月 5 号 22:00 北京时间重置）自动算出 `monthly_exhausted_until`，无需手动填
- 依据：月额度按计费周期刷新，订阅页实测「2026-10-05 后重置」，与 weekly_next − 7d 推得的订阅日完全吻合；用量接口（本地与云端 `/usages`）均不暴露月窗口，网页订阅页接口需浏览器登录态，CLI OAuth token 不可用（实测 401）
- 订阅信息变更时用 workflow C 的 `set_monthly_anchor` 校正；`monthly_cap` 保留为兜底

## 8. 验证点（边跑边验）

1. **StopFailure payload 内容**：首次打满后看 `~/.kimi-code/hooks/logs/` 落盘的原始数据，确认识别逻辑
2. **固定时刻表假设**：SessionStart 同步持续比对，前几周人工瞄两眼 Console 对照
3. **月额度是否出现在用量接口的 limits 列表里**：首次同步时看原始返回
4. ~~Actions cron 高峰期可能延迟 5~15 分钟~~ **实测推翻（2026-09-06）**：高频 cron 退化为 2~4 小时一次。已由 §6.2 外部 cron 叫醒解决，原 cron 降为兜底

## 9. 已知边界

- hook 只在 CLI 生效；VS Code 扩展/第三方客户端（Claude Code 接入）打满时不发信号 → 由下次 SessionStart 同步兜底补标志
- fine-grained PAT 最长 1 年有效期，到期需换一次（日历提醒）
- 仓库 60 天无活动会停用定时 workflow：cron workflow 每次运行写 heartbeat 提交即可规避
- 外部 cron 服务（§6.2）是可选增强：挂掉后自动退回 GitHub 原生 cron 的 2~4 小时慢速档，不丢提醒；PAT 泄露影响面仅限这一个仓库，可随时吊销
- 月额度完全耗尽时账户冻结，所有权益不可用——推送照常，因为推送不依赖 Kimi

## 10. 实施清单

用户准备：
1. 企业微信：注册 → 建群 → 添加群机器人 → 复制 webhook URL
2. ntfy：手机装 App，订阅自造复杂 topic；电脑浏览器订阅同 topic
3. Console（kimi.com/code/console）抄一次：5h 下次重置时间、周额度下次重置时间
4. GitHub：建私有仓库；生成 fine-grained PAT（本机 hook 用）

交付物：
- 仓库：`state.json` 初始化、三个 workflow、推送脚本
- 本机：两个 hook 脚本 + config.toml 片段 + PAT 配置说明
- 部署与验证步骤文档

## 11. 修订记录

### 2026-09-06（提醒逻辑定型 + 通道矩阵定稿 + 调度可靠性）

**提醒逻辑**
- 废弃「用量 ≥80%」阈值，改为**纯层级闸门**（§4）：提醒只看月 > 周 > 5h 的层级耗尽状态——周打满则 5h 重置不提醒，月打满则全静默；不因近期消耗 0% 而漏提醒，重置提醒的意义是让用户在月范围内把额度用满。

**推送通道（四路矩阵定稿）**
- 企业微信群机器人：markdown → **text**（§6）。微信插件官方不支持展示 markdown（实测显示「暂不支持此消息类型」），text 三端（企微群/手机微信/PC 微信）均完整可读。
- 微信插件（§6.0 新增）：普通微信经「微信插件」公众号接收企微消息，PC 不开企微客户端也能收。
- WxPusher 第四路（§6）：初版用极简 SPT，当日两次实测修正后定为**标准应用推送（appToken + UID）**——
  1. SPT 是 GET 路径参数，文本含 `/` 编码成 `%2F` 被服务端 Tomcat 拒绝（HTTP 400），修复为全角 `／`（push.mjs 内置）；
  2. SPT 消息落在「服务通知」聚合入口、不进主聊天列表，弃用；Secrets 切换为 `WXPUSHER_APPTOKEN` + `WXPUSHER_UID`（`WXPUSHER_SPT` 已删除），dev 四路全通。
- 微信主聊天列表调研结论（§6）：主列表只留给好友/群聊/文件传输助手，所有公众号类通道必然折叠；微信 ClawBot（官方 iLink API）记录为**候选通道、直连官方、暂不接**（会话不进列表 + 24h/10 条激活限制，低频告警会丢消息）；个人号协议机器人是唯一真解但成本/封号风险不匹配本场景。

**调度可靠性**
- §6.2 新增：GitHub 高频 cron 实测退化为 2~4 小时一次，加 cron-job.org 外部定时器打 `repository_dispatch: tick-wake` 准点叫醒，原生 cron 降为兜底；14:10/14:15 连续两次实测成功。

**测试体系**
- §6.1 测试隔离与防呆：dev/multi-platform 分支持独立 `state.json`，`PUSH_TEST=1` 打标 `[测试]` 前缀；signal/tick 在 main 禁止手动触发。
- setup.md 新增「八、双分支同步 checklist」：代码双推、`state.json` 永远不合、blob SHA 逐文件比对验证（当日本底：3 workflow + 3 脚本双分支一致，仅 state 不同）。

**上线里程碑**
- 13:58 发出第一条真实生产推送「ℹ️ Kimi Code 5小时额度已重置」（main 分支定时循环，三端送达）。
