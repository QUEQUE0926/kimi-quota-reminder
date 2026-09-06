# 多平台采集侧与上线方案（dev/multi-platform 专属）

> 承接 `multi-platform-design.md` §8/§9 的待验证点。本文档是 2026-09-06 实地查证后的采集方案与上线参数，**只涉及方案，代码实现另行安排**。

## 1. 重大发现：Codex 会话日志自带额度快照（V3 解法）

实地查证本机 `C:\Users\Administrator\.codex\sessions\**\rollout-*.jsonl`：每条 `token_count` 事件都内嵌完整的 `rate_limits` 快照，无需 Codex CLI 提供 hook/notify 机制：

```json
"rate_limits": {
  "limit_id": "codex",
  "primary":   { "used_percent": 0.0,  "window_minutes": 300,   "resets_at": 1788692525 },
  "secondary": { "used_percent": 85.0, "window_minutes": 10080, "resets_at": 1788755122 },
  "plan_type": "plus",
  "rate_limit_reached_type": null
}
```

- `primary` = 5h 窗口（300 分钟），`resets_at` 随活动滑动——与 MP 方案 §4 的滑动锚点模型完全吻合
- `secondary` = 周窗口（10080 分钟 = 7 天）；**09-03 与 09-06 两个快照的 `resets_at` 完全相同** → 周额度是固定时刻表，+7d 递推成立（V4 初步验证通过，仍按计划观察 2 个周期）
- `rate_limit_reached_type`：打满时非 null，可作打满信号触发器
- `resets_at` 直接给出重置时刻 → **V1 解决**：打满信号可以携带精确 `reset_at`，云端已支持覆盖滑动锚点推算值

**结论：采集侧不需要 Codex CLI 的任何 hook 能力，读取本地会话日志即可拿到全部所需数据。**

## 2. Codex 采集脚本设计（codex-watcher，待实现）

本机新增一个轻量监视脚本（与现有 Kimi hook 并列，复用 `quota-reminder.config.json` 的 PAT 与仓库配置）：

| 要素 | 设计 |
|---|---|
| 数据源 | `~/.codex/sessions/**/*.jsonl`，按 mtime 取最新文件的最后一条 `rate_limits` |
| 触发方式 | 定时轮询（Windows 计划任务，每 5 分钟；读文件开销极小） |
| `session-activity` | 快照时间戳 > 上次上报的 `last_activity_at` → 上报 `{"platform":"codex","activity_at":<快照时间>}`，云端滑动锚点自动开窗 |
| `quota-sync` | 每次轮询上报 `secondary.resets_at` → 云端自动校准 `weekly_next`（`signal.mjs` 的 `applySyncCodex` 已支持）；同时附带 used_percent 落日志（观察用） |
| `quota-exhausted` | `rate_limit_reached_type` 非 null 或对应窗口 `used_percent >= 100` → 上报 `{"platform":"codex","tier":"5h"|"weekly","reset_at":<对应 resets_at>}`（V1 精确重置时间） |
| 去重 | 本地记一个小状态文件（最后上报的快照时间戳 + 已上报的打满窗口），避免重复发信号；云端另有打满去重兜底 |
| 降级 | watcher 挂了不丢提醒：云端 sliding anchor 窗口结束后照常推重置；只是没有新窗口开启信号 |

## 3. WorkBuddy 上线参数（已就位）

- 用户提供：月额度 **2026-10-01 00:00:00 重置**（按北京时间理解，即 `2026-10-01T00:00:00+08:00`）
- 上线操作（一次）：manual → `set_monthly_anchor`，platform=`workbuddy`，value=`2026-10-01T00:00:00+08:00` → `monthly_next` 自动算出同值，之后 tick 到点推 ✅ 并按日历月递推
- **V2 结论**：查阅官方 FAQ（workbuddy.cn/docs）——用量只能在官网「个人主页 → 用量管理」人工查看，**无公开 API**；维持手动锚点方案，不追自动化

## 4. Codex 上线参数（已查证）

- 周重置时刻（2026-09-06 14:02 北京时间快照实测）：**2026-09-07 12:25:22 北京时间**（`secondary.resets_at=1788755122`）
- 初次校准（一次）：manual → `set_weekly_next`，platform=`codex`，value=`2026-09-07T12:25:22+08:00`；watcher 上线后由 `quota-sync` 自动持续校准，无需再手动
- 基线快照存档：5h 用量 0%（窗口未开启，anchor=null 属正常——等 watcher 首次上报活动自动开窗）；周用量 85%

