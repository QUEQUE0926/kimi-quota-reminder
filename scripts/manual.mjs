// manual：workflow_dispatch 触发，手动校准 / 月额度信号 / 推送测试。
// 多平台（MP 方案 §7）：所有操作按 platform 输入路由到对应命名空间，缺省 = kimi。
import { pushAll } from './push.mjs';
import {
  PLATFORMS, fmt, nextMonthlyReset,
  loadState, saveState, ensurePlatform,
} from './platforms.mjs';

const action = process.env.INPUT_ACTION;
const value = (process.env.INPUT_VALUE || '').trim();
const platform = (process.env.INPUT_PLATFORM || 'kimi').trim();

const { state, changed: migrated } = loadState();
const meta = PLATFORMS[platform];
if (!meta) throw new Error(`unknown platform: "${platform}"`);
const { ps } = ensurePlatform(state, platform);
let changed = migrated || false;

const parseTime = (v) => {
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) throw new Error(`invalid datetime: "${v}" (need ISO 8601, e.g. 2026-09-06T01:30:00+08:00)`);
  return new Date(ms).toISOString();
};

const needTier = (tier) => {
  if (!meta.tiers.includes(tier)) {
    throw new Error(`platform ${platform} has no ${tier} tier, action "${action}" not applicable`);
  }
};

switch (action) {
  case 'set_anchor':
    needTier('5h');
    ps.five_h_anchor = parseTime(value);
    console.log(`${platform}: five_h_anchor = ${ps.five_h_anchor}`);
    changed = true;
    break;
  case 'set_weekly_next':
    needTier('weekly');
    ps.weekly_next = parseTime(value);
    console.log(`${platform}: weekly_next = ${ps.weekly_next}`);
    changed = true;
    break;
  case 'set_monthly_anchor':
    needTier('monthly');
    ps.monthly_anchor = parseTime(value);
    console.log(`${platform}: monthly_anchor = ${ps.monthly_anchor}（月重置按此锚点逐月递推）`);
    if (meta.scheduledMonthly) {
      // WorkBuddy：anchor 设一次，monthly_next 自动算出（anchor 按日历月递推到的下一个未来时刻）
      ps.monthly_next = nextMonthlyReset(ps.monthly_anchor, Date.now());
      console.log(`${platform}: monthly_next = ${ps.monthly_next}`);
    }
    changed = true;
    break;
  case 'set_monthly_next':
    // 直接把下次月重置拨到指定时刻（测试用，如拨到过去触发 tick 推重置）
    needTier('monthly');
    ps.monthly_next = parseTime(value);
    console.log(`${platform}: monthly_next = ${ps.monthly_next}`);
    changed = true;
    break;
  case 'monthly_cap':
    // 月打满封顶：仅 Kimi 有打满语义（WorkBuddy 无打满信号，Codex 无月层）
    if (platform !== 'kimi') {
      throw new Error(`platform ${platform} has no monthly cap semantics, action "monthly_cap" not applicable`);
    }
    ps.monthly_exhausted_until = parseTime(value);
    ps.monthly_signal_at = null;
    console.log(`${platform}: monthly_exhausted_until = ${ps.monthly_exhausted_until}（期间所有提醒静默）`);
    changed = true;
    break;
  case 'clear_flags': {
    const cleared = [];
    if ('five_h_exhausted' in ps) { ps.five_h_exhausted = false; cleared.push('five_h_exhausted'); }
    if ('weekly_exhausted' in ps) { ps.weekly_exhausted = false; cleared.push('weekly_exhausted'); }
    if ('monthly_exhausted' in ps) { ps.monthly_exhausted = false; cleared.push('monthly_exhausted'); }
    if ('monthly_exhausted_until' in ps) { ps.monthly_exhausted_until = null; cleared.push('monthly_exhausted_until'); }
    if ('monthly_signal_at' in ps) { ps.monthly_signal_at = null; cleared.push('monthly_signal_at'); }
    // 档位阶梯字段一并复位（§12.1）
    if ('five_h_alert' in ps) { ps.five_h_alert = 0; cleared.push('five_h_alert'); }
    if ('weekly_alert' in ps) { ps.weekly_alert = 0; cleared.push('weekly_alert'); }
    if ('monthly_alert' in ps) { ps.monthly_alert = 0; cleared.push('monthly_alert'); }
    console.log(cleared.length
      ? `${platform}: all exhausted flags cleared (${cleared.join(', ')})`
      : `${platform}: no exhausted flags on this platform, nothing to clear`);
    changed = true;
    break;
  }
  case 'test_push': {
    const channels = [
      ['企业微信群机器人', !!process.env.WECOM_WEBHOOK],
      ['ntfy', !!process.env.NTFY_TOPIC],
      ['Bark', !!process.env.BARK_KEY],
      ['WxPusher', !!(process.env.WXPUSHER_SPT || (process.env.WXPUSHER_APPTOKEN && process.env.WXPUSHER_UID))],
    ];
    const active = channels.filter(([, on]) => on).map(([n]) => n);
    const inactive = channels.filter(([, on]) => !on).map(([n]) => n);
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

    // 各平台只出自己有的层级快照行
    const tierLines = [];
    if (platform === 'kimi') {
      tierLines.push(
        `5 小时窗口：用量 ${ps.five_h_used}/${ps.five_h_limit}，下个边界 ${fmt(ps.five_h_anchor)}，状态 ${ps.five_h_exhausted ? '已打满，待重置' : '正常'}`,
        `周额度：用量 ${ps.weekly_used}/${ps.weekly_limit}，下次重置 ${fmt(ps.weekly_next)}，状态 ${ps.weekly_exhausted ? '已打满，待重置' : '正常'}`,
        `月额度：${ps.monthly_exhausted_until ? `已打满，静默至 ${fmt(ps.monthly_exhausted_until)}` : '正常'}`,
      );
    } else if (platform === 'codex') {
      tierLines.push(
        `5 小时窗口：${ps.five_h_anchor ? `进行中，${fmt(ps.five_h_anchor)} 结束` : '未开启（下次会话开始时计时）'}，状态 ${ps.five_h_exhausted ? '已打满，待重置' : '正常'}`,
        `周额度：下次重置 ${fmt(ps.weekly_next)}，状态 ${ps.weekly_exhausted ? '已打满，待重置' : '正常'}`,
      );
    } else if (platform === 'workbuddy') {
      tierLines.push(`月额度：用量 ${ps.monthly_used}/${ps.monthly_limit}，锚点 ${fmt(ps.monthly_anchor)}，下次重置 ${fmt(ps.monthly_next)}，状态 ${ps.monthly_exhausted ? '已打满，待重置' : '正常'}`);
    }

    await pushAll({
      title: `🔔 ${meta.label} 额度提醒测试`,
      body: [
        `收到本条说明对应通道配置生效（发送时间 ${now}）。`,
        ``,
        `本次启用的推送通道：${active.join('、') || '无'}${inactive.length ? `；未配置：${inactive.join('、')}（需要的话在仓库 Secrets 里补上即可）` : ''}。`,
        ...tierLines,
      ].join('\n'),
      platform: meta.label,
    });
    break;
  }
  default:
    throw new Error(`unknown action: "${action}"`);
}

if (changed) {
  saveState(state);
  console.log('state updated');
}
