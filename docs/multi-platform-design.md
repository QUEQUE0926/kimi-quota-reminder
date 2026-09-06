# 多平台扩展设计方案（dev/multi-platform 专属）

> 本文档只在 `dev/multi-platform` 分支演进，**不进入 main**。main 的单平台定稿见 tag `v1.0-single-platform`。
> 基础架构、提醒哲学、测试隔离机制均继承自主方案 `kimi-quota-reminder-plan.md`（下称「主方案」），本文只写差异与新增。

## 1. 目标与范围

把「额度重置提醒器」从 Kimi Code 单平台扩展为多平台框架，首批接入两个新平台：

| 平台 | 层级 | 关键差异 |
|---|---|---|
| **Codex**（OpenAI） | 5h + 周（无月层） | 5h 窗口**不是固定时刻表**，而是滑动锚点：**上一个窗口结束后的首次会话活动时间 + 5h** |
| **WorkBuddy** | 仅月层 | 只要「月额度重置时间」提醒，无打满信号、无 5h/周层 |

共性规则（与 Kimi Code 一致）：
- **纯层级闸门**：高层级打满压制低层级提醒（周打满 → 5h 重置不提醒）；不看用量百分比
- 打满去重、重置推送分级（打满过 ✅ / 未打满 ℹ️）、快照 📴 passive
- 推送通道复用现有四路（WeCom / Bark / WxPusher / ntfy），**消息标题加平台标签区分**

## 2. state.json 演进：v1 → v2（平台命名空间）

现状 v1：Kimi 的三层状态平铺在顶层（`five_h_anchor`、`weekly_next`、`monthly_exhausted_until` 等）。多平台后按平台隔离：

```json
{
  "schema": 2,
  "platforms": {
    "kimi": {
      "five_h_anchor": "...", "five_h_used": 0, "five_h_limit": 0, "five_h_exhausted": false,
      "weekly_next": "...", "weekly_used": 0, "weekly_limit": 0, "weekly_exhausted": false,
      "monthly_anchor": "...", "monthly_exhausted_until": null, "monthly_signal_at": null
    },
    "codex": {
      "five_h_anchor": null, "five_h_exhausted": false, "last_activity_at": null,
      "weekly_next": null, "weekly_exhausted": false
    },
    "workbuddy": {
      "monthly_anchor": null, "monthly_next": null
    }
  }
}
```

- **自动迁移**：signal / tick / manual 启动时检测 `schema` 缺失或为 1 → 把顶层 Kimi 字段原样搬进 `platforms.kimi`，写入 `schema: 2`。迁移只发生一次，幂等。
- 每个平台只声明自己有的层级字段；不存在的层级在逻辑里跳过。
- `platforms.codex.weekly_next` 初始化：首次由 manual 校准一次（同 Kimi 的 `set_weekly_next`），之后 tick 递推 +7d。

## 3. 信号协议演进：加 platform 字段

所有信号 payload 新增可选字段 `platform`，**缺省 = `kimi`**——现有 Kimi hook（quota-sync / quota-signal / quota-close）一个字都不用改，天然向后兼容。

| 信号类型 | 说明 | 新增/复用 |
|---|---|---|
| `quota-sync` | 启动同步 | 复用，payload 带 `platform` |
| `quota-exhausted` | 打满信号 `{"tier":"5h"|"weekly"|"monthly"}` | 复用，带 `platform` |
| `quota-close` | 关闭快照 | 复用，带 `platform` |
| `session-activity` | **新增**，Codex 专用：`{"platform":"codex","activity_at":"<ISO>"}`，驱动滑动锚点（见 §4） | 新增 |

## 4. Codex：滑动锚点的 5h 窗口（核心差异）

Kimi 的 5h 边界是固定时刻表（anchor 按 5h 步长递推）；Codex 的窗口从「上个窗口结束后的第一次会话」开始计时 5h。云端规则：

1. **收到 `session-activity`**（`activity_at` = t）：
   - 若 `five_h_anchor` 为 null 或 `t >= five_h_anchor`（窗口不存在或已结束）→ **开新窗口**：`five_h_anchor = t + 5h`，清 `five_h_exhausted`，记 `last_activity_at = t`
   - 若 `t < five_h_anchor`（窗口进行中）→ 只更新 `last_activity_at`，**anchor 不动**
2. **打满 `quota-exhausted {"platform":"codex","tier":"5h"}`**：置 `five_h_exhausted=true`，推 ⚠️（去重规则同 Kimi）。重置时间展示当前 `five_h_anchor`。
   - 待验证点 V1：Codex 限流错误文案若自带重试时间（如 "try again at ..."），hook 解析后随信号上报 `reset_at`，云端优先采用，覆盖 t+5h 的推算值。
