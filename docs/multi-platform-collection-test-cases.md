# 采集侧测试用例（dev/multi-platform 专属）

> 配套方案：`./multi-platform-collection.md`（下称「采集方案」）。编号 CW-xx，与 MP-xx 用例互不冲突。
> 通用规则同 `multi-platform-test-cases.md`：云端操作一律选 `dev/multi-platform` 分支；dev 推送自动带 `[测试] ` 前缀（下文省略）；「打满」类用例测完跑对应平台的 `clear_flags`。
> CW-01/02 已于 2026-09-06 由人工执行通过（真实参数校准），记录下来作为回归基准。

---

## CW-01 · Codex 周重置校准（manual，已通过 ✅）

- workflow：**manual**，action=`set_weekly_next`，platform=`codex`，value=`2026-09-07T12:25:22+08:00`（本机会话日志实测值，采集方案 §4）
- 预期：无推送；`platforms.codex.weekly_next = 2026-09-07T04:25:22.000Z`（UTC 存储 = 北京时间 12:25:22）
- 实测：run 34025639611 ✅，state 落值正确

## CW-02 · WorkBuddy 月锚点（manual，已通过 ✅）

- workflow：**manual**，action=`set_monthly_anchor`，platform=`workbuddy`，value=`2026-10-01T00:00:00+08:00`
- 预期：无推送；`monthly_anchor` 与 `monthly_next` 均为 `2026-09-30T16:00:00.000Z`（UTC 存储 = 北京时间 10-01 00:00:00）
- 实测：run 34025662592 ✅，state 落值正确

---

## CW-03 · watcher 首次上报活动 → 云端开窗（真实驱动 MP-03）

> 前置：codex-watcher 已实现并按采集方案 §2 注册计划任务；`platforms.codex.five_h_anchor = null`（若非 null 先等窗口结束或用 `set_anchor` 拨到过去再等活动）。

- 操作：本机正常启动一次 Codex 会话（随便发一条消息），等 watcher 下一轮轮询（≤5 分钟）
- 预期：
  - watcher 日志：`new snapshot @<时间> -> session-activity sent`
  - 仓库 Actions 出现一条 **signal**（`session-activity`）运行；云端 `five_h_anchor = 活动时间 + 5h`，`last_activity_at` 更新
  - **无推送**（开窗不推）

## CW-04 · watcher 窗口内持续活动 → anchor 不动（真实驱动 MP-04）

- 前置：紧接 CW-03，5h 窗口进行中
- 操作：继续在 Codex 里对话几轮，等 watcher 轮询两轮以上
- 预期：watcher 每轮都发 `session-activity`（或按去重策略只在有新快照时发）；云端日志持续 `window in progress, anchor kept`；`five_h_anchor` **始终不变**

## CW-05 · watcher 无新活动 → 不发信号

- 操作：不碰 Codex，观察 watcher 两轮以上
- 预期：watcher 日志 `no new snapshot, skip`；Actions 无新 signal 运行；云端 state 无变化

## CW-06 · watcher 周重置自动校准（quota-sync）

> 验证采集方案 §2：watcher 每轮上报 `secondary.resets_at`，云端 `applySyncCodex` 校准 `weekly_next`。

- 操作（模拟）：手工把 dev 的 `weekly_next` 拨歪（manual `set_weekly_next` codex 填一个明显错误的时间），等 watcher 下一轮
- 预期：signal（quota-sync）运行后 `weekly_next` 被纠正回会话日志里的真实 `resets_at`；日志 `sync(codex): weekly_next -> ...`
- 测完：无需清理（值已被 watcher 校准回真实值）

## CW-07 · watcher 打满上报（⚠️ + 精确 reset_at）

> 等真实打满太难，用 watcher 的调试模式/手工构造：让 watcher 读到一条 `used_percent >= 100`（或 `rate_limit_reached_type` 非 null）的快照。

- 预期：
  - watcher 发 `quota-exhausted {"platform":"codex","tier":"5h","reset_at":"<primary.resets_at>"}`
  - 收到 **⚠️ Codex 5 小时额度已用完**，正文重置时间 = `resets_at`（**精确值**，非滑动推算）
  - 云端日志 `codex: reset_at reported by hook, anchor overridden`（V1 路径生效）
- 测完 `clear_flags`（platform=codex）清理

## CW-08 · watcher 打满去重（本地 + 云端双保险）

