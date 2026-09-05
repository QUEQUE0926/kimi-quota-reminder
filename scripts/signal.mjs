// signal：repository_dispatch 触发，处理本机 hook 发来的三类信号。
//   quota-sync       SessionStart 同步：校准时刻表、更新用量、兜底补置 exhausted 标志
//   quota-exhausted  StopFailure 打满：按 tier 置标志（monthly 按锚点自动算 until）
//   quota-close      SessionEnd 关闭：同步状态后按规则推送额度快照
import fs from 'node:fs';
import { pushAll } from './push.mjs';

const STATE_FILE = 'state.json';
const FIVE_H = 5 * 3600 * 1000;
const ALIGN_TOLERANCE = 2 * 60 * 1000; // anchor 校准容差：2 分钟
const TZ = 'Asia/Shanghai';

const eventType = process.env.EVENT_ACTION; // repository_dispatch 的 event_type
const payload = JSON.parse(process.env.CLIENT_PAYLOAD || '{}');

const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
const nowIso = new Date().toISOString();
let changed = false;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const fmt = (iso) =>
  iso ? new Date(iso).toLocaleString('zh-CN', { timeZone: TZ, hour12: false }) : '未知';

const TIER_NAMES = { '5h': '5 小时额度', weekly: '周额度', monthly: '月额度' };
const newlyExhausted = []; // 本次运行中新置位的打满层级（用于「额度用光」active 提醒）

// 「额度用光」提醒：仅在某层新打满时推一次（active 级别）
async function notifyExhausted(tier) {
  const when =
    tier === '5h' ? state.five_h_anchor
    : tier === 'weekly' ? state.weekly_next
    : state.monthly_exhausted_until;
  const body = when
    ? `预计 ${fmt(when)} 重置。` +
      (tier === 'monthly' ? '月额度重置前，5 小时 / 周额度即使到点重置也不可用。' : '')
    : '重置时间未知。';
  await pushAll({ title: `⚠️ ${TIER_NAMES[tier]}已用完`, body });
}

// 由订阅锚点递推月重置：同一日期数字、同一时刻，逐月推进（日期不存在时钳到月末）
function nextMonthlyReset(anchorIso, afterMs) {
  const a = new Date(anchorIso);
  const day = a.getUTCDate();
  const after = new Date(afterMs);
  let y = after.getUTCFullYear();
  let m = after.getUTCMonth();
  for (let i = 0; i < 36; i++) {
    const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const t = Date.UTC(y, m, Math.min(day, dim),
      a.getUTCHours(), a.getUTCMinutes(), a.getUTCSeconds(), a.getUTCMilliseconds());
    if (t > afterMs) return new Date(t).toISOString();
    m += 1;
    if (m > 11) { m = 0; y += 1; }
  }
  throw new Error('nextMonthlyReset: no boundary found within 36 months');
}

// quota-sync / quota-close 共用的状态同步
function applySync(p) {
  const { five_h, weekly, monthly, raw } = p;

  if (weekly?.reset_at) {
    state.weekly_next = weekly.reset_at;
    changed = true;
  }
  if (num(weekly?.used) !== null) state.weekly_used = weekly.used;
  if (num(weekly?.limit) !== null) state.weekly_limit = weekly.limit;
  if (num(weekly?.used) !== null && num(weekly?.limit) > 0 && weekly.used >= weekly.limit) {
    if (!state.weekly_exhausted) {
      console.log('sync: weekly exhausted (missed by StopFailure hook), flag set');
      newlyExhausted.push('weekly');
    }
    state.weekly_exhausted = true;
  }

  if (five_h?.reset_at) {
    const resetMs = Date.parse(five_h.reset_at);
    const old = state.five_h_anchor ? Date.parse(state.five_h_anchor) : null;
    if (old === null) {
      state.five_h_anchor = five_h.reset_at;
      console.log(`sync: anchor initialized -> ${five_h.reset_at}`);
    } else {
      // 校准：上报的 reset_at 应落在 anchor + 5h·k 上，偏差超阈值则纠正 anchor
      const diff = Math.abs(resetMs - old) % FIVE_H;
      const misalign = Math.min(diff, FIVE_H - diff);
      if (misalign > ALIGN_TOLERANCE) {
        console.log(`sync: anchor corrected ${state.five_h_anchor} -> ${five_h.reset_at} (misalign ${(misalign / 1000).toFixed(0)}s)`);
        state.five_h_anchor = five_h.reset_at;
      }
    }
    changed = true;
  }
  if (num(five_h?.used) !== null) state.five_h_used = five_h.used;
  if (num(five_h?.limit) !== null) state.five_h_limit = five_h.limit;
  if (num(five_h?.used) !== null && num(five_h?.limit) > 0 && five_h.used >= five_h.limit) {
    if (!state.five_h_exhausted) {
      console.log('sync: 5h exhausted (missed by StopFailure hook), flag set');
      newlyExhausted.push('5h');
    }
    state.five_h_exhausted = true;
  }

  // 月窗口升级路径（方案 §7）：若用量接口开始出现月窗口，自动接管
  if (monthly?.reset_at) {
    console.log(`sync: monthly window present in API: ${JSON.stringify(monthly)}`);
    if (num(monthly?.used) !== null && num(monthly?.limit) > 0 && monthly.used >= monthly.limit) {
      if (!state.monthly_exhausted_until) newlyExhausted.push('monthly');
      state.monthly_exhausted_until = monthly.reset_at;
      console.log('sync: monthly exhausted, until set automatically');
    }
  }
  if (raw) console.log(`sync: raw usage = ${JSON.stringify(raw)}`);

  state.last_sync = nowIso;
  changed = true;
}

