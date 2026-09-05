// signal：repository_dispatch 触发，处理本机 hook 发来的两类信号。
//   quota-sync       SessionStart 同步：校准时刻表、更新用量、兜底补置 exhausted 标志
//   quota-exhausted  StopFailure 打满：按 tier 置标志
import fs from 'node:fs';

const STATE_FILE = 'state.json';
const FIVE_H = 5 * 3600 * 1000;
const ALIGN_TOLERANCE = 2 * 60 * 1000; // anchor 校准容差：2 分钟

const eventType = process.env.EVENT_ACTION; // repository_dispatch 的 event_type
const payload = JSON.parse(process.env.CLIENT_PAYLOAD || '{}');

const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
const nowIso = new Date().toISOString();
let changed = false;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

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

if (eventType === 'quota-sync') {
  const { five_h, weekly, monthly, raw } = payload;

  if (weekly?.reset_at) {
    state.weekly_next = weekly.reset_at;
    changed = true;
  }
  if (num(weekly?.used) !== null) state.weekly_used = weekly.used;
  if (num(weekly?.limit) !== null) state.weekly_limit = weekly.limit;
  if (num(weekly?.used) !== null && num(weekly?.limit) > 0 && weekly.used >= weekly.limit) {
    if (!state.weekly_exhausted) console.log('sync: weekly exhausted (missed by StopFailure hook), flag set');
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
    if (!state.five_h_exhausted) console.log('sync: 5h exhausted (missed by StopFailure hook), flag set');
    state.five_h_exhausted = true;
  }

  // 月窗口升级路径（方案 §7）：若用量接口开始出现月窗口，自动接管
  if (monthly?.reset_at) {
    console.log(`sync: monthly window present in API: ${JSON.stringify(monthly)}`);
    if (num(monthly?.used) !== null && num(monthly?.limit) > 0 && monthly.used >= monthly.limit) {
      state.monthly_exhausted_until = monthly.reset_at;
      console.log('sync: monthly exhausted, until set automatically');
    }
  }
  if (raw) console.log(`sync: raw usage = ${JSON.stringify(raw)}`);

  state.last_sync = nowIso;
  changed = true;
} else if (eventType === 'quota-exhausted') {
  const tier = payload.tier;
  if (tier === '5h') {
    state.five_h_exhausted = true;
    console.log('exhausted: 5h flag set');
    changed = true;
  } else if (tier === 'weekly') {
    state.weekly_exhausted = true;
    console.log('exhausted: weekly flag set');
    changed = true;
  } else if (tier === 'monthly') {
    state.monthly_signal_at = nowIso;
    if (state.monthly_anchor) {
      state.monthly_exhausted_until = nextMonthlyReset(state.monthly_anchor, Date.now());
      console.log(`exhausted: monthly, until auto-computed from anchor -> ${state.monthly_exhausted_until}`);
    } else {
      // 无锚点时的兜底：只能手动填（manual workflow 的 monthly_cap / set_monthly_anchor）
      console.log('exhausted: monthly signal recorded; no monthly_anchor, set it via the manual workflow');
    }
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
