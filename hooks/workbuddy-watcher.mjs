// workbuddy-watcher.mjs · WorkBuddy 额度采集侧（与 codex/kimi watcher 并列）
//
// 数据源：WorkBuddy 云端 billing API（2026-09-07 实测可行，本地取证结论）——
// 不是本地日志（daemon.log/main.log 只记 RPC 耗时无数值；workbuddy.db 的 session_usage
// 只是每会话 context 用量，credit_json 全空；leveldb/Cookies 无缓存）：
//   1. 读 token 文件（FileAuthenticationStorage 明文落盘，无 safeStorage 加密）：
//      %LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info
//      取 auth.accessToken（Bearer）+ account.uid（X-User-Id）。
//      应用自动刷新会原位重写此文件（token 有效期约 60 天），watcher 每轮重读即可。
//   2. POST https://www.workbuddy.cn/billing/meter/get-user-resource-summary {} →
//      data.Packages[]：PackageCode / CycleTotalCapacity / CycleRemainCapacity /
//      CycleUsedCapacity / CapacityUnit（credits，字符串数值）
//   3. POST .../get-user-resource-free-packages {PageNumber:1,PageSize:50,
//      PackageCodes:[summary 动态取],Status:[0,3]} →
//      data.Accounts[].CycleEndTime（周期重置时间，"YYYY-MM-DD HH:mm:ss" 北京时间无时区）
//   企业账号另有 POST .../v2/billing/meter/get-enterprise-user-usage {}（limitNum/credit/
//   cycleResetTime）；accountType=enterprise 时会实际调用它取 reset_at（失败则回落 2 并记日志）。
//   本账号为免费包形态，默认走 1+2。
//
// 信号（platform="workbuddy"）：
//   quota-sync {account_type, monthly:{used,limit,reset_at}, raw:{packages,accounts}}
//   聚合口径：used = ΣCycleUsedCapacity、limit = ΣCycleTotalCapacity；reset_at 取
//   Accounts 中最近的未来 CycleEndTime（ISO，按 Asia/Shanghai 解析）。
//   account_type（account.accountType || account.type）云端门控（方案 B，collection §9.4）：
//   enterprise 的 reset_at 校准 monthly_anchor；personal 各包独立过期，reset_at 仅观察。
//   ⚠ 云端 applySyncWorkbuddy（repo/scripts/signal.mjs）：用 monthly.reset_at 纠 monthly_next、
//   used>=limit 置闸门，2026-09-07 已落地（MP-16 回归覆盖）。
//
// 发送条件：基线（首次）/ 聚合 used、limit 或 reset_at 任一变化 / 打满状态翻转 /
// 每日对账。另：每天 23 点一轮发 quota-close（被动 📴 每日额度快照，云端同步+出摘要，
// 见 collection §9.3 落地记录）。token 失效（401/403）→ 记日志跳过，应用在线刷新后下轮自动恢复（fail-open）。
//
// 自适应轮询（采集方案 §7 同构）：基线 30 分钟一轮；剩余 <20%（80≤used%<100）时进程内
// 驻留每 5 分钟一轮，打满或回落退出，安全上限 6 小时。
//
// 单实例锁：~/.kimi-code/hooks/workbuddy-watcher.lock（PID + mtime + 存活探测）。
//
// 传输：缺省 repository_dispatch（生产）；--ref=<分支> 改 workflow_dispatch 打 dev 分支。
//
// 用法：
//   node workbuddy-watcher.mjs [--ref=dev/multi-platform] [--dry-run]
//                             [--state=<路径>] [--auth-file=<路径>] [--api-base=<URL>]
//                             [--summary-json=<文件>] [--packages-json=<文件>]
//     --dry-run          只打印将发送的信号，不发送、不写状态文件
//     --auth-file        自定义 workbuddy-desktop.info 路径（调试）
//     --api-base         自定义网关（默认 https://www.workbuddy.cn；codebuddy.cn /
//                        copilot.tencent.com 同一网关可切换）
//     --summary-json     调试：读 get-user-resource-summary 响应快照代替调云端
//     --packages-json    调试：读 get-user-resource-free-packages 响应快照代替调云端
//
// 调试开关（仅测试用）：--boost-interval-sec / --max-boost-rounds / --boost-start-offset-min
//
// 安全：只读 token 文件与云端 GET/POST 查询接口；PAT 只从 quota-reminder.config.json 读取
// 用于请求头；任何失败静默退出（fail-open）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const KIMI_DIR = path.join(os.homedir(), '.kimi-code');
const HOOKS_DIR = path.join(KIMI_DIR, 'hooks');
const LOGS_DIR = path.join(HOOKS_DIR, 'logs');
const CONFIG_FILE = path.join(HOOKS_DIR, 'quota-reminder.config.json');
const WB_AUTH_FILE = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'
);

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LOG_FILE = path.join(LOGS_DIR, DRY_RUN ? 'workbuddy-watcher.dryrun.log' : 'workbuddy-watcher.log');
const LOCK_FILE = path.join(HOOKS_DIR, 'workbuddy-watcher.lock');
const opt = (name) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
};
const TARGET_REF = opt('ref');
const STATE_FILE = opt('state') || path.join(HOOKS_DIR, 'workbuddy-watcher.state.json');
const AUTH_FILE = opt('auth-file') || WB_AUTH_FILE;
const API_BASE = (opt('api-base') || 'https://www.workbuddy.cn').replace(/\/$/, '');
const SUMMARY_JSON = opt('summary-json');
const PACKAGES_JSON = opt('packages-json');