// quota-close：关闭时的额度快照推送。
// 发送条件（用户规则）：5h 有剩余 或 周有剩余 或 月未用完；三层全空则静默。
// 重置时间取「真正恢复可用」的时间，层级 月 > 周 > 5h：
// 月打满 → 月重置；否则周打满 → 周重置；否则 5h 打满 → 5h 边界。
async function pushCloseSummary(p) {
  const fh = p.five_h;
  const wk = p.weekly;
  const fhRem = fh && num(fh.limit) > 0 ? Math.max(0, fh.limit - fh.used) : null;
  const wkRem = wk && num(wk.limit) > 0 ? Math.max(0, wk.limit - wk.used) : null;
  const monthlyActive = !!state.monthly_exhausted_until;

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
      ? `月额度：已用完，${fmt(state.monthly_exhausted_until)} 重置（期间其余额度不可用）`
      : state.monthly_anchor
        ? `月额度：正常，下次重置 ${fmt(nextMonthlyReset(state.monthly_anchor, Date.now()))}`
        : '月额度：正常',
  ];

  const fhOut = fh && num(fh.limit) > 0 && fh.used >= fh.limit;
  const wkOut = wk && num(wk.limit) > 0 && wk.used >= wk.limit;
  if (monthlyActive) {
    lines.push(`最早恢复可用：${fmt(state.monthly_exhausted_until)}（月额度重置）`);
  } else if (wkOut) {
    lines.push(`最早恢复可用：${fmt(wk.reset_at || state.weekly_next)}（周额度重置）`);
  } else if (fhOut) {
    lines.push(`最早恢复可用：${fmt(fh.reset_at || state.five_h_anchor)}（5 小时额度重置）`);
  } else {
    lines.push('三层额度均可用，无需等待重置。');
  }

  await pushAll({
    title: '📴 Kimi Code 已关闭 · 额度快照',
    body: lines.join('\n'),
    level: 'passive', // 只进通知列表，不亮屏
    ttl: 86400, // Bark 历史记录保存 1 天
  });
}

if (eventType === 'quota-sync') {
  applySync(payload);
  // StopFailure 漏报、由同步兜底发现的打满：补发「额度用光」提醒
  for (const t of newlyExhausted) await notifyExhausted(t);
} else if (eventType === 'quota-close') {
  applySync(payload);
  // 关闭快照已包含各层状态，不再单独发打满提醒
  await pushCloseSummary(payload);
} else if (eventType === 'quota-exhausted') {
  const tier = payload.tier;
  if (tier === '5h') {
    if (!state.five_h_exhausted) {
      state.five_h_exhausted = true;
      await notifyExhausted('5h');
    } else {
      console.log('exhausted: 5h flag already set, no duplicate push');
    }
    console.log('exhausted: 5h flag set');
    changed = true;
  } else if (tier === 'weekly') {
    if (!state.weekly_exhausted) {
      state.weekly_exhausted = true;
      await notifyExhausted('weekly');
    } else {
      console.log('exhausted: weekly flag already set, no duplicate push');
    }
    console.log('exhausted: weekly flag set');
    changed = true;
  } else if (tier === 'monthly') {
    const wasActive = !!state.monthly_exhausted_until;
    state.monthly_signal_at = nowIso;
    if (state.monthly_anchor) {
      state.monthly_exhausted_until = nextMonthlyReset(state.monthly_anchor, Date.now());
      console.log(`exhausted: monthly, until auto-computed from anchor -> ${state.monthly_exhausted_until}`);
    } else {
      // 无锚点时的兜底：只能手动填（manual workflow 的 monthly_cap / set_monthly_anchor）
      console.log('exhausted: monthly signal recorded; no monthly_anchor, set it via the manual workflow');
    }
    if (!wasActive) await notifyExhausted('monthly');
    changed = true;
  } else {
    console.log(`exhausted: unknown tier "${tier}", payload ignored`);
  }
} else {
  console.log(`unknown event_type "${eventType}", ignored`);
}

if (changed) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
  console.log('state updated');
} else {
  console.log('no state change');
}
