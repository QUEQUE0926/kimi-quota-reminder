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

---

## 11. 实施结果（2026-09-06，dev/multi-platform 实测完成）

### 11.1 代码落地

- 新增 `scripts/platforms.mjs` 共享层：平台注册表（label / tiers / sliding5h / scheduledMonthly）、
  state v1→v2 迁移（`loadState`，幂等，日志 `migrated state v1 -> v2`）、`ensurePlatform` 懒建命名空间、
  `nextMonthlyReset`（日历月递推）等公共函数。signal / tick / manual 三入口统一走这一层。
- `signal.mjs`：payload 支持可选 `platform`（缺省 kimi）；新增 `session-activity`（Codex 滑动锚点：
  首开 / 窗口内不动 / 结束后重开三种路径，日志分别为 `new 5h window opened` / `window in progress, anchor kept`）；
  打满信号按平台路由、去重规则不变；Kimi 路径逐行保持原行为。
- `tick.mjs`：按 `state.platforms` 逐平台独立评估。Codex 跨边界后推 ✅/ℹ️「5 小时窗口已可用」
  并将 anchor 置 null（不递推）；周层 +7d 递推、周打满压制 5h、周重置连带清 5h 标志。
  WorkBuddy 纯月层：`monthly_next` 到点推「✅ WorkBuddy 月额度已重置」并按日历月递推；
  无锚点时日志 `workbuddy: no anchor, skipped` 安全跳过。
- `manual.mjs`：全部操作新增 `platform` 输入（默认 kimi）；**新增操作 `set_monthly_next`**
  （MP-12 允许的直达操作，用于把下次月重置拨到过去以触发 tick）；`monthly_cap` 仅 kimi 适用，
  其余平台显式报错；`clear_flags` 只清指定平台命名空间内的标志。
- `push.mjs`：标题平台标签由调用方按平台 label 生成（Kimi 标题与单平台版完全一致）；
  **Bark 分组升级已实施**：Kimi 保持 `Kimi Code 额度`（测试态 `Kimi Code 额度 · 测试`）不变，
  其他平台为 `Kimi Code 额度 · <平台>`（测试态 `Kimi Code 额度 · <平台> · 测试`）；
  推送标题与正文、Bark 分组均写入运行日志，便于线上核验。
- workflow：`signal.yml` 的 repository_dispatch / workflow_dispatch 增加 `session-activity` 类型；
  `manual.yml` 增加 `platform` 输入与 `set_monthly_next` 操作；signal / tick 的 main 防呆守卫、
  非 main 的 `PUSH_TEST=1` 打标机制原样保留；`tick.yml` 零改动。

### 11.2 实测记录（MP-00 ~ MP-15 全部通过）

本地先跑无人值守回归（无 secret，推送走 skipped 分支）：`local/run-tests.mjs`（Kimi 原有用例，
已适配 v2 结构）48/48 通过，`local/run-mp-tests.mjs`（MP-01~13 逻辑等价）48/48 通过。
随后在 dev/multi-platform 分支逐个手动触发 workflow 实测（推送真实发出，均带 `[测试] ` 前缀）：

