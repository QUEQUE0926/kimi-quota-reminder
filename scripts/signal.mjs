// signal：repository_dispatch 触发，处理本机 hook 发来的信号。
//   quota-sync       SessionStart 同步：校准时刻表、更新用量、兜底补置 exhausted 标志、档位评估
//   quota-exhausted  StopFailure 打满：按 tier 置标志（monthly 按锚点自动算 until）
//   quota-close      SessionEnd 关闭：同步状态后按规则推送额度快照
//   session-activity Codex 专用：滑动锚点开窗（MP 方案 §4）
// 多平台（MP 方案 §3）：payload 可带 platform 字段，缺省 = kimi（旧 hook 零改动兼容）。
// 档位提醒（MP 方案 §12）：各 applySync* 内按 *_alert 阶梯字段评估 30/50/80 档，
// 跨档推一条 🔶（active），打满直跳 100 只推 ⚠️；层级闸门与 exhausted 同判断点。
// WorkBuddy（collection §9.3）：workbuddy-watcher 的 quota-sync 由 applySyncWorkbuddy 消费——
// monthly.reset_at 纠偏锚点（对标 applySyncCodex）、used/limit 落 state、used>=limit 置月闸门。
import { pushAll } from './push.mjs';
import {
  PLATFORMS, TIER_NAMES, TIER_FIELD, FIVE_H, fmt, nextMonthlyReset,
  loadState, saveState, ensurePlatform,
} from './platforms.mjs';

const ALIGN_TOLERANCE = 2 * 60 * 1000; // anchor 校准容差：2 分钟
const SYNC_TOLERANCE = 5000; // quota-sync 纠偏容差：monthly_next 与上报 reset_at 偏差（watcher 同值）

const eventType = process.env.EVENT_ACTION; // repository_dispatch 的 event_type
const payload = JSON.parse(process.env.CLIENT_PAYLOAD || '{}') || {};
const platform = (payload.platform || 'kimi').trim();

const { state, changed: migrated } = loadState();
const { label } = PLATFORMS[platform] || {};
if (!label) throw new Error(`unknown platform in payload: "${platform}"`);
const { ps } = ensurePlatform(state, platform);
let changed = migrated;

const nowIso = new Date().toISOString();
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const newlyExhausted = []; // 本次运行中新置位的打满层级（用于「额度用光」active 提醒）

// 「额度用光」提醒：仅在某层新打满时推一次（active 级别）
// ttl = 距重置的秒数：重置后这条通知就是废纸，自动从 Bark 历史里删掉；重置时间未知则不设 ttl
async function notifyExhausted(tier) {
  // workbuddy 个人版无统一重置时间（方案 B，collection §9.4）：打满提醒不承诺具体重置
  // 时刻（那是用户手填锚点的递推值，非真实计费周期），也不挂长 ttl——真实恢复点是
  // 新资源包到账，watcher 观察到回落即清闸门，短通知比一条 20 天 ttl 的臆测提醒诚实
  const personalWb =
    platform === 'workbuddy' && String(payload.account_type || '').toLowerCase() !== 'enterprise';
  const when =
    tier === '5h' ? ps.five_h_anchor
    : tier === 'weekly' ? ps.weekly_next
    : personalWb ? null
    : ps.monthly_exhausted_until || ps.monthly_next; // workbuddy 企业版无 until 语义，用 monthly_next
  const body = when
    ? `预计 ${fmt(when)} 重置。` +
      (tier === 'monthly' && platform === 'kimi'
        ? '月额度重置前，5 小时 / 周额度即使到点重置也不可用。'
        : '')
    : tier === 'monthly' && personalWb
      ? '各资源包独立过期，新包到账后自动恢复。'
      : '重置时间未知。';
  const ttl = when ? Math.max(60, Math.round((Date.parse(when) - Date.now()) / 1000)) : undefined;
  await pushAll({ title: `⚠️ ${label} ${TIER_NAMES[tier]}已用完`, body, ttl, platform: label });
}

// ---- 用量档位提醒（MP 方案 §12）：30/50/80 阶梯，状态翻转推一次，*_alert 单调不减天然去重 ----