- 紧接 CW-07：不清本地状态，让 watcher 再轮询两轮（快照仍是打满状态）
- 预期：watcher 本地去重日志 `already reported, skip`；即使重复发了，云端也 `no duplicate push`——**全程只有一条 ⚠️**

## CW-09 · watcher 停摆降级（云端自治）

- 操作：停用 watcher 计划任务；用 manual `set_anchor`（codex）把窗口拨到刚过去的时间；跑 **tick**
- 预期：✅/ℹ️「Codex 5 小时窗口已可用」**照常推送**（采集方案 §2 降级语义：watcher 挂了不丢重置提醒，只是不再开新窗）
- 恢复 watcher 后，下次 Codex 活动自动重新开窗
- 测完 `clear_flags`（platform=codex）清理

## CW-10 · WorkBuddy 月重置真实链路（模拟到点）

- 操作：manual `set_monthly_next`（platform=workbuddy）拨到过去时间 → 跑 **tick**
- 预期：收到 **✅ WorkBuddy 月额度已重置**；`monthly_next` 递推到 `2026-10-01T00:00:00+08:00`（锚点推算的下一个未来时刻）；再跑 tick `no boundary crossed, no-op`
- 收尾：确认 `monthly_next` 回到真实值（= CW-02 的校准结果），无需其他清理

## CW-11 · watcher 首次运行 / 状态文件缺失（健壮性）

- 操作：删除 watcher 本地状态文件后启动
- 预期：不报错；把当前最新快照当基线记录，**不补发历史信号**（避免首次运行刷一堆过期 `session-activity`）

## CW-12 · watcher 配置与凭据（安全）

- 检查：watcher 只读本机 `quota-reminder.config.json`（PAT 不进仓库、不打印日志）；日志里不出现 PAT、不出现 `auth.json` 内容；只读 `~/.codex/sessions/`，不写 Codex 目录任何文件

---

## 全部测完后的检查清单（采集侧）

- [x] Codex 周重置校准落值正确（CW-01，已通过）
- [x] WorkBuddy 锚点与 monthly_next 落值正确（CW-02，已通过）
- [x] watcher 真实驱动开窗 / 窗口内不动 / 无活动静默（CW-03/04/05）
- [x] 周重置自动校准纠偏（CW-06）
- [x] 打满上报带精确 reset_at，V1 覆盖路径生效（CW-07），双端去重（CW-08）
- [x] watcher 停摆时 tick 照常推重置（CW-09）
- [x] WorkBuddy 月重置模拟到点推送 + 递推回真实值（CW-10）
- [x] 首次运行不补发历史信号（CW-11）；凭据与文件访问安全（CW-12）
- [x] main 分支代码、state、tag `v1.0-single-platform` 全程零改动

---

## CW-03 ~ CW-12 实测记录（2026-09-06，全部通过 ✅）

watcher 实现：`hooks/codex-watcher.mjs`（本分支）；本机安装于 `~/.kimi-code/hooks/codex-watcher.mjs`，
状态文件 `~/.kimi-code/hooks/codex-watcher.state.json`，日志 `~/.kimi-code/hooks/logs/codex-watcher.log`。
计划任务 `KimiQuotaCodexWatcher` 每 5 分钟一轮（注册方式见文末「附：计划任务注册」）。

### 实现相对采集方案 §2 的三处偏差（均已验证为必要）

1. **信号传输：测试期走 workflow_dispatch**。`repository_dispatch` 只会在默认分支 main 上运行——main 的
   signal.yml 不支持 `session-activity`（会被直接丢弃），且 `quota-sync`/`quota-exhausted` 会运行 main 版脚本、
   污染 main 的 state.json。因此 watcher 带 `--ref=dev/multi-platform` 时改用
   `POST /actions/workflows/signal.yml/dispatches`（inputs 带 event_type + payload），推送自然带 `[测试]` 前缀；
   缺省（不带 --ref）仍是方案规定的 repository_dispatch 生产形态，合并 main 后去掉 --ref 即可切换。
2. **quota-sync 纠偏式上报**。§2 写「每次轮询上报」，与 CW-05「无新活动 → Actions 无新 signal 运行」冲突。
   实现为：每轮读云端 `weekly_next` 与会话日志 `secondary.resets_at` 比对，偏离 >5s 才发 quota-sync 纠偏，
   已对齐则静默（CW-05、CW-06 同时满足）。
