# 部署与验证步骤

配套方案：`./kimi-quota-reminder-plan.md`（同目录）。本文档覆盖 §10 实施清单的全部操作。

## 一、用户准备（一次性）

1. **企业微信群机器人**：企业微信注册 → 建群 → 群设置 → 添加群机器人 → 复制 webhook URL（形如 `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...`）。想让普通微信（手机 + PC）也能收，配「微信插件」：管理后台 → 我的企业 → 微信插件 → 个人微信扫码关注（二维码 7 天有效），并取消勾选「成员使用微信插件时需要使用企业微信客户端」和「仅在企业微信中接收消息」两个开关（详见方案 §6.0）。注意：微信插件只支持 **text** 类型消息，本项目 push.mjs 发的就是 text，不要改回 markdown（微信端会显示「暂不支持此消息类型」）。
2. **Bark（iOS 推荐）**：App Store 装 Bark → 打开 App 复制首页的 key（推送 URL 里 `https://api.day.app/` 后面那串）。备选：**ntfy**——手机装 ntfy App，订阅一个自造复杂 topic（如 `kimi-quota-x7k2p9`，不要用人能猜到的词）；电脑浏览器打开 `https://ntfy.sh/<topic>` 订阅同一 topic。iOS 上 ntfy 走 APNS 容易不弹，Bark 更稳。
3. **WxPusher（微信服务号直推，推荐）**：`https://wxpusher.zjiecode.com/` 微信扫码登录。只推荐**标准应用**模式（极简 SPT 实测消息落在「服务通知」聚合入口、不进主聊天列表，已弃用，见方案 §6）：
   - 新建应用（名字/联系方式/说明随意填，回调留空，关闭用户分享）→ 应用页拿 `appToken`（`AT_xxx`）→ 「关注应用」微信扫码关注 → 公众号菜单「我的 → 我的UID」拿 `UID_xxx`。
   两个凭据都等同密码，不要泄露。关注后顺手做两件事：把该服务号**置顶**（微信灰度折叠服务号，置顶豁免）+ 关闭它的**消息免打扰**，消息就能进微信主聊天列表并弹横幅。
3. **Console 抄时间**：打开 kimi.com/code/console，记下 5h 下次重置时间和周额度下次重置时间（本机实测：周重置 `2026-09-12 14:00 UTC`，5h 下一边界见 console）。
4. **GitHub**：建一个**私有仓库**（如 `kimi-quota-reminder`）；生成 fine-grained PAT：只授权这一个仓库，权限 `Contents: Read and write` + `Actions: Read and write`。

## 二、云端部署

1. 把 `repo/` 目录的**内容**推到仓库根：
   ```bash
   cd repo
   git init && git add -A && git commit -m "init"
   git remote add origin git@github.com:<你>/<kimi-quota-reminder>.git
   git push -u origin main
   ```
2. **建测试分支 `dev/multi-platform`**（方案 §6.1 的前提）：从 main 切一条长期分支出来，测试全在这条上跑，它持有**独立的 `state.json`**，与 main 的线上状态互不影响。
   ```bash
   git checkout -b dev/multi-platform && git push -u origin dev/multi-platform
   ```
   GitHub 网页也行：Code 页左上角分支下拉 → 输入 `dev/multi-platform` → Create branch。
   注意：给 dev 分支更新代码请显式指定分支（见「六、维护备忘」的上传命令），否则 dev 跑的还是旧代码。
3. 仓库 Settings → Secrets and variables → Actions，添加：
   - `WECOM_WEBHOOK`：企业微信机器人 webhook URL
   - `BARK_KEY`：Bark App 首页的 key（iOS 推送走这条）
   - `WXPUSHER_APPTOKEN`（应用页的 `AT_xxx`）+ `WXPUSHER_UID`（公众号菜单「我的 → 我的UID」）：WxPusher 标准应用推送，微信服务号直推走这条
   - ⚠️ 若之前配过 `WXPUSHER_SPT`（极简推送，已弃用）：请**删除**该 secret——push.mjs 当前是 SPT 优先，留着它应用模式不会生效
   - `NTFY_TOPIC`：ntfy topic 名（不含 `https://ntfy.sh/` 前缀；用 Bark 的话可不配）
   - （可选）`BARK_SERVER`：自建 Bark 服务器时在 **Variables** 标签页加这个变量，默认 `https://api.day.app`
   - 没配哪个通道的 secret，脚本会自动跳过该路，互不影响
   - 测试隔离（方案 §6.1）**无需任何额外配置**：非 main 分支运行时 workflow 自动注入 `PUSH_TEST=1`，推送标题带 `[测试]` 前缀、Bark 进「Kimi Code 额度 · 测试」分组；signal/tick 在 main 分支手动触发会被拒绝