const BJ_OFFSET = '+08:00'; // CycleEndTime 无时区，按北京时间解析（workbuddy.cn 国内站）
const SYNC_TOLERANCE_MS = 5000;
const BOOST_LOW = 80;
const BOOST_HIGH = 100;
const DWELL_LIMIT_MS = 6 * 3600 * 1000;
const LOCK_LIVE_MS = 10 * 60 * 1000;

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

const todayStr = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      last_report: s.last_report || null,
      last_daily_sync: s.last_daily_sync || null,
      last_close_date: s.last_close_date || null,
    };
  } catch {
    return { last_report: null, last_daily_sync: null, last_close_date: null };
  }
}

function saveState(state) {
  if (DRY_RUN) return;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

// ---- 单实例锁（与 codex/kimi watcher 同构）----

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

// ---- 数据获取：WorkBuddy billing API ----

function readAuth() {
  const info = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  const token = info?.auth?.accessToken;
  const uid = info?.account?.uid;
  if (!token || !uid) throw new Error(`auth file missing accessToken/uid: ${AUTH_FILE}`);
  // 方案 B（collection §9.4）：accountType 决定云端语义——企业版 reset_at 校准锚点；
  // 个人版各包独立过期，reset_at 仅随快照观察，不动用户手填锚点。本机实测 accountType
  // 可能为空串，真实值在 account.type（collection §9.1 W2）。
  const accountType =
    (info?.account?.accountType || info?.account?.type || 'personal').trim() || 'personal';
  return { token, uid, expiresAt: info?.auth?.expiresAt || null, accountType };
}

async function postBilling(path, body, auth) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth.token}`,
      'X-User-Id': auth.uid,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Accept-Language': 'zh',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`billing API HTTP ${res.status}（token 过期，等应用刷新后重试）`);
  }
  if (!res.ok) throw new Error(`billing API HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// "2026-10-03 16:17:54"（北京时间）→ ISO；解析失败返回 null
const bjIso = (s) => {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/.exec(String(s || ''));
  return m ? new Date(`${m[1]}T${m[2]}${BJ_OFFSET}`).toISOString() : null;
};