3. **每轮最多发一个信号**（优先级 quota-exhausted > session-activity > quota-sync，其余下一轮补发）。
   CW-07 首测发现：同轮连发 session-activity + quota-exhausted 时云端两个 run 并行 checkout 同一份 state
   （concurrency 组未拦住同秒触发），commit 阶段相邻字段冲突被 `git pull --rebase -X ours` 整段覆盖，
   打满标志与 anchor 覆盖被静默丢弃（⚠️ 推送本身已发出）。watcher 侧限流后复测通过；
   云端侧根治（commit 前 rebase 后重放信号，或串行化）留待合并 main 时评审。

### 分用例证据

- **CW-03 ✅**：`codex exec` 真实对话产生新快照（2026-09-06T10:07:54.110Z）；watcher 日志
  `new snapshot @2026-09-06T10:07:54.110Z -> session-activity sent`；run 34026564056（dev，PUSH_TEST=1）
  日志 `codex: new 5h window opened`；state `five_h_anchor = 2026-09-06T15:07:54.110Z`（= activity_at + 5h）、
  `last_activity_at` 同步更新；无推送。
- **CW-04 ✅**：窗口内再对话两轮（10:09:40 / 10:10:17Z），run 34026645497、34026674961 均
  `codex: window in progress, anchor kept`；`five_h_anchor` 始终为 15:07:54.110Z 不变。
- **CW-05 ✅**：不碰 Codex，计划任务两个自然轮（10:11:25 / 10:16:25）日志均 `no new snapshot, skip`；
  signal workflow 运行总数保持 121 不变；云端 state 无变化。
- **CW-06 ✅**：manual 把 weekly_next 拨歪为 2026-09-09T16:00Z → watcher 下一轮（10:19:25）检测到偏离，
  发 quota-sync → run 34027098322 日志 `sync(codex): weekly_next -> 2026-09-07T04:25:22.000Z`（附 raw 用量落日志）；
  state 纠回真实 `resets_at`。无需清理。
- **CW-07 ✅**：`--snapshot-json` 调试模式构造 `used_percent=100` + `rate_limit_reached_type="primary"` 快照
  （全程只读 .codex，不往 Codex 目录写任何文件）。run 34027427127：
  `codex: reset_at reported by hook, anchor overridden -> 2026-09-06T14:26:27.000Z`；
  推送 `[测试] ⚠️ Codex 5 小时额度已用完`，正文 `预计 2026/9/6 22:26:27 重置。`（= resets_at 精确值，V1 覆盖路径生效）；
  state `five_h_exhausted=true`、`five_h_anchor=2026-09-06T14:26:27.000Z` 保留。测完 `clear_flags`（platform=codex）。
  （注：修复前首测 run 34027168107 推送同样发出，但状态被上述并发问题覆盖丢失；该次 ⚠️ 属修复前行为。）
- **CW-08 ✅**：同一打满快照再轮询两轮，日志均 `5h exhausted already reported, skip`，无新 dispatch；
  手工清本地去重键强制重发同一打满 → run 34027499960 日志 `exhausted: 5h flag already set, no duplicate push`，
  全程只有 CW-07 那一条 ⚠️。
- **CW-09 ✅**：停用计划任务；manual `set_anchor`（codex）拨到已过时刻（2026-09-06T10:25+08）→ tick 推
  `[测试] ℹ️ Codex 5 小时窗口已可用`（「上周期未打满；下次会话将开启新的 5 小时窗口。」），anchor 置 null 不递推——
  watcher 停摆不丢重置提醒。恢复任务后下次 Codex 活动自动开窗（CW-03 链路已验证开窗能力）。
- **CW-10 ✅**：manual `set_monthly_next`（workbuddy）拨到过去 → tick 推 `[测试] ✅ WorkBuddy 月额度已重置`
  （「月额度已在 2026/9/6 10:00:00 刷新，下次重置 2026/10/1 00:00:00。」），`monthly_next` 递推回
  2026-09-30T16:00:00.000Z（= CW-02 校准值，北京时间 2026-10-01 00:00:00）；再跑 tick `no boundary crossed, no-op`。
- **CW-11 ✅**：watcher 首次运行（状态文件不存在，等同删除后启动）：日志
  `baseline recorded @2026-09-06T06:02:32.299Z, no historical session-activity`，只记基线不发任何信号；
  signal workflow 运行总数保持 118 不变。
