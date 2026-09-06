// kimi-watcher.mjs · Kimi Code 额度采集侧（与 codex-watcher 并列，数据源不同）
//
// 数据源：本地 Kimi Code server 的用量接口（方案 §5 Hook A 同一接口），不是会话日志：
//   1. 扫 ~/.kimi-code/server/instances/*.json 找存活实例（pid 存活 + heartbeat < 2 分钟）
//   2. 用 ~/.kimi-code/server.token 作 bearer，调 GET http://127.0.0.1:<port>/api/v1/oauth/usage
//   3. 返回 data.limits[]（window:{unit,duration} + used/limit/reset_at）与 data.summary（周窗口）
// wire.jsonl 等会话日志不含用量快照（实测 grep 无 rate_limit/usage 字段），不能当数据源。
//
// 与现有 hook 的分工（不重复、只补缺）：
//   Hook A SessionStart / Hook B StopFailure / Hook C SessionEnd 只覆盖会话的三个时点；
//   长会话运行期间的 anchor 漂移校准、用量变化、打满兜底都由本 watcher 轮询补上。
//   CLI 没在跑（无存活实例）时无事可做——那是云端时刻表自治的时段，直接跳过。
//
// 信号（platform="kimi"，云端 signal.mjs applySyncKimi 消费）：
//   quota-sync {five_h, weekly, monthly, raw} —— 与 Hook A 完全同构，云端据此：
//     · 校准 five_h_anchor / weekly_next（固定时刻表纠偏，容差 2 分钟）
//     · 更新各层 used/limit；used>=limit 时补置 exhausted 标志并推送（StopFailure 漏报的兜底）
//     · limits 里一旦出现月窗口，自动接管月额度（方案 §7 升级路径）
//
// 发送条件（不满足只写本地观测日志，不打扰云端提交）：
//   基线（首次运行）/ 任一层 reset_at 变化 / 任一层打满状态翻转 / 月窗口出现 / 每日全量对账 /
//   云端 anchor 与 API reset_at 偏差超阈值（读云端 state 比对）/
//   用量跨过 30/50/80 档位（§12：搭 quota-sync 便车，云端阶梯去重推 🔶）
//
// 自适应轮询（采集方案 §7 + MP 方案 §12.4 分级）：基线 30 分钟（计划任务驱动）；
// 任一窗口 50≤used%<80 → 进程内驻留每 10 分钟一轮；80≤used%<100 → 每 5 分钟一轮；
// 打满或回落后退出，安全上限 6 小时。kimi 的 5h 是固定时刻表，
// 升频只是为了更快上报打满/档位/重置翻转，不改变时刻表语义。周打满期间 5h 不进升频（层级闸门 §7.2）。
//
// 单实例锁：~/.kimi-code/hooks/kimi-watcher.lock（PID + 时间戳 + mtime 过期 + pid 存活探测，
// 逻辑与 codex-watcher 一致）。
//
// 传输（云端仓库防污染）：缺省 repository_dispatch（生产）；--ref=<分支> 改用 workflow_dispatch
// 打 signal.yml 到指定分支（dev 测试期，推送带 [测试] 前缀）。
//
// 用法：
//   node kimi-watcher.mjs [--ref=dev/multi-platform] [--dry-run]
//                         [--state=<路径>] [--usage-json=<文件>] [--auth-file=<路径>]
//     --dry-run        只打印将发送的信号，不发送、不写状态文件
//     --usage-json     调试：从 JSON 文件读 {"kind":"ok","limits":[...],"summary":{...]}
//                      快照代替调本地 server（CI 测试用，全程不碰 ~/.kimi-code/server）
//     --auth-file      自定义 server.token 路径（调试）
//
// 调试开关（仅测试用，生产不带）：
//   --boost-interval-sec=<n>     驻留轮间隔秒数（≥80% 档），默认 300
//   --boost-mid-interval-sec=<n> 驻留轮间隔秒数（50~80% 档），默认 600
//   --max-boost-rounds=<n>       驻留最多 n 轮后退出（防止测试进程挂住）
//   --boost-start-offset-min=<n> 把驻留起点拨到 n 分钟前（测试安全上限）
//
// 安全：只读 ~/.kimi-code/server（不写）；PAT 只从 quota-reminder.config.json 读取用于请求头，
// 不进仓库、不打印日志；任何失败静默退出（fail-open，云端时刻表可降级自治）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const KIMI_DIR = path.join(os.homedir(), '.kimi-code');
const HOOKS_DIR = path.join(KIMI_DIR, 'hooks');
const LOGS_DIR = path.join(HOOKS_DIR, 'logs');
const CONFIG_FILE = path.join(HOOKS_DIR, 'quota-reminder.config.json');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LOG_FILE = path.join(LOGS_DIR, DRY_RUN ? 'kimi-watcher.dryrun.log' : 'kimi-watcher.log');
const LOCK_FILE = path.join(HOOKS_DIR, 'kimi-watcher.lock');
const opt = (name) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
};
const TARGET_REF = opt('ref'); // 缺省 = repository_dispatch（生产）；指定后 = workflow_dispatch 到该分支
const STATE_FILE = opt('state') || path.join(HOOKS_DIR, 'kimi-watcher.state.json');
const USAGE_JSON = opt('usage-json');
const AUTH_FILE = opt('auth-file') || path.join(KIMI_DIR, 'server.token');