| 用例 | 结果 | 关键证据（运行日志 / state） |
|---|---|---|
| MP-00 | ✅ | `codex: all exhausted flags cleared (five_h_exhausted, weekly_exhausted)`；默认 platform 只清 kimi，codex 标志不变 |
| MP-01 | ✅ | 日志 `migrated state v1 -> v2`；schema=2，anchor/weekly_next/用量/monthly_anchor 原样保留；二次运行无迁移日志（幂等） |
| MP-02 | ✅ | `[测试] ⚠️ Kimi Code 5 小时额度已用完`，Bark 组 `Kimi Code 额度 · 测试`（与单平台一致）；重复信号 `no duplicate push` |
| MP-03 | ✅ | `codex: new 5h window opened`，无推送；anchor = activity_at+5h，last_activity_at 记录 |
| MP-04 | ✅ | `codex: window in progress, anchor kept`；anchor 不变，仅 last_activity_at 更新 |
| MP-05 | ✅ | anchor 拨到过去后再活动 → 重开新窗口（当前+5h）；本地回归另验证 exhausted 标志一并清除 |
| MP-06 | ✅ | `[测试] ⚠️ Codex 5 小时额度已用完`，Bark 组 `Kimi Code 额度 · Codex · 测试`；kimi 命名空间不受影响；重复去重 |
| MP-07 | ✅ | tick 推 `[测试] ✅ Codex 5 小时窗口已可用`（「上周期已打满；下次会话将开启新的 5 小时窗口。」）；`five_h_anchor=null` 不递推；ℹ️ 变体亦通过 |
| MP-08 | ✅ | 周打满后 tick 日志 `push suppressed (层级闸门)`，无任何推送；anchor 仍置空 |
| MP-09 | ✅ | `✅ Codex 周额度已重置`，文案含「5 小时窗口同步恢复」；weekly_next +7d，两标志皆清 |
| MP-10 | ✅ | codex 周打满期间 kimi 侧 `✅ Kimi Code 5小时额度已重置` 照常发出；两平台字段各自独立 |
| MP-11 | ✅ | `workbuddy: monthly_anchor = 2026-09-05T14:00:00.000Z`，`monthly_next = 2026-10-05T14:00:00.000Z` 自动算出；无推送 |
| MP-12 | ✅ | tick 推 `✅ WorkBuddy 月额度已重置`（「月额度已在 … 刷新，下次重置 2026/10/5 22:00:00。」）；monthly_next 按日历月推进；再跑 tick `no boundary crossed, no-op` |
| MP-13 | ✅ | 无锚点时 `workbuddy: no anchor, skipped`，成功无推送，其他平台不受影响 |
| MP-14 | ✅ | `🔔 Codex 额度提醒测试`（正文 5h+周两行，无月层行）；`🔔 WorkBuddy 额度提醒测试`（正文仅月层一行） |
| MP-15 | ✅ | main 手动跑 signal / tick 均 conclusion=failure（守卫报错信息原样）；dev 推送全程 `[测试] ` 前缀，Bark 分组按 §6 升级版生效 |

补充说明：
- MP-13 前置若只把 `monthly_next` 置 null 而保留 `monthly_anchor`，tick 会从 anchor 重新推导
  `monthly_next`（日志 `monthly_next derived from anchor`）——这是 §5 设计行为（anchor 为唯一事实源），
  不算跳过；「no anchor, skipped」只在 anchor 也为 null 时出现。实测按后者验证。
- 测试期间 kimi 的 `five_h_anchor` 曾被 manual 校准到未来时刻以免干扰 codex 用例的「无推送」断言，
  属 dev 分支正常校准操作；main 分支代码、state.json、tag `v1.0-single-platform` 全程零改动。

### 11.3 待验证点结论

| # | 结论（截至 2026-09-06） |
|---|---|
| V1 | **云端已就绪，采集侧待验证**。`signal.mjs` 已支持 `quota-exhausted`（codex/5h）携带 `reset_at` 时优先覆盖滑动锚点推算值（代码中带 TODO(V1) 标注）；但 Codex 限流错误是否自带重试时间、文案格式如何，需等采集侧 hook（V3）落地后首次真实打满落盘确认。 |
| V2 | **待验证**。本期 WorkBuddy 一律手动设锚点（`set_monthly_anchor`），未调研其用量/订阅 API。 |
| V3 | **待验证**。Codex CLI 的 hook / notify 能力未确认；采集侧不在本期范围。降级方案（wrapper 脚本记录活动时间上报 `session-activity`）在云端协议上已可直接对接。 |
| V4 | **待观察**。Codex 周层按固定时刻表 +7d 递推实现并通过了 MP-09 实测（逻辑层），是否与真实计费周期一致需观察 2 个周期；首次使用需用 `set_weekly_next`（platform=codex）校准一次。 |
