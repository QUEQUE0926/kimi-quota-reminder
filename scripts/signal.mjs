// signal：repository_dispatch 触发，处理本机 hook 发来的信号。
//   quota-sync       SessionStart 同步：校准时刻表、更新用量、兜底补置 exhausted 标志
//   quota-exhausted  StopFailure 打满：按 tier 置标志（monthly 按锚点自动算 until）
//   quota-close      SessionEnd 关闭：同步状态后按规则推送额度快照
//   session-activity Codex 专用：滑动锚点开窗（MP 方案 §4）
// 多平台（MP 方案 §3）：payload 可带 platform 字段，缺省 = kimi（旧 hook 零改动兼容）。
import { pushAll } from './push.mjs';
import {
  PLATFORMS, TIER_NAMES, FIVE_H, fmt, nextMonthlyReset,
  loadState, saveState, ensurePlatform,
} from './platforms.mjs';

const ALIGN_TOLERANCE = 2 * 60 * 1000; // anchor 校准容差：2 分钟

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
  const when =
    tier === '5h' ? ps.five_h_anchor
    : tier === 'weekly' ? ps.weekly_next
    : ps.monthly_exhausted_until;
  const body = when
    ? `预计 ${fmt(when)} 重置。` +
      (tier === 'monthly' ? '月额度重置前，5 小时 / 周额度即使到点重置也不可用。' : '')
    : '重置时间未知。';
  const ttl = when ? Math.max(60, Math.round((Date.parse(when) - Date.now()) / 1000)) : undefined;
  await pushAll({ title: `⚠️ ${label} ${TIER_NAMES[tier]}已用完`, body, ttl, platform: label });
}

// ---- Kimi：quota-sync / quota-close 共用的状态同步（行为与单平台版完全一致） ----
function applySyncKimi(p) {
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

  ps.last_sync = nowIso;
  changed = true;
}

// Codex 同步：滑动锚点平台不做 5h 时刻表校准；仅接收周重置时间（用量字段不落盘，只记日志）
function applySyncCodex(p) {
  const { weekly, raw } = p;
  if (weekly?.reset_at) {
    ps.weekly_next = weekly.reset_at;
    console.log(`sync(codex): weekly_next -> ${weekly.reset_at}`);
    changed = true;
  }
  if (raw) console.log(`sync(codex): raw usage = ${JSON.stringify(raw)}`);
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
    lines.push(`月额度：下次重置 ${fmt(ps.monthly_next)}`);
  }
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
    applySyncKimi(payload);
    // StopFailure 漏报、由同步兜底发现的打满：补发「额度用光」提醒
    for (const t of newlyExhausted) await notifyExhausted(t);
  } else if (platform === 'codex') {
    applySyncCodex(payload);
  } else {
    console.log(`quota-sync: platform ${platform} has nothing to sync, ignored`);
  }
} else if (eventType === 'quota-close') {
  if (platform === 'kimi') {
    applySyncKimi(payload);
    // 关闭快照已包含各层状态，不再单独发打满提醒
    await pushCloseSummaryKimi(payload);
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