// 层级闸门（§12.2-4）：高层打满（*_alert==100 ≡ exhausted）期间低层档位静默。
// 与 tick 的 exhausted 闸门同一判断点、同一语义；codex 同步报 100% 但 quota-exhausted
// 尚未到达时，alert==100 先行压闸（镜像不变量：*_exhausted ≡ *_alert==100）。
function alertGated(tier) {
  const hiAlert = (field) => Number(ps[`${field}_alert`]) === 100;
  if (platform === 'kimi') {
    if (tier === '5h') return !!ps.weekly_exhausted || hiAlert('weekly') || !!ps.monthly_exhausted_until;
    if (tier === 'weekly') return !!ps.monthly_exhausted_until;
  } else if (platform === 'codex') {
    if (tier === '5h') return !!ps.weekly_exhausted || hiAlert('weekly');
  }
  return false; // workbuddy 纯月层，天然无压制条件
}

// 档位评估：pct 为 0-100 用量百分比（null = 本次上报无该层数据，跳过）。
// 规则（§12.2）：① pct≥100 直跳 100，只由打满路径推 ⚠️，中间档不补推；
// ② 一次跨多档只推被跨过的最高档；③ 同档不重复；④ 闸门期间静默且不进档（恢复后从原档位继续）。
async function evalTierAlert(tier, pct, usageText, resetIso) {
  const thresholds = PLATFORMS[platform].alerts?.[tier];
  if (!thresholds || pct === null || !Number.isFinite(pct)) return;
  const key = `${TIER_FIELD[tier]}_alert`;
  const cur = Number(ps[key]) || 0;
  if (pct >= 100) {
    if (cur !== 100) { ps[key] = 100; changed = true; }
    return;
  }
  if (alertGated(tier)) {
    console.log(`alert: ${platform}/${tier} ${Math.round(pct)}% but higher tier exhausted, suppressed (层级闸门)`);
    return;
  }
  const crossed = thresholds.filter((t) => t > cur && pct >= t);
  if (crossed.length === 0) return;
  const t = Math.max(...crossed);
  ps[key] = t;
  changed = true;
  const realPct = Math.round(pct * 10) / 10;
  const personalWb =
    platform === 'workbuddy' && String(payload.account_type || '').toLowerCase() !== 'enterprise';
  const when = personalWb ? null : resetIso;
  const body =
    (realPct > t ? `用量已跨过 ${t}% 档位，当前实际 ${realPct}%` : `当前用量 ${realPct}%`) +
    (usageText ? `（${usageText}）` : '') +
    (when ? `，预计 ${fmt(when)} 重置。` : personalWb ? '。各资源包独立过期，重置时间以实际到账为准。' : '，重置时间未知。') +
    (platform === 'codex' ? '（滑动窗口，会话间隙数据不更新）' : '');
  const ttl = when ? Math.max(60, Math.round((Date.parse(when) - Date.now()) / 1000)) : undefined;
  await pushAll({ title: `🔶 ${label} ${TIER_NAMES[tier]}已用 ${t}%`, body, ttl, platform: label });
}

// 打满镜像（§12.1）：*_exhausted ≡ *_alert==100，由写入侧同步维护，tick 只读 exhausted
function mirrorAlertExhausted(tier) {
  const key = `${TIER_FIELD[tier]}_alert`;
  if (PLATFORMS[platform].alerts?.[tier] && Number(ps[key]) !== 100) {
    ps[key] = 100;
  }
}

