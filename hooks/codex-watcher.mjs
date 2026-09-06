// codex-watcher.mjs · Codex 额度采集侧（采集方案 §2 + §7 自适应轮询 v2）
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
// ---- v2 自适应轮询（采集方案 §7）----
//
// 背景：推送准时性由云端 tick 按 reset_at 计算，与本地轮询频率无关；本地轮询只影响
// 「学到新锚点」的速度，30 分钟粒度足够。因此基线降为 30 分钟，用三个补偿机制兜住精度：
//
//   1. 每日全量扫描：跨天的第一轮扫全部会话文件（不止最近 10 个）并与云端对账纠偏，
//      但不补发 session-activity；state 记 last_daily_scan 日期避免当天重复。
//   2. 关闭补扫：每轮探测 Codex 桌面端进程，state 记 prev_codex_running；
//      「在 → 不在」转换当轮立即全量扫描，且允许补发 session-activity。
//   3. 临额升频：任一层 80 ≤ used_percent < 100 且 Codex 活跃（快照 15 分钟内有更新，
//      或进程在）→ 本轮不退出，进程内每 5 分钟一轮完整检查，直到条件消失。
//      驻留不改计划任务（实测改任务需管理员，见 §7.4），安全上限 6 小时强制退出。
//
// 单实例锁：驻留期间持锁，基线任务下一轮触发时检测到活锁立即秒退，避免重叠；
// 锁 mtime ≥ 10 分钟视为僵死可接管；异常退出没有机会清理锁，靠 mtime 过期兜底。
//
// 层级闸门（§7.2）：周打满（secondary.used_percent ≥ 100 或 rate_limit_reached_type
// 指向周）时，不发 quota-exhausted(5h)、不进升频；session-activity 照发。周用量回落后
// 自动恢复。与云端推送闸门同向、互不依赖。
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
//                      代替扫描 sessions（用于打满模拟，全程不写 .codex 目录）
//
// 调试开关（仅测试用，生产不带）：
//   --codex-running=true|false   注入进程探测结果，代替 tasklist（CW-15/CW-17c）
//   --boost-interval-sec=<n>     驻留轮间隔秒数，默认 300（测试时调小）
//   --boost-start-offset-min=<n> 把驻留起点拨到 n 分钟前（CW-17d 安全上限）
//   --max-boost-rounds=<n>       驻留最多 n 轮后退出（防止测试进程挂住）
//
// 安全：只读 ~/.codex（不写）；PAT 只从 quota-reminder.config.json 读取用于请求头，
// 不进仓库、不打印日志；任何失败静默退出（fail-open，云端滑动锚点可降级自治）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const KIMI_DIR = path.join(os.homedir(), '.kimi-code');
const HOOKS_DIR = path.join(KIMI_DIR, 'hooks');
const LOGS_DIR = path.join(HOOKS_DIR, 'logs');
const CONFIG_FILE = path.join(HOOKS_DIR, 'quota-reminder.config.json');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
// dry-run 单独落盘：复跑测试与人工排障不应把记录混进正式日志（review R5）
const LOG_FILE = path.join(LOGS_DIR, DRY_RUN ? 'codex-watcher.dryrun.log' : 'codex-watcher.log');
const LOCK_FILE = path.join(HOOKS_DIR, 'codex-watcher.lock');
const opt = (name) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
};
const TARGET_REF = opt('ref'); // 缺省 = repository_dispatch（生产）；指定后 = workflow_dispatch 到该分支
const STATE_FILE = opt('state') || path.join(HOOKS_DIR, 'codex-watcher.state.json');
const SESSIONS_DIR = opt('sessions-dir') || path.join(os.homedir(), '.codex', 'sessions');
const SNAPSHOT_JSON = opt('snapshot-json');

const SCAN_FILES = 10; // 基线轮只看 mtime 最近的 N 个会话文件；全量扫描不受此限制
const SYNC_TOLERANCE_MS = 5000; // weekly_next 与 resets_at 偏差容差
const BOOST_LOW = 80; // 临额区间下界（含）
const BOOST_HIGH = 100; // 上界（不含；≥100 视为已打满，由打满信号处理而非升频）
const ACTIVE_WINDOW_MS = 15 * 60 * 1000; // 快照在此时间内视为 Codex 活跃
const CLOCK_SKEW_MS = 60 * 1000; // 允许的时钟漂移：快照时间戳最多超前 1 分钟
const DWELL_LIMIT_MS = 6 * 3600 * 1000; // 驻留安全上限
const LOCK_LIVE_MS = 10 * 60 * 1000; // 锁 mtime 小于此值视为有活实例

