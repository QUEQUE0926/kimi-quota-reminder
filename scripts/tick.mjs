// tick：每 5 分钟由 cron 触发，按方案 §4 / MP 方案 §4-5 逐平台独立评估时刻表边界并推送。
// 单次运行可产出多条推送（每平台至多每类边界一条）。
import fs from 'node:fs';
import { pushAll } from './push.mjs';
import {
  PLATFORMS, FIVE_H, WEEK, fmt, nextMonthlyReset,
  loadState, saveState,
} from './platforms.mjs';

const HEARTBEAT_FILE = 'heartbeat.txt';

const { state, changed: migrated } = loadState();
const now = Date.now();
let changed = migrated;
const messages = [];

// 纯层级闸门（方案 §4 修订版）：不看用量百分比。只要周/月未耗尽，跨边界一律推。
// 用量数字仅保留在 ℹ️ 文案里做信息展示。打满过用 ✅，否则 ℹ️。
const usagePct = (used, limit) => (limit > 0 ? used / limit : 0);
const pctText = (used, limit) => `${Math.round(usagePct(used, limit) * 100)}%（${used}/${limit}）`;

// ---- Kimi：固定时刻表，三层，月 > 周 > 5h 层级闸门（行为与单平台版完全一致） ----
function tickKimi(ps, label) {
  // 月层
  if (ps.monthly_exhausted_until) {
    const until = Date.parse(ps.monthly_exhausted_until);
    if (now >= until) {
      messages.push({
        title: '✅ Kimi Code 月额度已重置',
        body: `月额度已刷新（${fmt(now)}），5 小时 / 周 / 月全部恢复可用。`,
        ttl: 86400,
        platform: label,
      });
      ps.monthly_exhausted_until = null;
      ps.monthly_signal_at = null;
      ps.five_h_exhausted = false;
      ps.weekly_exhausted = false;
      changed = true;
    }
  }
  const monthlyActive = !!ps.monthly_exhausted_until;

  // 5 小时层：跨过 anchor + 5h·k 边界
  if (ps.five_h_anchor) {
    const anchor = Date.parse(ps.five_h_anchor);
    if (now >= anchor) {
      const k = Math.floor((now - anchor) / FIVE_H) + 1;
      const next = anchor + k * FIVE_H; // 下一个未来边界
      const wasOut = ps.five_h_exhausted;
      if (!ps.weekly_exhausted && !monthlyActive) {
        messages.push({
          title: wasOut ? '✅ Kimi Code 5小时额度已重置' : 'ℹ️ Kimi Code 5小时额度已重置',
          body: wasOut
            ? `5 小时窗口已在 ${fmt(next - FIVE_H)} 刷新（上周期已打满），下个边界 ${fmt(next)}。`
            : `5 小时窗口已在 ${fmt(next - FIVE_H)} 刷新，下个边界 ${fmt(next)}。上周期用量 ${pctText(ps.five_h_used, ps.five_h_limit)}，未打满（以 console 为准）。`,
          ttl: 86400,
          platform: label,
        });
      }
      if (ps.five_h_exhausted) ps.five_h_exhausted = false;
      ps.five_h_anchor = new Date(next).toISOString();
      changed = true;
    }
  }

  // 周层
  if (ps.weekly_next) {
    let wn = Date.parse(ps.weekly_next);
    if (now >= wn) {
      const wasOut = ps.weekly_exhausted;
      if (!monthlyActive) {
        messages.push({
          title: wasOut ? '✅ Kimi Code 周额度已重置' : 'ℹ️ Kimi Code 周额度已重置',
          body: wasOut
            ? `周额度已在 ${fmt(wn)} 刷新（上周期已打满），5 小时窗口同步恢复。`
            : `周额度已在 ${fmt(wn)} 刷新，5 小时窗口同步恢复。上周期用量 ${pctText(ps.weekly_used, ps.weekly_limit)}，未打满。`,
          ttl: 86400,
          platform: label,
        });
      }
      while (wn <= now) wn += WEEK;
      ps.weekly_next = new Date(wn).toISOString();
      ps.weekly_exhausted = false;
      ps.five_h_exhausted = false; // 周重置后 5h 必然也是满的
      changed = true;
    }
  }
}