const HEARTBEAT_MAX_AGE = 120_000; // 实例心跳超过 2 分钟视为不存活
const SYNC_TOLERANCE_MS = 5000; // weekly_next 与 reset_at 偏差容差
const ALIGN_TOLERANCE_MS = 2 * 60 * 1000; // five_h_anchor 校准容差（与云端 signal.mjs 一致）
const FIVE_H_MS = 5 * 3600 * 1000;
const BOOST_LOW = 80; // 临额区间下界（含）：≥80 → 5 分钟一轮
const BOOST_MID = 50; // 中档区间下界（含，§12.4）：50≤pct<80 → 10 分钟一轮
const BOOST_HIGH = 100; // 上界（不含；≥100 视为已打满，靠 sync 的打满翻转上报）
const ALERT_LADDER = [30, 50, 80]; // 档位提醒阶梯（§12，与云端 platforms.mjs 一致）
const DWELL_LIMIT_MS = 6 * 3600 * 1000; // 驻留安全上限
const LOCK_LIVE_MS = 10 * 60 * 1000; // 锁 mtime 小于此值视为有活实例

const BOOST_INTERVAL_MS = (Number(opt('boost-interval-sec')) || 300) * 1000;
const BOOST_MID_INTERVAL_MS = (Number(opt('boost-mid-interval-sec')) || 600) * 1000;
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

const todayStr = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { last_report: s.last_report || null, last_daily_sync: s.last_daily_sync || null };
  } catch {
    return { last_report: null, last_daily_sync: null };
  }
}