// ---- Kimi：quota-sync / quota-close 共用的状态同步（行为与单平台版完全一致） ----
async function applySyncKimi(p) {
  const { five_h, weekly, monthly, raw } = p;

  if (weekly?.reset_at) {
    ps.weekly_next = weekly.reset_at;
    changed = true;
  }
  if (num(weekly?.used) !== null) ps.weekly_used = weekly.used;
  if (num(weekly?.limit) !== null) ps.weekly_limit = weekly.limit;
  if (num(weekly?.used) !== null && num(weekly?.limit) > 0 && weekly.used >= weekly.limit) {
    if (!ps.weekly_exhausted) {
      console.log('sync: weekly exhausted (missed by StopFailure hook), flag set');
      newlyExhausted.push('weekly');
    }
    ps.weekly_exhausted = true;
    mirrorAlertExhausted('weekly');
  }

  if (five_h?.reset_at) {
    const resetMs = Date.parse(five_h.reset_at);
    const old = ps.five_h_anchor ? Date.parse(ps.five_h_anchor) : null;
    if (old === null) {
      ps.five_h_anchor = five_h.reset_at;
      console.log(`sync: anchor initialized -> ${five_h.reset_at}`);
    } else {
      // 校准：上报的 reset_at 应落在 anchor + 5h·k 上，偏差超阈值则纠正 anchor
      const diff = Math.abs(resetMs - old) % FIVE_H;
      const misalign = Math.min(diff, FIVE_H - diff);
      if (misalign > ALIGN_TOLERANCE) {
        console.log(`sync: anchor corrected ${ps.five_h_anchor} -> ${five_h.reset_at} (misalign ${(misalign / 1000).toFixed(0)}s)`);
        ps.five_h_anchor = five_h.reset_at;
      }
    }
    changed = true;
  }
  if (num(five_h?.used) !== null) ps.five_h_used = five_h.used;
  if (num(five_h?.limit) !== null) ps.five_h_limit = five_h.limit;
  if (num(five_h?.used) !== null && num(five_h?.limit) > 0 && five_h.used >= five_h.limit) {
    if (!ps.five_h_exhausted) {
      console.log('sync: 5h exhausted (missed by StopFailure hook), flag set');
      newlyExhausted.push('5h');
    }
    ps.five_h_exhausted = true;
    mirrorAlertExhausted('5h');
  }

  // 月窗口升级路径（方案 §7）：若用量接口开始出现月窗口，自动接管
  if (monthly?.reset_at) {
    console.log(`sync: monthly window present in API: ${JSON.stringify(monthly)}`);
    if (num(monthly?.used) !== null && num(monthly?.limit) > 0 && monthly.used >= monthly.limit) {
      if (!ps.monthly_exhausted_until) newlyExhausted.push('monthly');
      ps.monthly_exhausted_until = monthly.reset_at;
      console.log('sync: monthly exhausted, until set automatically');
    }
  }
  if (raw) console.log(`sync: raw usage = ${JSON.stringify(raw)}`);

  // 档位评估（§12.2，高层先评：本周新打满时同轮的 5h 档位立即被闸门压住）；
  // 月层不参与（V5 已验证 API 无月窗口数据，§12.6）
  const pctOf = (w) =>
    num(w?.used) !== null && num(w?.limit) > 0 ? (w.used / w.limit) * 100 : null;
  await evalTierAlert('weekly', pctOf(weekly),
    weekly ? `${weekly.used}/${weekly.limit}` : '', ps.weekly_next);
  await evalTierAlert('5h', pctOf(five_h),
    five_h ? `${five_h.used}/${five_h.limit}` : '', ps.five_h_anchor);

  ps.last_sync = nowIso;
  changed = true;
}

// Codex 同步：滑动锚点平台不做 5h 时刻表校准；仅接收周重置时间（用量字段不落盘，只记日志）。
// 档位提醒（§12）：watcher 在跳档/升频轮上报 five_h/weekly 的 used_percent，云端据此推 🔶
// （仅会话期间有数据，文案注明）；周打满闸门压制 5h 档位。
async function applySyncCodex(p) {
  const { five_h, weekly, raw } = p;
  if (weekly?.reset_at) {
    ps.weekly_next = weekly.reset_at;
    console.log(`sync(codex): weekly_next -> ${weekly.reset_at}`);
    changed = true;
  }
  if (raw) console.log(`sync(codex): raw usage = ${JSON.stringify(raw)}`);
  const pctOf = (w) => (num(w?.used_percent) !== null ? w.used_percent : null);
  await evalTierAlert('weekly', pctOf(weekly), '',
    ps.weekly_next || weekly?.reset_at || null);
  await evalTierAlert('5h', pctOf(five_h), '',
    ps.five_h_anchor || five_h?.reset_at || null);
}