// ---- Codex（MP 方案 §4）：滑动锚点 5h + 固定时刻表周层；无月层，闸门只判周 ----
function tickCodex(ps, label) {
  // 5 小时层：跨过窗口结束时刻（anchor）后推重置提醒，anchor 置回 null 不递推——
  // 下一个窗口等下一次 session-activity 来开，这是和 Kimi 时刻表自动 +5h 的本质区别。
  if (ps.five_h_anchor) {
    const anchor = Date.parse(ps.five_h_anchor);
    if (now >= anchor) {
      const wasOut = ps.five_h_exhausted;
      if (!ps.weekly_exhausted) {
        messages.push({
          title: wasOut ? '✅ Codex 5 小时窗口已可用' : 'ℹ️ Codex 5 小时窗口已可用',
          body: wasOut
            ? `上周期已打满；下次会话将开启新的 5 小时窗口。`
            : `上周期未打满；下次会话将开启新的 5 小时窗口。`,
          ttl: 86400,
          platform: label,
        });
      } else {
        console.log('codex: 5h boundary crossed but weekly exhausted, push suppressed (层级闸门)');
      }
      ps.five_h_exhausted = false;
      ps.five_h_anchor = null;
      changed = true;
    }
  }

  // 周层：固定时刻表 +7d 递推，周重置连带清 5h 打满标志
  if (ps.weekly_next) {
    let wn = Date.parse(ps.weekly_next);
    if (now >= wn) {
      const wasOut = ps.weekly_exhausted;
      messages.push({
        title: wasOut ? '✅ Codex 周额度已重置' : 'ℹ️ Codex 周额度已重置',
        body: wasOut
          ? `周额度已在 ${fmt(wn)} 刷新（上周期已打满），5 小时窗口同步恢复。`
          : `周额度已在 ${fmt(wn)} 刷新，5 小时窗口同步恢复。上周期未打满。`,
        ttl: 86400,
        platform: label,
      });
      while (wn <= now) wn += WEEK;
      ps.weekly_next = new Date(wn).toISOString();
      ps.weekly_exhausted = false;
      ps.five_h_exhausted = false;
      changed = true;
    }
  }
}

// ---- WorkBuddy（MP 方案 §5）：纯月层，monthly_next 按日历月递推，无闸门 ----
function tickWorkbuddy(ps, label) {
  if (!ps.monthly_next) {
    if (ps.monthly_anchor) {
      ps.monthly_next = nextMonthlyReset(ps.monthly_anchor, now);
      console.log(`workbuddy: monthly_next derived from anchor -> ${ps.monthly_next}`);
      changed = true;
    } else {
      console.log('workbuddy: no anchor, skipped');
      return;
    }
  }
  const mn = Date.parse(ps.monthly_next);
  if (now >= mn) {
    // 按日历月递推到下一个未来时刻（保留时刻，非 30 天近似）
    const next = nextMonthlyReset(ps.monthly_anchor || ps.monthly_next, now);
    const wasOut = ps.monthly_exhausted;
    const usage =
      Number.isFinite(ps.monthly_used) && Number.isFinite(ps.monthly_limit) && ps.monthly_limit > 0
        ? `上周期用量 ${pctText(ps.monthly_used, ps.monthly_limit)}${wasOut ? '' : '，未打满'}。`
        : '';
    messages.push({
      title: '✅ WorkBuddy 月额度已重置',
      body: `月额度已在 ${fmt(mn)} 刷新，下次重置 ${fmt(next)}。${usage}`,
      ttl: 86400,
      platform: label,
    });
    ps.monthly_next = next;
    ps.monthly_exhausted = false; // 月重置连带清打满闸门
    changed = true;
  }
}

const TICKERS = { kimi: tickKimi, codex: tickCodex, workbuddy: tickWorkbuddy };

for (const [name, ps] of Object.entries(state.platforms || {})) {
  const meta = PLATFORMS[name];
  const ticker = TICKERS[name];
  if (!meta || !ticker) {
    console.log(`${name}: no ticker registered, skipped`);
    continue;
  }
  ticker(ps, meta.label);
}

// ---- 推送 ----
for (const m of messages) {
  console.log(`push: ${m.title}\n${m.body}`);
  await pushAll(m);
}

// ---- heartbeat：防止仓库 60 天无活动导致定时 workflow 被停用 ----
const today = new Date(now).toISOString().slice(0, 10);
const prev = fs.existsSync(HEARTBEAT_FILE)
  ? fs.readFileSync(HEARTBEAT_FILE, 'utf8').trim()
  : '';
if (prev !== today) {
  fs.writeFileSync(HEARTBEAT_FILE, today + '\n');
  changed = true;
}

if (changed) {
  saveState(state);
  console.log('state updated');
} else {
  console.log('no boundary crossed, no-op');
}
