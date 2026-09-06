// codex-watcher.mjs · Codex 额度采集侧（采集方案 §2）
//
// 数据源：~/.codex/sessions/**/rollout-*.jsonl（只读）。每条 token_count 事件内嵌
// rate_limits 快照：primary=5h 滑动窗口、secondary=周窗口（固定时刻表）、resets_at、
// used_percent、rate_limit_reached_type。按 mtime 取最近若干文件，取其中时间戳最新的
// 一条 codex 快照（limit_id 过滤，跳过 base_model_inference 等其他限制）。
//
// 信号（client_payload 一律带 platform="codex"）：
//   session-activity  有新快照（快照时间戳 > 上次上报）→ {activity_at}，云端滑动锚点开窗
//   quota-sync        每轮检查云端 weekly_next 与会话日志 secondary.resets_at 是否一致，
//                     偏离才上报 {weekly:{reset_at}} 纠偏（无新活动且已对齐时保持静默，
//                     满足 CW-05「无新活动不发信号」；raw 附带 used_percent 供云端日志观察）
//   quota-exhausted   used_percent>=100 或 rate_limit_reached_type 非 null →
//                     {tier:"5h"|"weekly", reset_at:<对应 resets_at 精确值>}（V1 覆盖路径）
//
// 去重：状态文件记录上次上报的快照时间戳与各打满窗口的 reset_at；同一窗口的打满只报一次，
// 云端另有打满标志去重兜底。首次运行以当前快照为基线，不补发历史 session-activity（CW-11）。
// 限流：每轮最多发一个信号（优先级 quota-exhausted > session-activity > quota-sync），
// 其余下一轮补发——同秒并发的两个 signal run 会因云端 commit 的 -X ours 冲突解决丢状态。
//
// 传输（云端仓库防污染）：
//   缺省           repository_dispatch（生产形态，合并 main 后由默认分支 workflow 处理）
//   --ref=<分支>   改用 workflow_dispatch 把 signal.yml 打到指定分支（dev 测试期专用，
//                  推送带 [测试] 前缀；repository_dispatch 只会在默认分支 main 上运行，
//                  直接发会污染 main 的 state.json 或因 main 不支持 session-activity 而丢失）
//
// 用法：
//   node codex-watcher.mjs [--ref=dev/multi-platform] [--dry-run]
//                          [--state=<路径>] [--sessions-dir=<目录>] [--snapshot-json=<文件>]
//     --dry-run        只打印将发送的信号，不发送、不写状态文件
//     --snapshot-json  调试：从指定 JSON 文件读 {"timestamp", "rate_limits"} 快照，
//                      代替扫描 sessions（用于 CW-07/08 打满模拟，全程不写 .codex 目录）
//
// 安全：只读 ~/.codex（不写）；PAT 只从 quota-reminder.config.json 读取用于请求头，
// 不进仓库、不打印日志；任何失败静默退出（fail-open，云端滑动锚点可降级自治）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const KIMI_DIR = path.join(os.homedir(), '.kimi-code');
const HOOKS_DIR = path.join(KIMI_DIR, 'hooks');
const LOGS_DIR = path.join(HOOKS_DIR, 'logs');
const CONFIG_FILE = path.join(HOOKS_DIR, 'quota-reminder.config.json');
const LOG_FILE = path.join(LOGS_DIR, 'codex-watcher.log');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const opt = (name) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
};
const TARGET_REF = opt('ref'); // 缺省 = repository_dispatch（生产）；指定后 = workflow_dispatch 到该分支
const STATE_FILE = opt('state') || path.join(HOOKS_DIR, 'codex-watcher.state.json');
const SESSIONS_DIR = opt('sessions-dir') || path.join(os.homedir(), '.codex', 'sessions');
const SNAPSHOT_JSON = opt('snapshot-json');
const SCAN_FILES = 10; // 只看 mtime 最近的 N 个会话文件（最新文件可能还没产生 token_count）
const SYNC_TOLERANCE_MS = 5000; // weekly_next 与 resets_at 偏差容差

function log(...args2) {
  const line = `[${new Date().toISOString()}] ${args2.map(String).join(' ')}`;
  console.log(line);
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {}
}

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      last_activity_at: s.last_activity_at || null,
      reported_exhausted: s.reported_exhausted || {},
    };
  } catch {
    return { last_activity_at: null, reported_exhausted: {} };
  }
}