3. **tick 跨边界**（`now >= five_h_anchor`）：层级闸门判定（周打满则静默）后推 ✅/ℹ️ 重置提醒；**anchor 不递推，置回 null**——Codex 的下一个窗口等下一次 `session-activity` 来开，这是和 Kimi 的本质区别（Kimi 是时刻表自动 +5h）。
   - 注意：推送语义相应调整——Kimi 是「窗口已刷新」，Codex 是「窗口已可用，下次会话将开启新的 5h 窗口」。
4. **周层**：与 Kimi 相同——固定时刻表 +7d 递推，周打满压制 5h 重置提醒，周重置时连带清 5h 打满标志。
5. Codex 无月层：层级闸门只判周。

层级闸门真值表（Codex）：

| 周状态 | 5h 跨边界时 |
|---|---|
| 正常 | 推 ✅（上周期打满过）/ ℹ️（未打满） |
| 已打满 | 静默（周重置了 5h 才可用） |

## 5. WorkBuddy：纯月重置提醒

- 唯一状态：`monthly_anchor`（订阅/计费周期时刻，manual 设一次）+ `monthly_next`（下次重置 = anchor 按 1 个月递推）。
- tick 到达 `monthly_next` → 推「✅ WorkBuddy 月额度已重置」（active 亮屏），`monthly_next` 自动 +1 月。
- 无打满信号、无低层级、无快照；层级闸门天然无压制条件。
- 月递推规则与 Kimi §7 相同：按日历月加 1 个月（保留时刻），不做 30 天近似。
- 待验证点 V2：WorkBuddy 是否暴露用量/订阅接口。若有，后续可升级为自动校准 anchor；本期一律手动。

## 6. 推送文案规范（多平台）

标题统一加平台标签，同一手机多平台消息一眼可辨：

| 场景 | 标题示例 |
|---|---|
| Kimi（现状不变） | `⚠️ Kimi Code 5 小时额度已用完` |
| Codex | `⚠️ Codex 5 小时额度已用完` / `✅ Codex 5 小时窗口已可用` |
| WorkBuddy | `✅ WorkBuddy 月额度已重置` |

- dev 分支运行时 `[测试] ` 前缀仍加在最前面（`[测试] ⚠️ Codex …`），Bark 分组规则不变（方案 §6.1）。
- Bark `group` 建议升级为 `Kimi Code 额度 · <平台>`（如 `Kimi Code 额度 · Codex`），测试态再叠加 `· 测试`。

## 7. workflow 与 manual 操作调整

- **signal / tick**：按 §3 读 `platform`，逐平台独立评估、独立提交 state。tick 单次运行可产出多条推送（每平台至多一条）。
- **manual**：新增可选输入 `platform`（默认 `kimi`）。既有操作（`set_anchor` / `set_weekly_next` / `set_monthly_anchor` / `monthly_cap` / `clear_flags` / `test_push`）全部按 platform 路由到对应命名空间；`clear_flags` 清指定平台的全部标志。
- **防呆护栏不变**：signal / tick 仍禁止在 main 手动触发。
- **main 完全不动**：本方案所有代码改动只进 dev 分支，验证稳定后再议合并（届时单独评审，且需要 main 侧 Kimi hook 零改动的回归证据）。

## 8. 采集侧（本机 hook）规划

| 平台 | 信号来源 | 状态 |
|---|---|---|
| Kimi | 现有两个 hook（SessionStart / StopFailure / SessionEnd） | 不动 |
| Codex | Codex CLI 的 hook / notify 机制上报 `session-activity` 与限流错误 | **待验证点 V3**：Codex CLI 是否提供会话生命周期 hook 或 notify 回调；若不可用，降级方案为 wrapper 脚本包一层 `codex` 命令记录活动时间 |
| WorkBuddy | 无信号，纯 tick 时间驱动 | 手动设锚点即可 |

## 9. 待验证点汇总

| # | 内容 | 验证方式 |
|---|---|---|
| V1 | Codex 限流错误是否自带重试时间，文案格式 | 首次打满时落盘原始错误输出人工查看 |
| V2 | WorkBuddy 有无用量/订阅 API | 查其控制台/文档 |
| V3 | Codex CLI 的 hook / notify 能力 | 查 Codex 文档与配置项 |
| V4 | Codex 周额度是否固定时刻表（+7d 递推成立） | 观察 2 个周期 |

## 10. 配套测试用例

见同目录 `multi-platform-test-cases.md`（编号 MP-01 起）。