// WorkBuddy 同步（collection §9.3/§9.4，workbuddy-watcher 驱动）：scheduledMonthly 平台的
// quota-sync。account_type 门控（方案 B）：
//   · enterprise：monthly.reset_at 是 API 实测的下个周期重置时刻，比用户手填锚点权威——
//     与 monthly_next 偏离 >5s（或无锚点）→ anchor 换源为该时刻，monthly_next 重算
//     （对标 applySyncCodex 的纠偏，watcher 侧同用 5s 容差双向对齐，稳态互不打扰）
//   · personal：无统一重置时间（各资源包独立过期），reset_at 仅随快照落日志观察，
//     绝不用它动用户手填的锚点（collection §9.4）
//   共用：used/limit 落 state（供 tick 重置文案与打满判定）；used>=limit 置 monthly_exhausted
//   并推一次「月额度已用完」（打满去重：已置位不重复推）；未打满回落则清标志
//   档位提醒（§12）：monthly_alert 阶梯去重推 🔶；打满镜像 100；回落重武装（§12.2-5）——
//   清闸门的同时把 monthly_alert 重设为「≤ 当前 pct 的最高档」（直接清 0 会导致已推过的
//   低档位立刻重推）
async function applySyncWorkbuddy(p) {
  const { monthly, raw } = p;
  const isEnterprise = String(p.account_type || '').toLowerCase() === 'enterprise';
  if (isEnterprise && monthly?.reset_at && !Number.isNaN(Date.parse(monthly.reset_at))) {
    const want = new Date(Date.parse(monthly.reset_at)).toISOString();
    const cur = ps.monthly_next ? Date.parse(ps.monthly_next) : null;
    if (cur === null || Math.abs(cur - Date.parse(want)) > SYNC_TOLERANCE) {
      ps.monthly_anchor = want;
      // monthly_next 直接用上报值（want 通常就是近未来的重置点）；不套 nextMonthlyReset，
      // 避免 want 日号在当前月不存在时（如 3/31 vs 2 月）被钳到月末、与 API 值偏离整月
      ps.monthly_next = want;
      console.log(
        `sync(workbuddy): monthly calibrated by API reset_at -> ` +
        `anchor ${ps.monthly_anchor}, monthly_next ${ps.monthly_next}`
      );
      changed = true;
    } else {
      console.log(`sync(workbuddy): monthly_next already aligned (${ps.monthly_next}), skip`);
    }
  } else if (monthly?.reset_at && !isEnterprise) {
    console.log(`sync(workbuddy): ${p.account_type || 'personal'} account, reset_at observe-only (no anchor calibration)`);
  }
  if (num(monthly?.used) !== null) ps.monthly_used = Math.round(monthly.used); // int 存储（credits 展示不需要小数）
  if (num(monthly?.limit) !== null) ps.monthly_limit = Math.round(monthly.limit);
  // 打满判定用上报的原始值（四舍五入前先比，避免 99.6→100 提前误报）
  if (num(monthly?.used) !== null && num(monthly?.limit) > 0) {
    if (monthly.used >= monthly.limit) {
      if (!ps.monthly_exhausted) {
        ps.monthly_exhausted = true;
        newlyExhausted.push('monthly');
        console.log('sync(workbuddy): monthly exhausted (by watcher usage), flag set');
      }
      mirrorAlertExhausted('monthly');
    } else if (ps.monthly_exhausted) {
      // 打满后额度恢复（新资源包到账等），重置前提前解除闸门
      ps.monthly_exhausted = false;
      // 回落重武装（§12.2-5）：alert 重设为 ≤ 当前 pct 的最高档，高档位重新可推
      const pct = (monthly.used / monthly.limit) * 100;
      const thresholds = PLATFORMS.workbuddy.alerts.monthly;
      ps.monthly_alert = thresholds.filter((t) => pct >= t).pop() || 0;
      console.log(
        `sync(workbuddy): monthly recovered before reset, flag cleared, alert re-armed -> ${ps.monthly_alert}`
      );
    }
  }
  if (raw) console.log(`sync(workbuddy): raw usage = ${JSON.stringify(raw)}`);
  await evalTierAlert('monthly',
    num(monthly?.used) !== null && num(monthly?.limit) > 0 ? (monthly.used / monthly.limit) * 100 : null,
    monthly ? `${Math.round(monthly.used)}/${Math.round(monthly.limit)}` : '',
    ps.monthly_next);
  ps.last_sync = nowIso;
  changed = true;
}

