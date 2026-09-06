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