4. 初始化时刻表：仓库 Actions → **manual** → Run workflow（Branch 选 `main`）→
   - `set_anchor`，value 填 Console 抄的 5h 下次重置时间（ISO 8601，如 `2026-09-05T19:00:18+00:00`）
   - `set_weekly_next`，value 填周额度下次重置时间
5. 验证推送：manual → `test_push` → 企业微信群、Bark（iPhone）和 ntfy 各应收到一条测试消息。缺哪路看那次运行日志里对应行的报错。
   > 在 `main` 上跑，标题**不带** `[测试]` 前缀（真实推送）；想验证打标就切到 `dev/multi-platform` 再跑一次，标题会带 `[测试]` 前缀、Bark 进「Kimi Code 额度 · 测试」分组。
6. （可选）手动触发一次 **tick** 冒烟：**Branch 必须选 `dev/multi-platform`**——main 上手动跑 tick 会被防呆守卫直接判失败（这是设计如此，见测试用例 16）。预期日志输出 `no boundary crossed, no-op` 且提交了一个 heartbeat。
7. （可选但推荐）**外部 cron 叫醒**（方案 §6.2）：GitHub 的 `*/5` cron 实测退化为 2~4 小时一次，想要准点提醒就配一个外部定时服务（以 cron-job.org 为例）：
   - 新建 cronjob，间隔 5 分钟，方法 POST
   - URL：`https://api.github.com/repos/<owner>/<repo>/dispatches`
   - Headers：`Authorization: Bearer <本机 hook 同款 fine-grained PAT>`、`Accept: application/vnd.github+json`、`Content-Type: application/json`
   - Body：`{"event_type":"tick-wake"}`
   - 不配也不影响功能，只是提醒可能晚到几小时（原 cron 兜底）

## 三、本机部署

脚本已部署到 `~/.kimi-code/hooks/`（`quota-sync.mjs`、`quota-signal.mjs`、`quota-close.mjs`），且已实测：实例发现 → server.token 认证 → 用量接口 → GitHub dispatch 全链路畅通。

1. 配置 PAT（此文件只在本机，不进任何仓库）：编辑 `~/.kimi-code/hooks/quota-reminder.config.json`（已从 `local/quota-reminder.config.example.json` 复制好），填入 `github_owner` / `github_repo` / `github_pat`。
2. 把 `local/config-snippet.toml` 的内容追加到 `~/.kimi-code/config.toml`。Windows 下若 `~` 不展开，改用完整路径（片段里有注释示例）。
3. 干跑一次验证（不依赖 hook 触发）：
   ```bash
   node ~/.kimi-code/hooks/quota-sync.mjs
   cat ~/.kimi-code/hooks/logs/quota-sync.log   # 应看到 sync sent: {...}
   ```
   然后在仓库 Actions 里应看到一次 **signal** 运行，`state.json` 的 `five_h_anchor` / `weekly_next` 被自动校准、`last_sync` 更新。**这一步完成后，第二步 3 的手动填时间会被实测值覆盖校正，填得不准也没关系。**

## 四、验证点（方案 §8，边跑边验）