// ---- quota-close：关闭时的额度快照推送 ----
// Kimi 发送条件（用户规则）：5h 有剩余 或 周有剩余 或 月未用完；三层全空则静默。
// 重置时间取「真正恢复可用」的时间，层级 月 > 周 > 5h：
// 月打满 → 月重置；否则周打满 → 周重置；否则 5h 打满 → 5h 边界。
async function pushCloseSummaryKimi(p) {
  const fh = p.five_h;
  const wk = p.weekly;
  const fhRem = fh && num(fh.limit) > 0 ? Math.max(0, fh.limit - fh.used) : null;
  const wkRem = wk && num(wk.limit) > 0 ? Math.max(0, wk.limit - wk.used) : null;
  const monthlyActive = !!ps.monthly_exhausted_until;

  if (!((fhRem ?? 0) > 0 || (wkRem ?? 0) > 0 || !monthlyActive)) {
    console.log('quota-close: all tiers exhausted (monthly active, 5h/weekly empty), no push');
    return;
  }

  const tierLine = (name, w, rem) => {
    if (!w || !(num(w.limit) > 0)) return `${name}：数据不可用`;
    const out = w.used >= w.limit;
    const pct = Math.round((rem / w.limit) * 100);
    const status = out ? '已用完' : `剩余 ${pct}%（${rem}/${w.limit}）`;
    return `${name}：${status}，重置 ${fmt(w.reset_at)}`;
  };

  const lines = [
    tierLine('5 小时额度', fh, fhRem),
    tierLine('周额度', wk, wkRem),
    monthlyActive
      ? `月额度：已用完，${fmt(ps.monthly_exhausted_until)} 重置（期间其余额度不可用）`
      : ps.monthly_anchor
        ? `月额度：正常，下次重置 ${fmt(nextMonthlyReset(ps.monthly_anchor, Date.now()))}`
        : '月额度：正常',
  ];

  const fhOut = fh && num(fh.limit) > 0 && fh.used >= fh.limit;
  const wkOut = wk && num(wk.limit) > 0 && wk.used >= wk.limit;
  if (monthlyActive) {
    lines.push(`最早恢复可用：${fmt(ps.monthly_exhausted_until)}（月额度重置）`);
  } else if (wkOut) {
    lines.push(`最早恢复可用：${fmt(wk.reset_at || ps.weekly_next)}（周额度重置）`);
  } else if (fhOut) {
    lines.push(`最早恢复可用：${fmt(fh.reset_at || ps.five_h_anchor)}（5 小时额度重置）`);
  } else {
    lines.push('三层额度均可用，无需等待重置。');
  }

  await pushAll({
    title: '📴 Kimi Code 已关闭 · 额度快照',
    body: lines.join('\n'),
    level: 'passive', // 只进通知列表，不亮屏
    ttl: 86400, // Bark 历史记录保存 1 天
    platform: label,
  });
}