// 返回 { used, limit, reset_at, packages, accounts }
async function fetchUsage(auth) {
  let summary;
  let packages;
  if (SUMMARY_JSON) {
    summary = JSON.parse(fs.readFileSync(SUMMARY_JSON, 'utf8'));
  } else {
    summary = await postBilling('/billing/meter/get-user-resource-summary', {}, auth);
  }
  const pkgs = summary?.data?.Packages || [];
  if (!summary || summary.code !== 0) {
    throw new Error(`bad summary response: ${JSON.stringify(summary).slice(0, 200)}`);
  }
  const pkgCodes = pkgs.map((p) => p.PackageCode).filter(Boolean);
  if (PACKAGES_JSON) {
    packages = JSON.parse(fs.readFileSync(PACKAGES_JSON, 'utf8'));
  } else if (pkgCodes.length > 0) {
    packages = await postBilling('/billing/meter/get-user-resource-free-packages', {
      PageNumber: 1,
      PageSize: 50,
      PackageCodes: pkgCodes,
      Status: [0, 3],
    }, auth);
  } else {
    packages = null;
  }
  const accounts = packages?.data?.Accounts || [];

  // 企业版（MP 链路补全）：summary/free-packages 是免费包语义（Status:[0,3]），企业额度
  // 走 v2 企业用量接口，reset 字段为 cycleResetTime。调用失败/字段缺失不致命——
  // 回落到免费包路径的 reset_at（可能为 null），但打日志，不能让校准链路静默失效。
  let entReset = null;
  if (auth.accountType === 'enterprise') {
    try {
      const ent = await postBilling('/v2/billing/meter/get-enterprise-user-usage', {}, auth);
      const d = ent?.data ?? {};
      entReset = bjIso(
        d.cycleResetTime ?? d.CycleResetTime ?? d.cycle_reset_time ?? null
      );
      if (!entReset) {
        log(`enterprise usage response has no cycleResetTime: ${JSON.stringify(d).slice(0, 200)}`);
      }
    } catch (e) {
      log(`enterprise usage API failed (${e.message}), fall back to free-packages reset_at`);
    }
  }

  const sum = (k) => pkgs.reduce((a, p) => a + (Number(p[k]) || 0), 0);
  const now = Date.now();
  // 重置点取「主包」（CycleTotalCapacity 最大的包）的未来 CycleEndTime——
  // 小包（如全额用尽的体验包）先到期不代表月额度重置，避免误报提前的重置提醒。
  const mainCode = [...pkgs].sort(
    (a, b) => (Number(b.CycleTotalCapacity) || 0) - (Number(a.CycleTotalCapacity) || 0)
  )[0]?.PackageCode;
  const resets = accounts
    .filter((a) => a.PackageCode === mainCode)
    .map((a) => bjIso(a.CycleEndTime))
    .filter((iso) => iso && Date.parse(iso) > now)
    .sort();
  return {
    used: sum('CycleUsedCapacity'),
    limit: sum('CycleTotalCapacity'),
    reset_at: entReset || resets[resets.length - 1] || null, // 企业版优先 cycleResetTime；个人版取主包周期内最晚的重置点（整包重置）
    packages: pkgs.map((p) => ({
      code: p.PackageCode,
      used: Number(p.CycleUsedCapacity) || 0,
      total: Number(p.CycleTotalCapacity) || 0,
      unit: p.CapacityUnit,
    })),
    accounts: accounts.map((a) => ({
      pkg: a.PackageCode,
      end: a.CycleEndTime,
      remain: Number(a.CycleCapacityRemainPrecise ?? a.CycleCapacityRemain) || 0,
    })),
  };
}