## 5. 上线顺序（建议）

1. 先跑两个 manual 校准（§3、§4）——dev 分支立即可用的部分
2. 实现 codex-watcher（§2），本地跑 1~2 天观察日志与云端 state 的吻合度
3. 用例回归：MP-03/04/05 由 watcher 真实驱动复测一遍（替代手工发信号）
4. Codex 周层观察满 2 个周期（V4 关闭），再评估合并 main 的事宜

## 6. 待验证点状态更新（相对 design §9）

| # | 状态（2026-09-06） |
|---|---|
| V1 | ✅ **已解决**：会话日志 `resets_at` 提供精确重置时间，云端已支持覆盖 |
| V2 | ✅ **已关闭**：WorkBuddy 无公开用量 API，维持手动锚点 |
| V3 | ✅ **已解决**：不需要 CLI hook，读取本地会话日志即可（§2 设计） |
| V4 | 🟡 初步验证通过（两个快照 resets_at 一致），继续观察 2 个周期 |

---

## 7. 采集频率优化：自适应轮询 v2（2026-09-06 定稿，待实现）

背景：v1 固定每 5 分钟轮询属过度设计——推送准时性由云端 tick 按 `reset_at` 计算，与本地轮询频率无关；本地轮询只影响「学到新锚点」的速度，而锚点到重置隔着 5 小时，30 分钟粒度绰绰有余。同时 v1 的计划任务以交互方式启动 node，每 5 分钟弹一次控制台窗口，干扰工作（已用 wscript 无窗口方案解决，见 §7.5）。

### 7.1 触发矩阵

| 触发 | 时机 | 实现 |
|---|---|---|
| 基线轮询 | 每 30 分钟 | 计划任务改为 `/mo 30`，wscript 无窗口启动；无新快照毫秒级秒退 |
| 每日全量 | 每天首次运行时一次全量扫描（跨天校准） | 合并进基线：state 记 `last_daily_scan` 日期，跨天的第一轮执行全量扫描，不当成新活动发信号 |
| 关闭补扫 | Codex 进程「在 → 不在」转换时补一次全量扫描 | watcher 每轮探测进程（`tasklist /fi "imagename eq Codex.exe"`）并在 state 记 `prev_codex_running`；发现退出转换立即补扫。CLI-only 场景由日志 mtime 兜底，无额外成本 |
| 临额升频 | 5h 或周任一层 `80 ≤ used_percent < 100`（剩余 <20% 但未打满）**且** Codex 活跃（最新日志 15 分钟内有写入，或进程在） | 本轮 watcher **不退出**：进程内驻留，每 5 分钟一轮，直到升频条件全部消失；安全上限驻留 6 小时强制退出（防僵死） |

### 7.2 层级闸门（采集侧）

- 周打满（`secondary.used_percent ≥ 100`）：不再发 `quota-exhausted(5h)`，不进入升频——5h 重置在周打满期间无意义；`session-activity` 照发（维持活动记录，推送静默由云端层级闸门负责）
- 周重置后 `used_percent` 回落，一切自动恢复
- 与云端「高层打满则低层静默」的推送闸门方向一致，互不依赖

### 7.3 单实例锁

- 锁文件 `~/.kimi-code/hooks/codex-watcher.lock`（内容 PID + 时间戳），驻留循环每轮刷新 mtime
- 新启动的 watcher 发现锁且 mtime < 10 分钟 → 立即退出（有驻留实例在干活，避免与 30 分钟基线任务重叠）
- 锁 mtime ≥ 10 分钟视为僵死 → 接管并继续

### 7.4 为什么升频不能靠改计划任务

实测普通权限下创建/修改计划任务被拒（需管理员）。watcher 无法自己调整触发间隔，所以升频必须用「进程内驻留循环」实现：基线任务固定 30 分钟不变，进入临额区间的当轮进程自己留下来加转。

### 7.5 部署变更（一次性，需管理员）

- 计划任务重建：wscript 无窗口 + `/mo 30`——执行工作区 `_fix_task.cmd`（右键 → 以管理员身份运行）；
  `local/register-codex-watcher-task.ps1` 同步更新为同款配置（wscript 启动器 + 30 分钟间隔）
- 无窗口启动器 `~/.kimi-code/hooks/codex-watcher.hidden.vbs` 已就位并实测通过（2026-09-06，无弹窗、日志正常）
