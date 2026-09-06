# 多平台扩展测试用例（dev/multi-platform 专属）

> 配套方案：`./multi-platform-design.md`（下称「MP 方案」）。编号 MP-xx 与主测试用例（`dev-test-cases.md` 用例 0~18）互不冲突，可混跑。
> **通用操作、铁律与主用例文档完全相同**：Branch 一律选 `dev/multi-platform`；推送真实发出；dev 上标题自动带 `[测试] ` 前缀（下文预期标题均省略）；带「打满」的用例测完跑 MP-00 清理。

---

## MP-00 · 清理（clear_flags，带 platform）

- workflow：**manual**，操作类型 `clear_flags`，platform 填 `codex`（或 `workbuddy`）
- 预期：无推送；日志显示对应平台标志已清；`platforms.<平台>` 下 exhausted 类字段复位
- 对照：不带 platform（默认 `kimi`）跑一次，只影响 kimi 命名空间，codex 状态不变

---

## MP-01 · state 自动迁移（v1 → v2）

> 前置：dev 分支 state.json 为旧版平铺格式（`schema` 字段不存在）。若 dev 已是 v2，可先手动把 state.json 内容替换为 v1 备份格式再测。

- workflow：**signal**，类型 `quota-sync`，payload 同主用例 1（**不带 platform 字段**）
- 预期：✅ 成功；state.json 变为 `schema: 2` + `platforms.kimi.*` 结构，原 `five_h_anchor` / `weekly_next` / 用量值**原样保留**；日志有 `migrated state v1 -> v2`
- 幂等对照：再跑一次相同信号，日志无迁移记录，状态无变化

## MP-02 · 向后兼容（无 platform 字段 = kimi）

- workflow：**signal**，类型 `quota-exhausted`，payload `{"tier":"5h"}`（不含 platform）
- 预期：与主用例 2 完全一致——`platforms.kimi.five_h_exhausted=true`，推送标题为 **⚠️ Kimi Code 5 小时额度已用完**（无平台标签变化）
- 测完 `clear_flags`（不带 platform）清理

---

## MP-03 · Codex 首开窗口（session-activity 建锚点）

- 前置：MP-00 清理 codex；确认 `platforms.codex.five_h_anchor = null`
- workflow：**signal**，类型 `session-activity`，payload：
  ```json
  {"platform":"codex","activity_at":"<当前时间 ISO>"}
  ```
- 预期：**无推送**；`five_h_anchor` = activity_at + 5h；`last_activity_at` = activity_at；日志 `codex: new 5h window opened`

## MP-04 · Codex 窗口内活动（锚点不动）

- 前置：紧接 MP-03（窗口进行中）
- 再发一次 `session-activity`，`activity_at` 填比 MP-03 晚 10 分钟的时间
- 预期：`five_h_anchor` **保持 MP-03 的值不变**；仅 `last_activity_at` 更新；日志 `codex: window in progress, anchor kept`

## MP-05 · Codex 窗口结束后再活动（重开窗口）

- 前置：先用 manual `set_anchor`（platform=`codex`）把 `five_h_anchor` 拨到过去时间
- 发 `session-activity`，`activity_at` 填当前时间
- 预期：`five_h_anchor` = 当前 + 5h（**新窗口**）；若之前有 `five_h_exhausted` 标志应一并清除；日志 `codex: new 5h window opened`

## MP-06 · Codex 5h 打满（⚠️ 亮屏推送）

- workflow：**signal**，类型 `quota-exhausted`，payload `{"platform":"codex","tier":"5h"}`
- 预期推送（**亮屏**，带平台标签）：
  > **⚠️ Codex 5 小时额度已用完**
  > 预计 <five_h_anchor 时间> 重置。
- 预期状态：`platforms.codex.five_h_exhausted=true`；kimi 命名空间不受影响
- 重复发一遍应**无推送**（去重，同主用例 3）

## MP-07 · Codex 5h 跨边界（tick 推重置，锚点置空不递推）

> MP 方案 §4 核心差异：Codex 跨边界后 anchor **置回 null** 等下次活动重开，不像 Kimi 自动 +5h。

1. 先跑 MP-06（5h 打满，收到 ⚠️）
2. manual `set_anchor`（platform=`codex`）填过去时间
3. **tick**：直接运行

- 预期推送（**亮屏**，语义与 Kimi 不同）：
  > **✅ Codex 5 小时窗口已可用**
  > 上周期已打满；下次会话将开启新的 5 小时窗口。
- 预期状态：`five_h_exhausted=false`；`five_h_anchor=null`（**不是** +5h 递推）
- 对照（ℹ️ 变体）：跳过第 1 步直接做 2/3，应收到 **ℹ️ Codex 5 小时窗口已可用**（未打满文案）
- 测完 MP-00 清理 codex

## MP-08 · Codex 周打满压制 5h 重置（层级闸门）

1. **signal** `quota-exhausted` `{"platform":"codex","tier":"weekly"}`（收到 ⚠️ Codex 周额度已用完）
2. **signal** `quota-exhausted` `{"platform":"codex","tier":"5h"}`（收到 ⚠️）
3. manual `set_anchor`（platform=`codex`）填过去时间
4. **tick** 运行