const CODEX_RUNNING_ARG = opt('codex-running'); // 'true' | 'false' | null
const BOOST_INTERVAL_MS = (Number(opt('boost-interval-sec')) || 300) * 1000;
const BOOST_START_OFFSET_MS = (Number(opt('boost-start-offset-min')) || 0) * 60 * 1000;
const MAX_BOOST_ROUNDS = opt('max-boost-rounds') ? Number(opt('max-boost-rounds')) : Infinity;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...args2) {
  const line = `[${new Date().toISOString()}] ${args2.map(String).join(' ')}`;
  console.log(line);
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {}
}

// 本地日期（跨天按用户所在时区判断，不用 UTC）
const todayStr = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      last_activity_at: s.last_activity_at || null,
      reported_exhausted: s.reported_exhausted || {},
      last_daily_scan: s.last_daily_scan || null,
      prev_codex_running: s.prev_codex_running === true,
    };
  } catch {
    return {
      last_activity_at: null,
      reported_exhausted: {},
      last_daily_scan: null,
      prev_codex_running: false,
    };
  }
}

function saveState(state) {
  if (DRY_RUN) return;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

// ---- 单实例锁（§7.3）----
// 驻留实例每轮刷新 mtime；新实例见活锁秒退，见僵死锁接管。异常退出没有清理机会，
// 靠 mtime 过期兜底——所以锁里同时写 PID 和时间戳，便于人工核对是谁留的。
//
// review R2：进程被强杀（SIGKILL、计划任务强杀、测试超时）时 finally 不会执行，锁必然残留，
// 只靠 mtime 要白等 10 分钟。补一步 PID 存活探测，让强杀后的锁能被立即识别为僵死。

// 信号 0 只探测存在性、不真的发信号。解析不出 PID 时保守按「存活」处理，退回 mtime 判定。
function pidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // 存在但无权限（别的用户的进程）→ 视为存活，别抢
  }
}

function readLock() {
  try {
    const st = fs.statSync(LOCK_FILE);
    const text = fs.readFileSync(LOCK_FILE, 'utf8').trim();
    const pid = Number(text.split(/\s+/)[0]);
    return { ageMs: Date.now() - st.mtimeMs, text, alive: pidAlive(pid) };
  } catch {
    return null;
  }
}

function writeLock() {
  try {
    fs.writeFileSync(LOCK_FILE, `${process.pid} ${new Date().toISOString()}\n`);
  } catch {}
}

function acquireLock() {
  const l = readLock();
  if (l) {
    if (l.ageMs < LOCK_LIVE_MS && l.alive) {
      log(`lock held by live instance, exit (${l.text})`);
      return false;
    }
    log(
      `stale lock taken over (${l.text}, idle ${Math.round(l.ageMs / 1000)}s` +
        `${l.alive ? '' : ', pid dead'})`
    );
  }
  writeLock();
  return true;
}

function releaseLock() {
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch {}
}

// ---- Codex 桌面端进程探测（§7.1 关闭补扫 / 升频活跃判定）----
// 探测失败按「不在」处理，且不算转换（ok=false 时调用方跳过转换判定）。