// 非 Kimi 平台的关闭快照：无用量接口数据，按 state 出状态行（passive）
async function pushCloseSummaryGeneric() {
  const lines = [];
  if (PLATFORMS[platform].tiers.includes('5h')) {
    lines.push(ps.five_h_anchor
      ? `5 小时窗口：${ps.five_h_exhausted ? '已用完' : '进行中'}，${fmt(ps.five_h_anchor)} 重置`
      : '5 小时窗口：未开启（下次会话开始时计时）');
  }
  if (PLATFORMS[platform].tiers.includes('weekly')) {
    lines.push(`周额度：${ps.weekly_exhausted ? '已用完' : '正常'}，下次重置 ${fmt(ps.weekly_next)}`);
  }
  if (PLATFORMS[platform].tiers.includes('monthly')) {
    // workbuddy：state 已有真实用量（watcher 上报），带上百分比
    const usage =
      Number.isFinite(ps.monthly_used) && Number.isFinite(ps.monthly_limit) && ps.monthly_limit > 0
        ? `，用量 ${Math.round((ps.monthly_used / ps.monthly_limit) * 100)}%（${ps.monthly_used}/${ps.monthly_limit}）`
        : '';
    const state_ = ps.monthly_exhausted ? '已用完' : '正常';
    lines.push(`月额度：${state_}${usage}，下次重置 ${fmt(ps.monthly_next)}`);
  }
  // workbuddy 的 close 是 watcher 每日快照（非应用退出），标题不说「已关闭」
  const title = platform === 'workbuddy'
    ? `📴 ${label} 额度快照`
    : `📴 ${label} 已关闭 · 额度快照`;
  await pushAll({
    title,
    body: lines.join('\n'),
    level: 'passive',
    ttl: 86400,
    platform: label,
  });
}

// Codex 关闭快照：watcher 在 Codex 退出时上报最后一条会话日志快照，带真实百分比。
// 云端先 applySyncCodex（周校准）再出 passive 摘要（用量不落 state，只渲染）。
async function pushCloseSummaryCodex(p) {
  const fhPct = num(p.five_h?.used_percent);
  const wkPct = num(p.weekly?.used_percent);
  const lines = [
    ps.five_h_anchor
      ? `5 小时窗口：${ps.five_h_exhausted ? '已用完' : '进行中'}` +
        (fhPct !== null ? `，用量 ${Math.round(fhPct)}%` : '') +
        `，${fmt(p.five_h?.reset_at || ps.five_h_anchor)} 结束`
      : '5 小时窗口：未开启（下次会话开始时计时）',
    `周额度：${ps.weekly_exhausted ? '已用完' : '正常'}` +
      (wkPct !== null ? `，用量 ${Math.round(wkPct)}%` : '') +
      `，下次重置 ${fmt(p.weekly?.reset_at || ps.weekly_next)}`,
  ];
  await pushAll({
    title: `📴 ${label} 已关闭 · 额度快照`,
    body: lines.join('\n'),
    level: 'passive',
    ttl: 86400,
    platform: label,
  });
}

// ---- Codex 滑动锚点（MP 方案 §4）：session-activity 驱动 5h 窗口 ----
function applySessionActivity() {
  const t = Date.parse(payload.activity_at);
  if (Number.isNaN(t)) throw new Error(`session-activity: invalid activity_at "${payload.activity_at}"`);
  const activityIso = new Date(t).toISOString();
  if (!ps.five_h_anchor || t >= Date.parse(ps.five_h_anchor)) {
    // 窗口不存在或已结束 → 开新窗口
    ps.five_h_anchor = new Date(t + FIVE_H).toISOString();
    ps.five_h_exhausted = false;
    ps.five_h_alert = 0; // 新窗口档位重武装（与 exhausted 镜像保持一致）
    ps.last_activity_at = activityIso;
    console.log('codex: new 5h window opened');
  } else {
    // 窗口进行中 → anchor 不动
    ps.last_activity_at = activityIso;
    console.log('codex: window in progress, anchor kept');
  }
  changed = true;
}

