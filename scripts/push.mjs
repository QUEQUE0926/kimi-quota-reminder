// 四通道推送：企业微信群机器人 + ntfy.sh + Bark（iOS）+ WxPusher SPT（微信服务号）
// 四路独立 try/catch + 每路一次重试（瞬时 5xx/超时兜底），一路失败不挡另一路；
// 缺少某个 secret 时跳过该路。注意「假成功」检查：wecom/bark 都要求 HTTP 2xx 且 body
// 是预期 JSON 格式，错误页（HTML/空 body）必须算 FAIL——否则静默丢消息且日志显示 ok。
// level/ttl 仅 Bark 支持：level 默认 active（亮屏提醒），passive 只进通知列表；
// ttl 为历史记录保存秒数（如 86400 = 1 天）。
import { pathToFileURL } from 'node:url';

// 测试消息打标（方案 §6.1）：非 main 分支运行时，workflow 给脚本注入 PUSH_TEST=1。
// 读到后所有通道标题统一加「[测试] 」前缀，Bark 分组换成「· 测试」——
// 这样同一套 secret / 同一部手机就能把测试推送和真实推送分得清清楚楚。
const TEST = process.env.PUSH_TEST === '1';
const decorate = (t) => (TEST ? `[测试] ${t}` : t);

// Bark 分组（MP 方案 §6）：非 Kimi 平台在分组里带平台标签（如「Kimi Code 额度 · Codex」），
// Kimi 保持原分组不变；测试态再叠加「· 测试」。
const groupFor = (platform) => {
  const base = platform && platform !== 'Kimi Code' ? `Kimi Code 额度 · ${platform}` : 'Kimi Code 额度';
  return TEST ? `${base} · 测试` : base;
};

export async function pushAll({ title, body, level, ttl, platform }) {
  const results = [];
  const pushTitle = decorate(title);
  console.log(`pushAll: ${pushTitle}`);
  console.log(body);

  // 每路一次重试：HTTP 5xx/超时多为瞬时故障，重试一次再判 FAIL
  const withRetry = async (name, fn) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (attempt >= 2) throw e;
        console.log(`${name}: attempt ${attempt} failed (${e.message}), retry in 2s`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  };

  const webhook = process.env.WECOM_WEBHOOK;
  const sendWecom = async () => {
    // 必须用 text：微信插件不支持展示 markdown（方案 §6）
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'text',
        text: { content: `${pushTitle}\n\n${body}` },
      }),
      signal: AbortSignal.timeout(10000),
    });
    // webhook 失效/被拦截时返回 4xx/5xx 或 HTML 错误页——都必须 FAIL，不能吞成 ok
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json(); // 非 JSON 响应让 SyntaxError 冒泡进 FAIL
    if (j.errcode) throw new Error(`errcode=${j.errcode} ${j.errmsg || ''}`);
    return 'wecom: ok';
  };

  const topic = process.env.NTFY_TOPIC;
  const sendNtfy = async () => {
    const res = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: { Title: pushTitle, Priority: '4', Tags: 'white_check_mark' },
      body,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return 'ntfy: ok';
  };

  const barkKey = process.env.BARK_KEY;
  const sendBark = async () => {
    const server = (process.env.BARK_SERVER || 'https://api.day.app').replace(/\/$/, '');
    const res = await fetch(`${server}/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_key: barkKey,
        title: pushTitle,
        body,
        group: groupFor(platform),
        level: level || 'active',
        ...(ttl ? { ttl } : {}),
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json(); // 同上：错误页必须 FAIL
    if (j.code !== 200) throw new Error(`code=${j.code} ${j.message || ''}`);
    return `bark: ok (group=${groupFor(platform)})`;
  };

  // WxPusher（方案 §6 第四路）：服务号会话投递，微信主聊天列表可见。
  // 两种凭据模式，配哪个用哪个：SPT 极简推送（WXPUSHER_SPT），
  // 或标准应用推送（WXPUSHER_APPTOKEN + WXPUSHER_UID）。均等同密码，只存 GitHub Secrets。
  const spt = process.env.WXPUSHER_SPT;
  const wxAppToken = process.env.WXPUSHER_APPTOKEN;
  const wxUid = process.env.WXPUSHER_UID;
  const sendWxPusher = async () => {
    const text = `${pushTitle}\n\n${body}`;
    let res;
    if (spt) {
      // SPT 极简接口是 GET 路径参数：服务端 Tomcat 默认拒绝路径里的编码斜杠 %2F
      // （HTTP 400），把文本中的半角 / 换成全角 ／ 再编码。
      const safeText = text.replace(/\//g, '／');
      res = await fetch(
        `https://wxpusher.zjiecode.com/api/send/message/${encodeURIComponent(spt)}/${encodeURIComponent(safeText)}`,
        { signal: AbortSignal.timeout(10000) }
      );
    } else {
      res = await fetch('https://wxpusher.zjiecode.com/api/send/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appToken: wxAppToken,
          uids: [wxUid],
          summary: pushTitle.slice(0, 100), // 聊天列表预览文字
          content: text,
          contentType: 1, // 1=文本
        }),
        signal: AbortSignal.timeout(10000),
      });
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.text().catch(() => '');
    let j = {};
    try { j = JSON.parse(raw); } catch { /* 非 JSON 返回（如被拦截的 HTML）——下面 code 校验会判 FAIL */ }
    if (j.code !== 1000) throw new Error(`code=${j.code} ${j.msg || ''} http=${res.status} body=${raw.slice(0, 120)}`);
    return 'wxpusher: ok';
  };

  const track = async (name, fn, skipMsg) => {
    if (skipMsg) {
      results.push(skipMsg);
      return;
    }
    try {
      results.push(await withRetry(name, fn));
    } catch (e) {
      results.push(`${name}: FAIL ${e.message}`);
    }
  };

  await track('wecom', sendWecom, webhook ? null : 'wecom: skipped (WECOM_WEBHOOK not set)');
  await track('ntfy', sendNtfy, topic ? null : 'ntfy: skipped (NTFY_TOPIC not set)');
  await track('bark', sendBark, barkKey ? null : 'bark: skipped (BARK_KEY not set)');
  await track(
    'wxpusher',
    sendWxPusher,
    spt || (wxAppToken && wxUid) ? null : 'wxpusher: skipped (WXPUSHER_SPT / WXPUSHER_APPTOKEN+UID not set)'
  );

  for (const r of results) console.log(r);
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const title = process.env.MSG_TITLE || 'Kimi Code 额度提醒';
  const body = process.env.MSG_BODY || '(empty)';
  pushAll({ title, body });
}
