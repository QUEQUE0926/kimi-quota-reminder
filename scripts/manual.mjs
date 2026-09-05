// manual：workflow_dispatch 触发，手动校准 / 月额度信号 / 推送测试。
import fs from 'node:fs';
import { pushAll } from './push.mjs';

const STATE_FILE = 'state.json';
const action = process.env.INPUT_ACTION;
const value = (process.env.INPUT_VALUE || '').trim();

const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
let changed = false;

const parseTime = (v) => {
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) throw new Error(`invalid datetime: "${v}" (need ISO 8601, e.g. 2026-09-06T01:30:00+08:00)`);
  return new Date(ms).toISOString();
};

switch (action) {
  case 'set_anchor':
    state.five_h_anchor = parseTime(value);
    console.log(`five_h_anchor = ${state.five_h_anchor}`);
    changed = true;
    break;
  case 'set_weekly_next':
    state.weekly_next = parseTime(value);
    console.log(`weekly_next = ${state.weekly_next}`);
    changed = true;
    break;
  case 'monthly_cap':
    state.monthly_exhausted_until = parseTime(value);
    state.monthly_signal_at = null;
    console.log(`monthly_exhausted_until = ${state.monthly_exhausted_until}（期间所有提醒静默）`);
    changed = true;
    break;
  case 'clear_flags':
    state.five_h_exhausted = false;
    state.weekly_exhausted = false;
    state.monthly_exhausted_until = null;
    state.monthly_signal_at = null;
    console.log('all exhausted flags cleared');
    changed = true;
    break;
  case 'test_push': {
    const channels = [
      ['企业微信群机器人', !!process.env.WECOM_WEBHOOK],
      ['ntfy', !!process.env.NTFY_TOPIC],
      ['Bark', !!process.env.BARK_KEY],
    ];
    const active = channels.filter(([, on]) => on).map(([n]) => n);
    const inactive = channels.filter(([, on]) => !on).map(([n]) => n);
    const fmt = (iso) =>
      iso ? new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '未设置';
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    await pushAll({
      title: '🔔 Kimi Code 额度提醒测试',
      body: [
        `收到本条说明对应通道配置生效（发送时间 ${now}）。`,
        ``,
        `本次启用的推送通道：${active.join('、') || '无'}${inactive.length ? `；未配置：${inactive.join('、')}（需要的话在仓库 Secrets 里补上即可）` : ''}。`,
        `5 小时窗口：用量 ${state.five_h_used}/${state.five_h_limit}，下个边界 ${fmt(state.five_h_anchor)}，状态 ${state.five_h_exhausted ? '已打满，待重置' : '正常'}`,
        `周额度：用量 ${state.weekly_used}/${state.weekly_limit}，下次重置 ${fmt(state.weekly_next)}，状态 ${state.weekly_exhausted ? '已打满，待重置' : '正常'}`,
        `月额度：${state.monthly_exhausted_until ? `已打满，静默至 ${fmt(state.monthly_exhausted_until)}` : '正常'}`,
      ].join('\n'),
    });
    break;
  }
  default:
    throw new Error(`unknown action: "${action}"`);
}

if (changed) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
  console.log('state updated');
}
