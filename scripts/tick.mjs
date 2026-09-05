// tick：每 5 分钟由 cron 触发，按方案 §4 的分层规则检查时刻表边界并推送。
import fs from 'node:fs';
import { pushAll } from './push.mjs';

const STATE_FILE = 'state.json';
const HEARTBEAT_FILE = 'heartbeat.txt';
const FIVE_H = 5 * 3600 * 1000;
const WEEK = 7 * 24 * 3600 * 1000;
const TZ = 'Asia/Shanghai';

const fmt = (ms) =>
  new Date(ms).toLocaleString('zh-CN', { timeZone: TZ, hour12: false });

const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
const now = Date.now();
let changed = false;
const messages = [];

// ---- 月层 ----
if (state.monthly_exhausted_until) {
  const until = Date.parse(state.monthly_exhausted_until);
  if (now >= until) {
    messages.push({
      title: '✅ Kimi Code 月额度已重置',
      body: `月额度已刷新（${fmt(now)}），5 小时 / 周 / 月全部恢复可用。`,
    });
    state.monthly_exhausted_until = null;
    state.monthly_signal_at = null;
    state.five_h_exhausted = false;
    state.weekly_exhausted = false;
    changed = true;
  }
}
const monthlyActive = !!state.monthly_exhausted_until;

// ---- 5 小时层：跨过 anchor + 5h·k 边界 ----
if (state.five_h_anchor) {
  const anchor = Date.parse(state.five_h_anchor);
  if (now >= anchor) {
    const k = Math.floor((now - anchor) / FIVE_H) + 1;
    const next = anchor + k * FIVE_H; // 下一个未来边界
    if (state.five_h_exhausted && !state.weekly_exhausted && !monthlyActive) {
      messages.push({
        title: '✅ Kimi Code 5小时额度已重置',
        body: `5 小时窗口已在 ${fmt(next - FIVE_H)} 刷新，下个边界 ${fmt(next)}。当前用量 ${state.five_h_used}/${state.five_h_limit}（以 console 为准）。`,
      });
    }
    if (state.five_h_exhausted) state.five_h_exhausted = false;
    state.five_h_anchor = new Date(next).toISOString();
    changed = true;
  }
}

// ---- 周层 ----
if (state.weekly_next) {
  let wn = Date.parse(state.weekly_next);
  if (now >= wn) {
    if (state.weekly_exhausted && !monthlyActive) {
      messages.push({
        title: '✅ Kimi Code 周额度已重置',
        body: `周额度已在 ${fmt(wn)} 刷新，5 小时窗口同步恢复。`,
      });
    }
    while (wn <= now) wn += WEEK;
    state.weekly_next = new Date(wn).toISOString();
    state.weekly_exhausted = false;
    state.five_h_exhausted = false; // 周重置后 5h 必然也是满的
    changed = true;
  }
}

// ---- 推送 ----
for (const m of messages) {
  console.log(`push: ${m.title}`);
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
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
  console.log('state updated');
} else {
  console.log('no boundary crossed, no-op');
}