function saveState(state) {
  if (DRY_RUN) return;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

// 取最新一条 codex rate_limits 快照：{ timestamp, rate_limits }
function latestSnapshot() {
  if (SNAPSHOT_JSON) {
    const j = JSON.parse(fs.readFileSync(SNAPSHOT_JSON, 'utf8'));
    if (!j.timestamp || !j.rate_limits) throw new Error(`bad snapshot file: ${SNAPSHOT_JSON}`);
    return { timestamp: j.timestamp, rate_limits: j.rate_limits, file: SNAPSHOT_JSON };
  }
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) files.push(p);
    }
  })(SESSIONS_DIR);
  let best = null;
  const sorted = files
    .map((p) => ({ p, m: fs.statSync(p).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .slice(0, SCAN_FILES);
  for (const { p } of sorted) {
    let lines;
    try {
      lines = fs.readFileSync(p, 'utf8').split('\n');
    } catch {
      continue;
    }
    for (const line of lines) {
      if (!line.includes('rate_limits')) continue;
      let j;
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      const rl = j?.payload?.rate_limits;
      if (!rl || !j.timestamp) continue;
      if (rl.limit_id && rl.limit_id !== 'codex') continue; // 跳过 base_model_inference 等
      if (!rl.primary && !rl.secondary) continue;
      if (!best || Date.parse(j.timestamp) > Date.parse(best.timestamp)) {
        best = { timestamp: j.timestamp, rate_limits: rl, file: p };
      }
    }
  }
  return best;
}

// 打满判定：used_percent>=100 或 rate_limit_reached_type 非 null（V1 触发器）
function exhaustedTiers(rl) {
  const tiers = [];
  if (rl.primary && Number(rl.primary.used_percent) >= 100) tiers.push('5h');
  if (rl.secondary && Number(rl.secondary.used_percent) >= 100) tiers.push('weekly');
  const r = rl.rate_limit_reached_type;
  if (r !== null && r !== undefined) {
    const s = String(r).toLowerCase();
    if (/primary|5h|hour/.test(s)) {
      if (!tiers.includes('5h')) tiers.push('5h');
    } else if (/secondary|week/.test(s)) {
      if (!tiers.includes('weekly')) tiers.push('weekly');
    } else {
      log(`rate_limit_reached_type=${JSON.stringify(r)} 未识别，按 used_percent 判定`);
    }
  }
  return tiers;
}

const resetAtOf = (rl, tier) => {
  const sec = tier === '5h' ? rl.primary?.resets_at : rl.secondary?.resets_at;
  return Number.isFinite(sec) ? new Date(sec * 1000).toISOString() : null;
};

async function main() {
  if (!fs.existsSync(CONFIG_FILE)) {
    log('config missing, skip');
    return;
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const API = `https://api.github.com/repos/${cfg.github_owner}/${cfg.github_repo}`;
  const HEADERS = {
    Authorization: `Bearer ${cfg.github_pat}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'kimi-quota-reminder-codex-watcher',
    'Content-Type': 'application/json',
  };

  async function sendSignal(eventType, payload) {
    const body = { platform: 'codex', ...payload };
    log(`-> ${eventType} ${JSON.stringify(body)}${DRY_RUN ? '  [dry-run] 未发送' : ''}`);
    if (DRY_RUN) return;
    // --ref 指定分支：workflow_dispatch 到 signal.yml（dev 测试期）；否则 repository_dispatch（生产）
    const url = TARGET_REF
      ? `${API}/actions/workflows/signal.yml/dispatches`
      : `${API}/dispatches`;
    const reqBody = TARGET_REF
      ? { ref: TARGET_REF, inputs: { event_type: eventType, payload: JSON.stringify(body) } }
      : { event_type: eventType, client_payload: body };
    const res = await fetch(url, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify(reqBody),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`dispatch HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  // 读云端 codex.weekly_next（用于 quota-sync 纠偏判定；失败则本轮跳过 sync，fail-open）
  async function readCloudWeeklyNext() {
    const ref = TARGET_REF || 'main';
    const res = await fetch(`${API}/contents/state.json?ref=${encodeURIComponent(ref)}`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`read state HTTP ${res.status}`);
    const f = await res.json();
    const state = JSON.parse(Buffer.from(f.content, 'base64').toString('utf8'));
    return state?.platforms?.codex?.weekly_next || null;
  }

  const snap = latestSnapshot();
  if (!snap) {
    log('no codex rate_limits snapshot found, skip');
    return;
  }
  const rl = snap.rate_limits;
  log(
    `snapshot @${snap.timestamp}` +
      ` primary=${rl.primary?.used_percent ?? '?'}% weekly=${rl.secondary?.used_percent ?? '?'}%` +
      ` reached_type=${JSON.stringify(rl.rate_limit_reached_type ?? null)}` +
      (SNAPSHOT_JSON ? ` (from ${path.basename(SNAPSHOT_JSON)})` : '')
  );

  const state = loadState();
  const tiers = exhaustedTiers(rl);

  // 每轮最多发一个信号（优先级 quota-exhausted > session-activity > quota-sync），
  // 其余推迟到下一轮。原因：云端 signal.yml 的并发组挡不住同秒触发，两个 run 并行
  // checkout 同一 state、commit 相邻字段冲突时被 -X ours 整段覆盖，后到的信号状态会丢
  // （2026-09-06 CW-07 首测实测暴露）。轮询间隔 5 分钟 ≫ run 时长，逐轮补发无损失。
  const pending = []; // { eventType, payload, apply() }

  // 打满上报（本地按 reset_at 去重；云端打满标志兜底；一轮最多报一个层级，周层优先——
  // 层级闸门下周打满本来就压制 5h 提醒，5h 打满下一轮再报不迟）
  for (const tier of ['weekly', '5h']) {
    if (!tiers.includes(tier)) {
      // 窗口恢复正常后清掉去重键，下次打满（新窗口）可再次上报
      delete state.reported_exhausted[tier];
      continue;
    }
    const ra = resetAtOf(rl, tier);
    if (ra && state.reported_exhausted[tier] === ra) {
      log(`${tier} exhausted already reported, skip`);
      continue;
    }
    pending.push({
      eventType: 'quota-exhausted',
      payload: ra ? { tier, reset_at: ra } : { tier },
      apply: () => { if (ra) state.reported_exhausted[tier] = ra; },
    });
    break;
  }

  // 首次运行（无状态文件）：当前快照记为基线，不补发历史 session-activity（CW-11）；
  // 打满窗口也记入基线（避免因过期快照刷 ⚠️）；随后照常做 quota-sync 校准。
  if (!state.last_activity_at) {
    for (const tier of tiers) {
      const ra = resetAtOf(rl, tier);
      if (ra) state.reported_exhausted[tier] = ra;
    }
    pending.length = 0; // 基线轮不打满上报
    state.last_activity_at = snap.timestamp;
    saveState(state);
    log(`baseline recorded @${snap.timestamp}, no historical session-activity`);
  } else if (Date.parse(snap.timestamp) > Date.parse(state.last_activity_at)) {
    pending.push({
      eventType: 'session-activity',
      payload: { activity_at: snap.timestamp },
      apply: () => { state.last_activity_at = snap.timestamp; },
    });
  } else {
    log('no new snapshot, skip');
  }

  // quota-sync：每轮检查云端 weekly_next 是否偏离会话日志的 secondary.resets_at，偏离才纠偏
  if (rl.secondary && Number.isFinite(rl.secondary.resets_at)) {
    const want = new Date(rl.secondary.resets_at * 1000).toISOString();
    let cur = null;
    try {
      cur = await readCloudWeeklyNext();
    } catch (e) {
      log(`cloud state read failed (${e.message}), skip quota-sync this round`);
    }
    if (cur !== null || DRY_RUN) {
      if (cur && Math.abs(Date.parse(cur) - Date.parse(want)) <= SYNC_TOLERANCE_MS) {
        log(`weekly_next already aligned (${cur}), skip quota-sync`);
      } else {
        pending.push({
          eventType: 'quota-sync',
          payload: {
            weekly: { reset_at: want },
            raw: {
              primary_used_percent: rl.primary?.used_percent ?? null,
              secondary_used_percent: rl.secondary?.used_percent ?? null,
            },
          },
          apply: () => {},
        });
      }
    }
  }

  if (pending.length > 0) {
    const s = pending[0];
    await sendSignal(s.eventType, s.payload);
    s.apply();
    if (s.eventType === 'session-activity') {
      log(`new snapshot @${snap.timestamp} -> session-activity sent`);
    }
    if (pending.length > 1) {
      log(`${pending.length - 1} more signal(s) deferred to next round (one signal per round)`);
    }
  }

  saveState(state);
}

// 不调 process.exit：Windows 上 fetch 句柄未关完时强制 exit 会触发 libuv 断言。
main().catch((e) => log('error (fail-open):', e.message));
