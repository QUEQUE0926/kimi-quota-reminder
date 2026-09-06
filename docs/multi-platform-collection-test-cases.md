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

- [ ] Codex 周重置校准落值正确（CW-01，已通过）
- [ ] WorkBuddy 锚点与 monthly_next 落值正确（CW-02，已通过）
- [ ] watcher 真实驱动开窗 / 窗口内不动 / 无活动静默（CW-03/04/05）
- [ ] 周重置自动校准纠偏（CW-06）
- [ ] 打满上报带精确 reset_at，V1 覆盖路径生效（CW-07），双端去重（CW-08）
- [ ] watcher 停摆时 tick 照常推重置（CW-09）
- [ ] WorkBuddy 月重置模拟到点推送 + 递推回真实值（CW-10）
- [ ] 首次运行不补发历史信号（CW-11）；凭据与文件访问安全（CW-12）
- [ ] main 分支代码、state、tag `v1.0-single-platform` 全程零改动