- 预期：第 4 步**无任何推送**（周打满压制，同 Kimi 用例 12 的语义）；`five_h_anchor` 仍被处理（置空）
- 测完 MP-00 清理 codex

## MP-09 · Codex 周重置（tick，✅ 亮屏 + 连带清 5h 标志）

1. **signal** `quota-exhausted` `{"platform":"codex","tier":"weekly"}`（收到 ⚠️）
2. manual `set_weekly_next`（platform=`codex`）填过去时间
3. **tick** 运行

- 预期推送：**✅ Codex 周额度已重置**，文案含「5 小时窗口同步恢复」
- 预期状态：`weekly_next` 推进到 +7d 未来；`weekly_exhausted=false`、`five_h_exhausted=false`
- 测完 MP-00 清理 codex

## MP-10 · 跨平台隔离（Codex 打满不影响 Kimi 推送）

1. **signal** `quota-exhausted` `{"platform":"codex","tier":"weekly"}`（Codex 周打满）
2. 按主用例 11 的步骤操作 **kimi** 侧：`quota-exhausted {"tier":"5h"}` → `set_anchor` 过去时间 → tick

- 预期：第 2 步 kimi 侧 **✅/ℹ️ 推送照常发出**——Codex 的周打满不压制 Kimi；state 里两平台字段各自独立
- 测完 MP-00 分别清理 codex 和 kimi

---

## MP-11 · WorkBuddy 设锚点（manual）

- workflow：**manual**，操作类型 `set_monthly_anchor`，platform 填 `workbuddy`，value 填订阅周期时刻（如 `2026-09-05T22:00:00+08:00`）
- 预期：无推送；`platforms.workbuddy.monthly_anchor` 写入；`monthly_next` 自动算出（anchor 按日历月递推到的下一个未来时刻）；日志显示两个字段

## MP-12 · WorkBuddy 月重置（tick，✅ 亮屏 + 递推）

1. 先跑 MP-11 设好锚点
2. 用 manual 把 `platforms.workbuddy.monthly_next` 拨到过去时间（直达操作：`set_monthly_next`，platform 填 `workbuddy`）
3. **tick** 运行

- 预期推送（**亮屏**）：
  > **✅ WorkBuddy 月额度已重置**
  > 月额度已在 <时间> 刷新，下次重置 <+1 月时间>。
- 预期状态：`monthly_next` 推进到下一个月度未来时刻（按日历月，保留时刻，非 30 天近似）
- 静默对照：再跑一次 tick，应 `no boundary crossed, no-op` 无推送

## MP-13 · WorkBuddy 无月锚点时 tick（安全跳过）

- 前置：`platforms.workbuddy` 整个删除或 `monthly_next=null`
- **tick** 运行
- 预期：✅ 成功，workbuddy 平台被跳过（日志 `workbuddy: no anchor, skipped`）；其他平台评估不受影响；无推送

---

## MP-14 · test_push 通道自检（多平台版文案）

- workflow：**manual**，操作类型 `test_push`，platform 填 `codex`
- 预期推送：标题 **🔔 Codex 额度提醒测试**（dev 上带 `[测试] ` 前缀），内容含 codex 的两层状态（5h 窗口 / 周额度），无月层行
- 对照：platform 填 `workbuddy` 再跑一次，内容只含月层一行

## MP-15 · 防呆与打标回归（继承主用例）

- 主用例 16（main 分支手动跑 signal/tick 被拒）和用例 17（`[测试]` 前缀 + Bark 测试分组）在多平台代码下**重跑一次**，确认护栏与打标未被破坏
- Bark 分组预期（分组升级已实施，2026-09-06 实测确认）：非 Kimi 平台为 `Kimi Code 额度 · <平台>`，dev 测试态叠加 `· 测试`（如 `Kimi Code 额度 · Codex · 测试`）；Kimi 保持 `Kimi Code 额度` / `Kimi Code 额度 · 测试` 不变

---

## 全部测完后的检查清单（多平台增量）

- [ ] v1 → v2 迁移幂等，kimi 数据无损（MP-01）
- [ ] 旧 payload（无 platform）行为与迁移前完全一致（MP-02）
- [ ] Codex 滑动锚点三种场景：首开 / 窗口内不动 / 结束后重开（MP-03/04/05）
- [ ] Codex 跨边界后 anchor 置空等重开，**不自动递推**（MP-07）
- [ ] Codex 周打满压制 5h（MP-08）；周重置连带清 5h 标志（MP-09）
- [ ] 跨平台状态完全隔离（MP-10）
- [ ] WorkBuddy 月重置推送 + 日历月递推（MP-11/12/13）
- [ ] 平台标签文案正确，test_push 按平台出对应层级快照（MP-14）
- [ ] 护栏与打标无回归（MP-15）
- [ ] main 分支代码、state、tag `v1.0-single-platform` 全程零改动
- [ ] 最后各平台各跑一次 MP-00，分支状态干净