function saveState(state) {
  if (DRY_RUN) return;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

// ---- 单实例锁（与 codex-watcher 同构：PID 存活探测 + mtime 过期）----

function pidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
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

// ---- 数据获取：本地 server 用量接口（与 quota-sync.mjs 同构，逐轮重读实例与 token）----

function findLiveInstance() {
  const dir = path.join(KIMI_DIR, 'server', 'instances');
  const now = Date.now();
  let best = null;
  let ents;
  try {
    ents = fs.readdirSync(dir);
  } catch {
    return null; // 目录不存在 = CLI 从未起过 server
  }
  for (const f of ents) {
    if (!f.endsWith('.json')) continue;
    try {
      const inst = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (!inst.pid || !inst.port || !inst.host) continue;
      if (now - inst.heartbeat_at > HEARTBEAT_MAX_AGE) continue;
      process.kill(inst.pid, 0);
      if (!best || inst.heartbeat_at > best.heartbeat_at) best = inst;
    } catch {}
  }
  return best;
}

// 返回 { five_h, weekly, monthly }（均 {used,limit,reset_at} 或 null）+ raw；无存活实例返回 null
async function fetchUsage(inst) {
  if (USAGE_JSON) {
    const j = JSON.parse(fs.readFileSync(USAGE_JSON, 'utf8'));
    return normalizeUsage(j);
  }
  const token = fs.readFileSync(AUTH_FILE, 'utf8').trim();
  const res = await fetch(`http://${inst.host}:${inst.port}/api/v1/oauth/usage`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`usage API HTTP ${res.status}`);
  return normalizeUsage(await res.json());
}

function normalizeUsage(usage) {
  const d = usage?.data;
  if (!d || d.kind !== 'ok') throw new Error(`unexpected usage response: ${JSON.stringify(usage).slice(0, 300)}`);
  const pick = (w) => (w ? { used: w.used, limit: w.limit, reset_at: w.reset_at } : null);
  const fiveH = (d.limits || []).find((l) => l.window?.unit === 'hour' && l.window?.duration === 5);
  const weekly =
    d.summary?.window?.unit === 'week'
      ? d.summary
      : (d.limits || []).find((l) => l.window?.unit === 'week');
  const monthly = (d.limits || []).find(
    (l) => l.window?.unit === 'month' || (l.window?.unit === 'day' && l.window?.duration >= 28)
  );
  return {
    five_h: pick(fiveH),
    weekly: pick(weekly),
    monthly: pick(monthly),
    raw: { limits: d.limits || [], summary: d.summary || null },
  };
}

const pctOf = (w) => {
  const u = Number(w?.used);
  const l = Number(w?.limit);
  return Number.isFinite(u) && Number.isFinite(l) && l > 0 ? (u / l) * 100 : null;
};
const exhaustedOf = (w) => {
  const p = pctOf(w);
  return p !== null ? p >= 100 : false;
};

// 档位阶梯（§12）：返回用量落在的最高档（0/30/50/80/100），无数据返回 null
const tierOf = (w) => {
  const p = pctOf(w);
  if (p === null) return null;
  return p >= 100 ? 100 : ALERT_LADDER.filter((t) => p >= t).pop() || 0;
};
// 跳档上报判定：本次档位高于上次上报且未打满（≥100 由 exhaustion flipped 覆盖）
const tierCrossed = (prevW, nowW) => {
  const t = tierOf(nowW);
  return t !== null && t < 100 && t > (tierOf(prevW) ?? 0);
};

// five_h 固定时刻表校准比对：reset_at 应落在云端 anchor + 5h·k 上（与云端 misalign 算法一致）
function anchorDrifted(cloudAnchorIso, apiResetIso) {
  if (!cloudAnchorIso || !apiResetIso) return true;
  const diff = Math.abs(Date.parse(apiResetIso) - Date.parse(cloudAnchorIso)) % FIVE_H_MS;
  return Math.min(diff, FIVE_H_MS - diff) > ALIGN_TOLERANCE_MS;
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
      'User-Agent': 'kimi-quota-reminder-kimi-watcher',
      'Content-Type': 'application/json',
    };

    async function sendSignal(eventType, payload) {
      const body = { platform: 'kimi', ...payload };
      log(`-> ${eventType} ${JSON.stringify(body)}${DRY_RUN ? '  [dry-run] 未发送' : ''}`);
      if (DRY_RUN) return;
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

    // 读云端 platforms.kimi 状态（校准比对用；失败只跳过校准触发，不阻塞其余条件）
    async function readCloudKimi() {
      const ref = TARGET_REF || 'main';
      const res = await fetch(`${API}/contents/state.json?ref=${encodeURIComponent(ref)}`, {
        headers: HEADERS,
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`read state HTTP ${res.status}`);
      const f = await res.json();
      const state = JSON.parse(Buffer.from(f.content, 'base64').toString('utf8'));
      return state?.platforms?.kimi || {};
    }

    const state = loadState();

    // 一轮完整检查。返回 { boost } 供驻留循环判断。
    async function runRound() {
      const today = todayStr();
      const daily = state.last_daily_sync !== today;

      const inst = USAGE_JSON ? { host: '0.0.0.0', port: 0 } : findLiveInstance();
      if (!inst) {
        if (daily) log('daily sync due but no live CLI instance, skip');
        return { boost: false };
      }

      let u;
      try {
        u = await fetchUsage(inst);
      } catch (e) {
        log(`usage fetch failed (${e.message}), skip this round`);
        return { boost: false };
      }
      if (daily) log('daily re-sync round');
      log(
        `usage 5h=${u.five_h ? `${u.five_h.used}/${u.five_h.limit} reset ${u.five_h.reset_at}` : '(none)'}` +
          ` weekly=${u.weekly ? `${u.weekly.used}/${u.weekly.limit} reset ${u.weekly.reset_at}` : '(none)'}` +
          ` monthly=${u.monthly ? 'present' : 'absent'}` +
          (USAGE_JSON ? ` (from ${path.basename(USAGE_JSON)})` : '')
      );

      // 打满状态（各层）
      const exNow = {
        '5h': exhaustedOf(u.five_h),
        weekly: exhaustedOf(u.weekly),
        monthly: exhaustedOf(u.monthly),
      };
      const weeklyExhausted = exNow.weekly;

      // ---- 发送条件（见文件头注释）----
      const reasons = [];
      const prev = state.last_report;
      if (!prev) {
        reasons.push('baseline');
      } else {
        if (u.five_h?.reset_at !== prev.five_h?.reset_at) reasons.push('five_h reset_at changed');
        if (u.weekly?.reset_at !== prev.weekly?.reset_at) reasons.push('weekly reset_at changed');
        if (exNow['5h'] !== exhaustedOf(prev.five_h)) reasons.push('5h exhaustion flipped');
        if (exNow.weekly !== exhaustedOf(prev.weekly)) reasons.push('weekly exhaustion flipped');
        if (Boolean(u.monthly) !== Boolean(prev.monthly)) reasons.push('monthly window appeared/vanished');
        if (exNow.monthly !== exhaustedOf(prev.monthly)) reasons.push('monthly exhaustion flipped');
        // 档位跨越（§12.2）：搭 quota-sync 便车上报，云端按 *_alert 阶梯去重推 🔶
        if (tierCrossed(prev.five_h, u.five_h))
          reasons.push(`5h alert tier crossed (${tierOf(prev.five_h) ?? 0} -> ${tierOf(u.five_h)})`);
        if (tierCrossed(prev.weekly, u.weekly))
          reasons.push(`weekly alert tier crossed (${tierOf(prev.weekly) ?? 0} -> ${tierOf(u.weekly)})`);
      }
      if (daily) reasons.push('daily re-sync');

      if (reasons.length === 0 && u.five_h && u.weekly) {
        // 云端校准比对：云端 anchor 丢失或与 API reset_at 偏差超阈值 → 补发一次纠偏
        try {
          const cloud = await readCloudKimi();
          if (
            anchorDrifted(cloud.five_h_anchor, u.five_h.reset_at) ||
            !cloud.weekly_next ||
            Math.abs(Date.parse(cloud.weekly_next || 0) - Date.parse(u.weekly.reset_at)) > SYNC_TOLERANCE_MS
          ) {
            reasons.push('cloud drift');
          } else {
            log('cloud already aligned, keep silent');
          }
        } catch (e) {
          log(`cloud state read failed (${e.message}), skip drift check`);
        }
      }

      if (reasons.length > 0) {
        log(`sync triggered: ${reasons.join('; ')}`);
        await sendSignal('quota-sync', {
          five_h: u.five_h,
          weekly: u.weekly,
          monthly: u.monthly,
          raw: u.raw,
        });
        if (!DRY_RUN) {
          state.last_report = { five_h: u.five_h, weekly: u.weekly, monthly: u.monthly };
          if (daily) state.last_daily_sync = today;
        }
      } else {
        log('no trigger condition met, observe only');
        if (daily && !DRY_RUN) state.last_daily_sync = today;
      }

      // ---- 临额升频（§7.1 + §12.4 分级）：周打满期间 5h 升频无意义（§7.2 层级闸门）----
      // 50≤pct<80 → 10 分钟一轮；80≤pct<100 → 5 分钟一轮（取各层最高档定间隔）
      const boostParts = [];
      let maxPct = 0;
      if (!weeklyExhausted) {
        const p5 = pctOf(u.five_h);
        if (p5 !== null && p5 >= BOOST_MID && p5 < BOOST_HIGH) {
          boostParts.push(`5h ${Math.round(p5)}%`);
          maxPct = Math.max(maxPct, p5);
        }
      }
      const pw = pctOf(u.weekly);
      if (pw !== null && pw >= BOOST_MID && pw < BOOST_HIGH) {
        boostParts.push(`weekly ${Math.round(pw)}%`);
        maxPct = Math.max(maxPct, pw);
      }
      if (weeklyExhausted) log('weekly exhausted, 5h boost suppressed');
      const intervalMs = maxPct >= BOOST_LOW ? BOOST_INTERVAL_MS : BOOST_MID_INTERVAL_MS;
      return { boost: boostParts.length > 0, parts: boostParts, intervalMs };
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
        log(`boost mode entered (${r.parts.join(', ')})`);
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

      const iv = r.intervalMs || BOOST_INTERVAL_MS;
      writeLock();
      log(`boost dwell: next round in ${Math.round(iv / 1000)}s`);
      await sleep(iv);
      writeLock();
    }
  } finally {
    releaseLock();
  }
}

// 不调 process.exit：Windows 上 fetch 句柄未关完时强制 exit 会触发 libuv 断言。
main().catch((e) => log('error (fail-open):', e.message));
