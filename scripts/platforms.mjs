// 多平台共享层（MP 方案 §2/§3）：平台元数据、state v1→v2 迁移、通用工具。
// signal / tick / manual 三个入口统一从这里取状态，保证迁移只发生一次且幂等。
import fs from 'node:fs';

export const STATE_FILE = 'state.json';
export const TZ = 'Asia/Shanghai';
export const FIVE_H = 5 * 3600 * 1000;
export const WEEK = 7 * 24 * 3600 * 1000;

// 用量档位提醒（MP 方案 §12）：每层默认阈值 30/50/80，按平台×层级挂进注册表。
// Kimi 月层砍掉（§12.6 V5 已验证：用量 API 无月窗口，sync 上报 monthly 恒为 null）。
const TIERS_30_50_80 = [30, 50, 80];

// 平台注册表：label 用于推送标题平台标签；tiers 决定该平台有哪些层级；
// sliding5h = Codex 滑动锚点（session-activity 开窗，跨边界后置空不递推）；
// scheduledMonthly = WorkBuddy 纯月层（anchor 按日历月递推出 monthly_next）；
// alerts = 该平台参与档位提醒的层级及阈值（state 字段 <field>_alert 记录已提醒到的最高档）。
export const PLATFORMS = {
  kimi: { label: 'Kimi Code', tiers: ['5h', 'weekly', 'monthly'],
    alerts: { '5h': TIERS_30_50_80, weekly: TIERS_30_50_80 } },
  codex: { label: 'Codex', tiers: ['5h', 'weekly'], sliding5h: true,
    alerts: { '5h': TIERS_30_50_80, weekly: TIERS_30_50_80 } },
  workbuddy: { label: 'WorkBuddy', tiers: ['monthly'], scheduledMonthly: true,
    alerts: { monthly: TIERS_30_50_80 } },
};

export const TIER_NAMES = { '5h': '5 小时额度', weekly: '周额度', monthly: '月额度' };

// tier → state 字段前缀（<field>_alert / <field>_exhausted）
export const TIER_FIELD = { '5h': 'five_h', weekly: 'weekly', monthly: 'monthly' };

export const fmt = (iso) =>
  iso ? new Date(iso).toLocaleString('zh-CN', { timeZone: TZ, hour12: false }) : '未知';

// 由订阅锚点递推月重置：同一日期数字、同一时刻，逐月推进（日期不存在时钳到月末）
export function nextMonthlyReset(anchorIso, afterMs) {
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

// v1 顶层平铺的 Kimi 字段（迁移时原样搬进 platforms.kimi）
const KIMI_V1_KEYS = [
  'five_h_anchor', 'five_h_used', 'five_h_limit', 'five_h_exhausted',
  'weekly_next', 'weekly_used', 'weekly_limit', 'weekly_exhausted',
  'monthly_anchor', 'monthly_exhausted_until', 'monthly_signal_at',
  'last_sync',
];

export function defaultPlatformState(name) {
  switch (name) {
    case 'kimi':
      return {
        five_h_anchor: null, five_h_used: 0, five_h_limit: 0, five_h_exhausted: false,
        five_h_alert: 0,
        weekly_next: null, weekly_used: 0, weekly_limit: 0, weekly_exhausted: false,
        weekly_alert: 0,
        monthly_anchor: null, monthly_exhausted_until: null, monthly_signal_at: null,
        last_sync: null,
      };
    case 'codex':
      return {
        five_h_anchor: null, five_h_exhausted: false, five_h_alert: 0, last_activity_at: null,
        weekly_next: null, weekly_exhausted: false, weekly_alert: 0,
      };
    case 'workbuddy':
      return {
        monthly_anchor: null, monthly_next: null,
        monthly_used: 0, monthly_limit: 0, monthly_exhausted: false, monthly_alert: 0,
        last_sync: null,
      };
    default:
      throw new Error(`unknown platform: "${name}"`);
  }
}

// 读取 state.json；schema 缺失或为 1 时把顶层 Kimi 字段原样搬进 platforms.kimi。
// 迁移幂等：schema 已是 2 则原样返回。返回 { state, changed }，changed 含迁移标记。
export function loadState() {
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  let changed = false;
  if (state.schema !== 2) {
    const kimi = {};
    for (const k of KIMI_V1_KEYS) {
      if (k in state) {
        kimi[k] = state[k];
        delete state[k];
      }
    }
    state.platforms = { ...state.platforms, kimi: { ...defaultPlatformState('kimi'), ...kimi } };
    state.schema = 2;
    changed = true;
    console.log('migrated state v1 -> v2');
  }
  return { state, changed };
}

// 取平台命名空间，不存在则按注册表初始化（懒建，幂等）
export function ensurePlatform(state, name) {
  if (!PLATFORMS[name]) throw new Error(`unknown platform: "${name}"`);
  if (!state.platforms) state.platforms = {};
  if (!state.platforms[name]) {
    state.platforms[name] = defaultPlatformState(name);
    console.log(`${name}: platform namespace initialized`);
    return { ps: state.platforms[name], created: true };
  }
  return { ps: state.platforms[name], created: false };
}

export function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}