function detectCodexRunning() {
  if (CODEX_RUNNING_ARG === 'true') return { running: true, ok: true, injected: true };
  if (CODEX_RUNNING_ARG === 'false') return { running: false, ok: true, injected: true };
  try {
    const out = execFileSync('tasklist', ['/fi', 'imagename eq Codex.exe'], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true, // 无窗口：不能因为探测进程又弹出控制台
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { running: /Codex\.exe/i.test(out), ok: true, injected: false };
  } catch (e) {
    log(`codex process probe failed (${e.message}), treat as not running`);
    return { running: false, ok: false, injected: false };
  }
}

// 取最新一条 codex rate_limits 快照：{ timestamp, rate_limits }
// full=true 时扫描全部会话文件（每日全量 / 关闭补扫用），否则只看最近 SCAN_FILES 个
function latestSnapshot(full = false) {
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
    .sort((a, b) => b.m - a.m);
  const scanList = full ? sorted : sorted.slice(0, SCAN_FILES);
  for (const { p } of scanList) {
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
  if (best) {
    best.scanned = scanList.length; // review R6：供调用方打印「扫了几个/共几个」
    best.total = sorted.length;
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

const pctOf = (w) => {
  const v = Number(w?.used_percent);
  return Number.isFinite(v) ? v : null;
};

const resetAtOf = (rl, tier) => {
  const sec = tier === '5h' ? rl.primary?.resets_at : rl.secondary?.resets_at;
  return Number.isFinite(sec) ? new Date(sec * 1000).toISOString() : null;
};

// 升频判定（§7.1）：任一层落在 [80,100) 且 Codex 活跃。
// 周打满直接不进升频——5h 重置在周打满期间无意义（§7.2）。
function evaluateBoost(rl, snapTs, codexRunning, weeklyExhausted) {
  const parts = [];
  if (weeklyExhausted) return { boost: false, parts };
  const p = pctOf(rl.primary);
  const s = pctOf(rl.secondary);
  if (p !== null && p >= BOOST_LOW && p < BOOST_HIGH) parts.push(`5h ${p}%`);
  if (s !== null && s >= BOOST_LOW && s < BOOST_HIGH) parts.push(`weekly ${s}%`);
  if (parts.length === 0) return { boost: false, parts };
  const ageMs = Date.now() - Date.parse(snapTs);
  // review R4：ageMs 为负说明快照时间戳在未来，只容忍 CLOCK_SKEW_MS 的时钟漂移。
  // 不加下界的话，未来时间戳会被当成「刚发生」而误进驻留（实测可复现）。
  const fresh =
    Number.isFinite(ageMs) && ageMs >= -CLOCK_SKEW_MS && ageMs <= ACTIVE_WINDOW_MS;
  return { boost: fresh || codexRunning, parts, ageMs, fresh };
}

async function main() {
  if (!fs.existsSync(CONFIG_FILE)) {
    log('config missing, skip');
    return;
  }
  if (!acquireLock()) return;

  try {
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
      const url = TARGET_REF ? `${API}/actions/workflows/signal.yml/dispatches` : `${API}/dispatches`;
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

    const state = loadState();

    // 一轮完整检查。返回 { boost, parts } 供驻留循环判断是否继续。
    async function runRound() {
      const today = todayStr();

      // 关闭补扫（§7.1）：上一轮在、本轮不在 → 立即全量扫描。探测失败不视为转换。
      const probe = detectCodexRunning();
      const catchUp = probe.ok && state.prev_codex_running && !probe.running;

      // 每日全量扫描（§7.1）：跨天的第一轮扫全部文件对账，但不补发 session-activity
      const daily = state.last_daily_scan !== today;
      log(daily ? 'daily full scan' : 'daily scan already done, skip');
      if (catchUp) log('codex exited, running catch-up scan');

      const fullScan = daily || catchUp;
      const snap = latestSnapshot(fullScan);
      if (!snap) {
        log('no codex rate_limits snapshot found, skip');
        if (probe.ok) state.prev_codex_running = probe.running;
        if (daily) state.last_daily_scan = today;
        return { boost: false, parts: [] };
      }
      if (daily) state.last_daily_scan = today;
      if (probe.ok) state.prev_codex_running = probe.running;

      const rl = snap.rate_limits;
      // review R6：带上扫描文件数，才能从日志直接判断这轮到底是「全量」还是「限量」
      if (snap.total !== undefined) {
        log(`scan ${snap.scanned}/${snap.total} files${fullScan ? ' (full)' : ' (recent only)'}`);
      }
      log(
        `snapshot @${snap.timestamp}` +
          ` primary=${rl.primary?.used_percent ?? '?'}% weekly=${rl.secondary?.used_percent ?? '?'}%` +
          ` reached_type=${JSON.stringify(rl.rate_limit_reached_type ?? null)}` +
          (SNAPSHOT_JSON ? ` (from ${path.basename(SNAPSHOT_JSON)})` : '')
      );

      const tiers = exhaustedTiers(rl);
      // 层级闸门（§7.2）：周打满 → 压掉 5h 打满信号与升频，session-activity 照发
      const weeklyExhausted = tiers.includes('weekly');
      if (weeklyExhausted) log('weekly exhausted, 5h signals suppressed');

      // 每轮最多发一个信号（优先级 quota-exhausted > session-activity > quota-sync），
      // 其余推迟到下一轮。原因：云端 signal.yml 的并发组挡不住同秒触发，两个 run 并行
      // checkout 同一 state、commit 相邻字段冲突时被 -X ours 整段覆盖，后到的信号状态会丢
      // （2026-09-06 CW-07 首测实测暴露）。
      const pending = []; // { eventType, payload, apply() }

      // 关闭快照（MP-17）：进程「在→不在」转换的这轮，把退出事件本身排在最高优先级——
      // 上报最后一条快照的 passive 摘要（云端 applySyncCodex 顺带做周校准）；打满/活动
      // 信号推迟到下一轮（标志未记录，下轮照常补报）
      if (catchUp) {
        pending.push({
          eventType: 'quota-close',
          payload: {
            five_h: rl.primary
              ? { used_percent: rl.primary.used_percent ?? null, reset_at: resetAtOf(rl, '5h') }
              : null,
            weekly: rl.secondary
              ? { used_percent: rl.secondary.used_percent ?? null, reset_at: resetAtOf(rl, 'weekly') }
              : null,
          },
          apply: () => {},
        });
      }

      // 打满上报（本地按 reset_at 去重；云端打满标志兜底；一轮最多报一个层级，周层优先——
      // 层级闸门下周打满本来就压制 5h 提醒，5h 打满下一轮再报不迟）
      for (const tier of ['weekly', '5h']) {
        if (!tiers.includes(tier)) {
          // 窗口恢复正常后清掉去重键，下次打满（新窗口）可再次上报
          delete state.reported_exhausted[tier];
          continue;
        }
        if (tier === '5h' && weeklyExhausted) continue; // 周打满期间不发 5h
        const ra = resetAtOf(rl, tier);
        if (ra && state.reported_exhausted[tier] === ra) {
          log(`${tier} exhausted already reported, skip`);
          continue;
        }
        pending.push({
          eventType: 'quota-exhausted',
          payload: ra ? { tier, reset_at: ra } : { tier },
          apply: () => {
            if (ra) state.reported_exhausted[tier] = ra;
          },
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
        log(`baseline recorded @${snap.timestamp}, no historical session-activity`);
      } else if (Date.parse(snap.timestamp) > Date.parse(state.last_activity_at)) {
        // review R3：每日全量与关闭补扫撞在同一轮时让补扫优先——补扫的语义本就是「补发」，
        // 否则跨天第一轮正好赶上 Codex 退出，补扫白跑、补发还要再等一轮。
        if (daily && !catchUp) {
          log('daily full scan: new snapshot present, session-activity suppressed');
        } else {
          pending.push({
            eventType: 'session-activity',
            payload: { activity_at: snap.timestamp },
            apply: () => {
              state.last_activity_at = snap.timestamp;
            },
          });
        }
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

      const b = evaluateBoost(rl, snap.timestamp, probe.running, weeklyExhausted);
      if (b.parts.length > 0 && !b.boost) {
        log(`boost condition not met (${b.parts.join(', ')}, inactive)`);
      }
      return b;
    }

    // ---- 主循环：基线跑一轮即退；命中临额区间则进程内驻留（§7.1 升频）----
    let boostActive = false;
    let dwellStart = 0;
    let boostRounds = 0;

    for (;;) {
      const r = await runRound();
      saveState(state);

      if (!r.boost) {
        if (boostActive) log('boost mode exited');
        break;
      }

      if (!boostActive) {
        boostActive = true;
        dwellStart = Date.now() - BOOST_START_OFFSET_MS;
        log(`boost mode entered (${r.parts.join(', ')}, active)`);
      }

      if (Date.now() - dwellStart >= DWELL_LIMIT_MS) {
        log('boost dwell limit reached, exit');
        break;
      }

      boostRounds += 1;
      if (boostRounds >= MAX_BOOST_ROUNDS) {
        log(`boost rounds cap reached (${boostRounds}), exit`);
        break;
      }

      writeLock(); // 刷新 mtime，向基线任务表明驻留实例还活着
      log(`boost dwell: next round in ${Math.round(BOOST_INTERVAL_MS / 1000)}s`);
      await sleep(BOOST_INTERVAL_MS);
      writeLock();
    }
  } finally {
    releaseLock();
  }
}

// 不调 process.exit：Windows 上 fetch 句柄未关完时强制 exit 会触发 libuv 断言。
main().catch((e) => log('error (fail-open):', e.message));