| # | 验证什么 | 怎么看 |
|---|---|---|
| 1 | StopFailure payload 能否区分三种错误 | 首次打满后看 `~/.kimi-code/hooks/logs/stopfailure-*.json`，必要时调整 `quota-signal.mjs` 的 `classifyTier` 正则 |
| 2 | 「固定时刻表」假设 | 每次 SessionStart 同步时云端自动比对 anchor 与上报 `reset_at`；signal workflow 日志里出现 `anchor corrected` 即发生了纠偏，前几周人工瞄两眼 |
| 3 | 月窗口是否出现在用量接口 | signal workflow 日志里的 `raw usage = ...`，或本机 `quota-sync.log`。出现月窗口后云端已自动接管（`monthly_exhausted_until` 自动设置），可停用手动信号 |
| 4 | Actions cron 延迟 | 高峰期可能晚 5~15 分钟，重置提醒对此不敏感，无需处理 |

## 五、月额度操作流程（方案 §7，已自动化）

1. 月额度打满 → StopFailure 自动发 `monthly` 信号 → 云端按 `monthly_anchor`（订阅日 2026-09-05 22:00:18 北京时间，月重置 = 每月 5 号同时刻）**自动算出** `monthly_exhausted_until`，所有提醒静默。
2. 到点自动推「✅ 月额度已重置」并清空全部标志。
3. 仅在订阅信息变更时（换套餐、改订阅日），手动执行：Actions → **manual** → `set_monthly_anchor`，value 填新的订阅日时刻（ISO 8601）。`monthly_cap` 保留为直接指定静默截止时间的兜底手段。

## 六、维护备忘

- fine-grained PAT 最长 1 年有效期，到期需重生成并更新 `~/.kimi-code/hooks/quota-reminder.config.json`（建议在日历设提醒）。
- tick workflow 每天写一个 heartbeat 提交，避免仓库 60 天无活动被停用定时任务。
- hook 只在 CLI 生效；VS Code 扩展 / 第三方客户端打满时不发信号，由下次 SessionStart 同步兜底补标志。

## 七、改完代码怎么上传

本机没有 git 时用 `tools/upload-repo.mjs`（Contents API 上传）：

```bash
node tools/upload-repo.mjs                              # → 默认分支 main
node tools/upload-repo.mjs --branch=dev/multi-platform  # → 测试分支
node tools/upload-repo.mjs --force-state                # 连云端运行时数据一起覆盖（危险）
```

两个保护机制，别绕过：

- **`state.json` / `heartbeat.txt` 默认不覆盖远端**。它们由 workflow 在云端自己写回，仓库里那份只是**初始化模板**（全 null）。直接覆盖会把 hook 同步上来的真实时刻表（anchor / weekly_next / 用量）清空，提醒立刻失效。只有首次初始化建库、或明确要重置时刻表时才加 `--force-state`。
- 上传前脚本会比对内容，无变化的文件跳过，避免产生无意义的提交。

两个分支要**各传一次**——只传 main 的话，dev 分支跑的还是旧代码，测试用例（打标、守卫）测不出来。

## 八、双分支同步 checklist（每次改完代码照着核对）

1. **代码与文档双推**：`.github/workflows/*.yml`、`scripts/*.mjs` 和 `docs/*.md` 的每次改动，main 和 `dev/multi-platform` 必须各提交一次（`upload-repo.mjs` 跑两遍，或 API 推两次）。文档跟着代码分支走：main 的文档描述线上行为，dev 的文档随新特性演进，保证「文档和代码的一致性由分支保证」。
2. **`state.json` 永远不合**：dev 和 main 各自持有独立状态（测试隔离，方案 §6.1）。把 dev 的 state 合到 main = 测试数据污染线上时刻表。Git 显示两分支 diverged（几十/几十）是正常的——那只是各自 heartbeat/测试提交的历史分叉，不代表代码不同。
3. **改完验证一致性**（30 秒）：对每个代码/文档文件分别取两个分支的 blob SHA 比对（Contents API `?ref=main` / `?ref=dev/multi-platform`），全部相同即同步完成；预期唯一不同的文件是 `state.json`。2026-09-06 实测核对过：3 个 workflow + 3 个脚本全部一致，仅 `state.json` 不同。
4. **稳定锚点**：main 上的单平台定稿版打了 tag `v1.0-single-platform`（2026-09-06），回退看这个 tag 即可，不用翻 commit 历史。