const pctOf = (u) => (u.limit > 0 ? (u.used / u.limit) * 100 : null);
const exhaustedOf = (u) => {
  const p = pctOf(u);
  return p !== null ? p >= BOOST_HIGH : false;
};

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
      'User-Agent': 'kimi-quota-reminder-workbuddy-watcher',
      'Content-Type': 'application/json',
    };

    async function sendSignal(eventType, payload) {
      const body = { platform: 'workbuddy', ...payload };
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

    const state = loadState();

    async function runRound() {
      const today = todayStr();
      const daily = state.last_daily_sync !== today;

      let auth;
      try {
        auth = readAuth();
      } catch (e) {
        log(`auth read failed (${e.message}), skip`);
        return { boost: false };
      }
      log(`auth ok (account_type=${auth.accountType}, token len=${auth.token.length}, expiresAt=${auth.expiresAt || '?'})`);

      let u;
      try {
        u = await fetchUsage(auth);
      } catch (e) {
        log(`usage fetch failed (${e.message}), skip this round`);
        return { boost: false };
      }
      if (daily) log('daily re-sync round');
      const pct = pctOf(u);
      log(
        `usage used=${Math.round(u.used)}/${Math.round(u.limit)}` +
          (pct !== null ? ` (${pct.toFixed(1)}%)` : '') +
          ` reset=${u.reset_at || '(unknown)'}` +
          ` packages=${u.packages.length} accounts=${u.accounts.length}` +
          (SUMMARY_JSON ? ` (from ${path.basename(SUMMARY_JSON)})` : '')
      );

      // 每日 23 点：发 quota-close（📴 被动每日快照）。close 与 sync 同 payload，
      // 云端 applySyncWorkbuddy 照样消费；当天已发过则跳过
      const closeDue = new Date().getHours() === 23 && state.last_close_date !== today;

      const reasons = [];
      const prev = state.last_report;
      if (!prev) {
        reasons.push('baseline');
      } else {
        if (u.used !== prev.used || u.limit !== prev.limit) reasons.push('usage changed');
        const prevReset = prev.reset_at ? Date.parse(prev.reset_at) : null;
        const nowReset = u.reset_at ? Date.parse(u.reset_at) : null;
        if (Math.abs((nowReset ?? 0) - (prevReset ?? 0)) > SYNC_TOLERANCE_MS) {
          reasons.push('reset_at changed');
        }
        if (exhaustedOf(u) !== exhaustedOf(prev)) reasons.push('exhaustion flipped');
      }
      if (daily) reasons.push('daily re-sync');

      if (closeDue) {
        log('daily close snapshot round');
        await sendSignal('quota-close', {
          account_type: auth.accountType,
          monthly: { used: u.used, limit: u.limit, reset_at: u.reset_at },
          raw: { packages: u.packages, accounts: u.accounts },
        });
        if (!DRY_RUN) {
          state.last_report = { used: u.used, limit: u.limit, reset_at: u.reset_at };
          state.last_close_date = today;
          if (daily) state.last_daily_sync = today;
        }
      } else if (reasons.length > 0) {
        log(`sync triggered: ${reasons.join('; ')}`);
        await sendSignal('quota-sync', {
          account_type: auth.accountType, // 云端据此门控：企业版才用 reset_at 校准锚点（方案 B）
          monthly: {
            used: u.used,
            limit: u.limit,
            reset_at: u.reset_at,
          },
          raw: { packages: u.packages, accounts: u.accounts },
        });
        if (!DRY_RUN) {
          state.last_report = { used: u.used, limit: u.limit, reset_at: u.reset_at };
          if (daily) state.last_daily_sync = today;
        }
      } else {
        log('no trigger condition met, observe only');
        if (daily && !DRY_RUN) state.last_daily_sync = today;
      }

      const p = pctOf(u);
      const boost = p !== null && p >= BOOST_LOW && p < BOOST_HIGH;
      return { boost, parts: boost ? [`monthly ${p.toFixed(1)}%`] : [] };
    }

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

      writeLock();
      log(`boost dwell: next round in ${Math.round(BOOST_INTERVAL_MS / 1000)}s`);
      await sleep(BOOST_INTERVAL_MS);
      writeLock();
    }
  } finally {
    releaseLock();
  }
}

main().catch((e) => log('error (fail-open):', e.message));