// ---- quota-exhausted：按 tier 置标志（打满去重：已置位则不重复推送） ----
async function applyExhausted() {
  const tier = payload.tier;
  if (tier === '5h') {
    if (!PLATFORMS[platform].tiers.includes('5h')) {
      console.log(`exhausted: platform ${platform} has no 5h tier, payload ignored`);
      return;
    }
    // TODO(V1 待验证)：Codex 限流错误若自带重试时间，hook 解析后随信号上报 reset_at，
    // 云端优先采用，覆盖滑动锚点的推算值。本分支已支持该字段，格式待首次打满落盘确认。
    if (platform === 'codex' && payload.reset_at && !Number.isNaN(Date.parse(payload.reset_at))) {
      ps.five_h_anchor = new Date(Date.parse(payload.reset_at)).toISOString();
      console.log(`codex: reset_at reported by hook, anchor overridden -> ${ps.five_h_anchor}`);
    }
    if (!ps.five_h_exhausted) {
      ps.five_h_exhausted = true;
      mirrorAlertExhausted('5h');
      await notifyExhausted('5h');
    } else {
      console.log('exhausted: 5h flag already set, no duplicate push');
    }
    console.log('exhausted: 5h flag set');
    changed = true;
  } else if (tier === 'weekly') {
    if (!PLATFORMS[platform].tiers.includes('weekly')) {
      console.log(`exhausted: platform ${platform} has no weekly tier, payload ignored`);
      return;
    }
    if (!ps.weekly_exhausted) {
      ps.weekly_exhausted = true;
      mirrorAlertExhausted('weekly');
      await notifyExhausted('weekly');
    } else {
      console.log('exhausted: weekly flag already set, no duplicate push');
    }
    console.log('exhausted: weekly flag set');
    changed = true;
  } else if (tier === 'monthly') {
    if (!PLATFORMS[platform].tiers.includes('monthly') || PLATFORMS[platform].scheduledMonthly) {
      console.log(`exhausted: platform ${platform} has no monthly exhausted signal, payload ignored`);
      return;
    }
    const wasActive = !!ps.monthly_exhausted_until;
    ps.monthly_signal_at = nowIso;
    if (ps.monthly_anchor) {
      ps.monthly_exhausted_until = nextMonthlyReset(ps.monthly_anchor, Date.now());
      console.log(`exhausted: monthly, until auto-computed from anchor -> ${ps.monthly_exhausted_until}`);
    } else {
      // 无锚点时的兜底：只能手动填（manual workflow 的 monthly_cap / set_monthly_anchor）
      console.log('exhausted: monthly signal recorded; no monthly_anchor, set it via the manual workflow');
    }
    if (!wasActive) await notifyExhausted('monthly');
    changed = true;
  } else {
    console.log(`exhausted: unknown tier "${tier}", payload ignored`);
  }
}

if (eventType === 'quota-sync') {
  if (platform === 'kimi') {
    await applySyncKimi(payload);
    // StopFailure 漏报、由同步兜底发现的打满：补发「额度用光」提醒
    for (const t of newlyExhausted) await notifyExhausted(t);
  } else if (platform === 'codex') {
    await applySyncCodex(payload);
  } else if (platform === 'workbuddy') {
    await applySyncWorkbuddy(payload);
    // watcher 用量兜底发现的打满：补发「额度用光」提醒（同 kimi 的 StopFailure 漏报兜底）
    for (const t of newlyExhausted) await notifyExhausted(t);
  } else {
    console.log(`quota-sync: platform ${platform} has nothing to sync, ignored`);
  }
} else if (eventType === 'quota-close') {
  if (platform === 'kimi') {
    await applySyncKimi(payload);
    // 关闭快照已包含各层状态，不再单独发打满提醒
    await pushCloseSummaryKimi(payload);
  } else if (platform === 'codex') {
    // watcher 在 Codex 退出时触发：payload 带最后快照，先校准周锚点再出摘要
    await applySyncCodex(payload);
    await pushCloseSummaryCodex(payload);
  } else if (platform === 'workbuddy') {
    // watcher 每日 23 点触发：payload 带当月用量，先同步 state 再出摘要
    await applySyncWorkbuddy(payload);
    for (const t of newlyExhausted) await notifyExhausted(t);
    await pushCloseSummaryGeneric();
  } else {
    await pushCloseSummaryGeneric();
  }
} else if (eventType === 'quota-exhausted') {
  await applyExhausted();
} else if (eventType === 'session-activity') {
  if (platform === 'codex') {
    applySessionActivity();
  } else {
    console.log(`session-activity: only codex uses sliding anchors, platform=${platform} ignored`);
  }
} else {
  console.log(`unknown event_type "${eventType}", ignored`);
}

if (changed) {
  saveState(state);
  console.log('state updated');
} else {
  console.log('no state change');
}