- **CW-12 ✅**：代码审查 + 行为核验——watcher 写操作仅 `~/.kimi-code/hooks/` 下的日志与状态文件；
  对 `~/.codex/sessions/` 只有 readdirSync / statSync / readFileSync（只读）；PAT 仅从
  `quota-reminder.config.json` 读取并用于请求头，不进仓库、全量日志 grep 无 PAT、无 `auth.json` 内容；
  测试期间 main 分支最新提交停留在 10:00:36Z 的例行 tick（测试信号全部落在 dev），tag 未动。

### 附：计划任务注册（每 5 分钟）

注册需管理员权限（任务计划根目录创建任务），本机经 gsudo 提权执行：

```powershell
# local/register-codex-watcher-task.ps1（工作区留存同款脚本）
$action = New-ScheduledTaskAction -Execute 'C:\Program Files\nodejs\node.exe' `
  -Argument '"C:\Users\Administrator\.kimi-code\hooks\codex-watcher.mjs" --ref=dev/multi-platform'
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 4)
Register-ScheduledTask -TaskName 'KimiQuotaCodexWatcher' -Action $action -Trigger $trigger -Settings $settings -Force
```

合并 main 后把 `--ref=dev/multi-platform` 去掉重新注册即可切到生产形态（repository_dispatch）。

---

## 自适应轮询 v2 用例（CW-13 ~ CW-20）

> 配套方案：`multi-platform-collection.md` §7。前置：v2 版 watcher 已部署；计划任务已重建为 wscript 无窗口 + 30 分钟（§7.5）。
> 构造快照统一用 `--snapshot-json` 调试模式（同 CW-07），全程只读 `.codex`。

## CW-13 · 基线降频 30 分钟生效

- 检查：计划任务 `KimiQuotaCodexWatcher` 触发间隔 = 30 分钟；动作 = `wscript.exe ... codex-watcher.hidden.vbs`
- 操作：不碰 Codex，观察两轮以上
- 预期：日志每 30 分钟一条 `no new snapshot, skip`，毫秒级退出；期间**无任何窗口弹出**；云端 state 无变化

## CW-14 · 每日全量扫描（跨天校准）

- 操作：把 state 里 `last_daily_scan` 改成昨天日期，手动跑一轮 watcher
- 预期：日志 `daily full scan`（全量解析最新快照并与云端对账，但**不补发 session-activity**）；`last_daily_scan` 更新为今天；当天后续轮日志 `daily scan already done, skip`

## CW-15 · 关闭 Codex 补扫

- 操作（模拟）：用调试开关注入进程探测结果「上一轮在 → 本轮不在」；或真实操作：开着 Codex 桌面端跑一轮 watcher，再退出 Codex 跑下一轮
- 预期：发现退出转换的当轮日志 `codex exited, running catch-up scan`，执行一次全量扫描；若有未上报快照则补发 `session-activity`；state `prev_codex_running=false`

## CW-16 · 临额升频进入

- 操作：构造快照 `primary.used_percent=85`（剩余 15%），并满足活跃条件（快照时间戳在 15 分钟内）；手动跑 watcher
- 预期：日志 `boost mode entered (5h 85%, active)`；进程**不退出**，驻留每 5 分钟一轮；基线 30 分钟任务下一轮触发时因单实例锁秒退（见 CW-18）

## CW-17 · 升频退出 + 安全上限

- 操作 a（条件消失）：CW-16 驻留中，构造新快照 `used_percent=60` → 预期日志 `boost mode exited`，进程退出，回到基线
- 操作 b（打满即退出升频）：构造 `used_percent=100` → 发 `quota-exhausted` 后退出驻留（打满后无需再高频）
- 操作 c（不活跃）：快照时间戳保持 >15 分钟无更新且进程不在 → 退出驻留
- 操作 d（安全上限）：用调试开关把驻留起点拨到 6 小时前 → 当轮日志 `boost dwell limit reached, exit` 强制退出

## CW-18 · 单实例锁

- 操作 a：驻留进行中手动再启一个 watcher → 第二个检测到锁（mtime < 10 分钟）日志 `lock held by live instance, exit` 立即退出，不发任何信号
- 操作 b：把锁文件 mtime 拨到 10 分钟前再启动 → 日志 `stale lock taken over`，正常接管执行

## CW-19 · 层级闸门：周打满跳过 5h

- 操作：构造快照 `secondary.used_percent=100`（周打满）+ `primary.used_percent=85`（本满足升频）
- 预期：发 `quota-exhausted(weekly)` 后——**不发**任何 5h 相关信号，**不进**升频模式；日志 `weekly exhausted, 5h signals suppressed`
- 再构造周重置后快照（`secondary.used_percent=0`）→ 一切恢复，5h 信号与升频判定照常
- 测完 `clear_flags`（platform=codex）清理

## CW-20 · 无窗口运行验证（人工）

- 操作：计划任务自然触发一轮，人在电脑前观察
- 预期：无任何控制台窗口闪现；日志正常新增一条记录

---

## v2 全部测完后的检查清单

- [x] 基线 30 分钟（CW-13）
- [ ] 无窗口人工观察（CW-20）——**待用户确认**
- [x] 每日全量只扫不发（CW-14）
- [x] 关闭补扫（CW-15）
- [x] 升频进入 / 退出三条件 / 安全上限（CW-16、CW-17）
- [x] 单实例锁防重叠 + 僵死接管（CW-18）
- [x] 周打满跳过 5h，恢复后正常（CW-19）
- [x] main 分支代码、state、tag `v1.0-single-platform` 全程零改动

---

## CW-13 ~ CW-19 实测记录（2026-09-06）

v2 watcher 实现：`hooks/codex-watcher.mjs`（本分支，仅此一个文件）；
本机安装于 `~/.kimi-code/hooks/codex-watcher.mjs`，状态文件 `~/.kimi-code/hooks/codex-watcher.state.json`，
锁文件 `~/.kimi-code/hooks/codex-watcher.lock`，日志 `~/.kimi-code/hooks/logs/codex-watcher.log`。

构造数据全部走 `--snapshot-json`（写在 `_cwtest/` 下），**全程只读 `~/.codex`，未向 Codex 目录写任何文件**；
除 CW-19 取 run id 的实跑外，其余均为 `--dry-run`（不发送、不写状态）。

### 实现说明（相对采集方案 §7 的补充）

1. **「全量扫描」的定义**：v1 每轮只解析 mtime 最近的 10 个会话文件。v2 的「全量」
   = 不设文件数上限、扫描全部 `rollout-*.jsonl`。方案 §7.1 未细化此点，按
   「基线轮限量、全量轮不限量」实现——这正是每日扫一次而非每轮扫的原因（文件可能上百个）。
2. **调试开关 4 个**（仅测试用，生产不带）：`--codex-running=true|false` 注入进程探测结果；
   `--boost-interval-sec` 调驻留间隔（默认 300）；`--boost-start-offset-min` 把驻留起点拨到过去（测安全上限）；
   `--max-boost-rounds` 限制驻留轮数（防测试进程挂住）。
3. **锁在 dry-run 下同样生效**：CW-18 需要验证锁，故锁的检查/获取/释放不受 `--dry-run` 影响；
   但 dry-run 依旧不写 state 文件（CW-11 语义不变）。
4. **活跃判定**：`now - 快照时间戳 ≤ 15 分钟` 或 `进程在`。`--snapshot-json` 模式下同样按时间戳计算，
   故构造「不活跃」只需把快照时间戳写到 20 分钟前（CW-17c）。

### 分用例证据

- **CW-13 ✅**：计划任务现状（`Get-ScheduledTask` 实读）：动作 `wscript.exe` + `codex-watcher.hidden.vbs`，
  重复间隔 `PT30M`，`ExecutionTimeLimit=PT72H`（≥ 6 小时驻留，不会被强杀）。
  行为侧：基线轮日志 `daily scan already done, skip` → `snapshot @2026-09-06T10:26:27.055Z primary=0% weekly=40%`
  → `no new snapshot, skip` → `weekly_next already aligned (2026-09-07T04:25:22.000Z), skip quota-sync`；
  端到端 1002 ms（含 node 启动与一次云端 state 读取），**零信号、无 run**。
- **CW-14 ✅**：state 的 `last_daily_scan` 拨为 `2026-09-05` 后实跑（非 dry-run，验证落盘）：
  日志 `daily full scan` + `daily full scan: new snapshot present, session-activity suppressed`；
  run 后 state 为 `last_daily_scan=2026-09-06`，而 `last_activity_at` 仍停在 `2026-09-06T10:26:27.055Z` ——
  **证明了「只扫不补发」**；全程无任何 dispatch。同日再跑一轮 → `daily scan already done, skip`，
  且同一份新快照的 `session-activity` 照常出现（对照：抑制只作用于每日全量那一轮）。
- **CW-15 ✅**：注入 `prev_codex_running=true` 后
  a) 配 `--codex-running=false` + 新快照 → `codex exited, running catch-up scan`，补发 `session-activity`（dry-run）；
  b) 换成无新活动的快照实跑 → 补扫照常、零信号，state `prev_codex_running=false` 落盘；
  c) 再跑一轮（prev 已为 false，本轮仍不在）→ **无补扫日志**，确认无误报。
- **CW-16 ✅**：`primary.used_percent=85` + 快照新鲜 → `boost mode entered (5h 85%, active)` →
  `boost dwell: next round in 3s`（测试把间隔调成 3 秒）→ 第二轮 → `boost rounds cap reached (2), exit`；
  总驻留 4 秒，**证明进程未在首轮退出**（默认间隔 300 秒）。
- **CW-17 ✅**（四项 + 对照）：
  a) 85% → 60%：`boost mode exited`，进程退出；
  b) 85% → 100%：发 `quota-exhausted {"tier":"5h","reset_at":"2026-09-06T16:54:17.000Z"}` 后 `boost mode exited`；
  c) 换成 20 分钟前的快照 + `--codex-running=false`：`boost condition not met (5h 85%, inactive)` → `boost mode exited`；
  d) `--boost-start-offset-min=361`：`boost mode entered` 后立刻 `boost dwell limit reached, exit`；
  对照：不拨起点时正常驻留、**不误触发上限**。
- **CW-18 ✅**：
  a) 造一个 mtime 为当前的锁 → 日志只有一行 `lock held by live instance, exit (9999 2026-09-06T11:50:00.000Z)`，
  无任何信号输出，且**锁文件被保留**（未被误删）；
  b) 把 mtime 拨到 660 秒前 → `stale lock taken over (8888 2026-09-06T11:43:00.000Z, idle 660s)`，
  正常接管跑完一轮，退出后**锁已清理 ✅**。
- **CW-19 ✅**：`secondary.used_percent=100`（`rate_limit_reached_type="secondary"`）+ `primary=85%`
  → `weekly exhausted, 5h signals suppressed` + `quota-exhausted {"tier":"weekly","reset_at":"2026-09-07T04:25:22.000Z"}`，
  **无任何 5h 信号、未进升频**；`session-activity` 因「每轮一个信号」被顺延到下一轮（优先级正确）。
  实跑取 run id：**run 34031654318**（signal，success），云端日志
  `PUSH_TEST: 1` → `pushAll: [测试] ⚠️ Codex 周额度已用完` → `bark: ok (group=Kimi Code 额度 · Codex · 测试)` →
  `exhausted: weekly flag set`。恢复侧：`secondary=0%` 后 `session-activity` 照发、
  `boost mode entered (5h 85%, active)` 恢复正常。收尾 **run 34031686901**（manual `clear_flags` platform=codex，success），
  `weekly_exhausted=false`、`five_h_exhausted=false`。
- **CW-20**：无窗口运行属人工观察项 —— **待用户确认**（计划任务自然触发一轮时人是否在电脑前）。
  间接证据：vbs 启动器以窗口样式 0 启动；`tasklist` 探测加了 `windowsHide: true`，探测本身不会弹窗。

### 部署状态

- 计划任务 `KimiQuotaCodexWatcher` 当前已是 **wscript 无窗口 + 30 分钟**（`ExecutionTimeLimit=PT72H`）。
  若要用 `local/register-codex-watcher-task.ps1` 的 7 小时上限重新注册，或首次重建任务，需**管理员权限**：
  右键 → 以管理员身份运行工作区 `_fix_task.cmd`（schtasks 版，默认上限 72H），
  或管理员 PowerShell 跑 `local/register-codex-watcher-task.ps1`（7H 版）。本轮测试未改动计划任务。
- `main` 分支、`main` 的 state.json、tag `v1.0-single-platform`（`a45c094`）全程零改动；
  main 的 anchor 与周用量变化来自其自身的例行 tick，与本次测试无关。
