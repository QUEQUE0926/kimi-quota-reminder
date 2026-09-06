// 四通道推送：企业微信群机器人 + ntfy.sh + Bark（iOS）+ WxPusher SPT（微信服务号）
// 三路独立 try/catch，一路失败不挡另一路；缺少某个 secret 时跳过该路。
// level/ttl 仅 Bark 支持：level 默认 active（亮屏提醒），passive 只进通知列表；
// ttl 为历史记录保存秒数（如 86400 = 1 天）。
import { pathToFileURL } from 'node:url';

// 测试消息打标（方案 §6.1）：非 main 分支运行时，workflow 给脚本注入 PUSH_TEST=1。
// 读到后所有通道标题统一加「[测试] 」前缀，Bark 分组换成「· 测试」——
// 这样同一套 secret / 同一部手机就能把测试推送和真实推送分得清清楚楚。
const TEST = process.env.PUSH_TEST === '1';
const GROUP = TEST ? 'Kimi Code 额度 · 测试' : 'Kimi Code 额度';
const decorate = (t) => (TEST ? `[测试] ${t}` : t);

export async function pushAll({ title, body, level, ttl }) {
  const results = [];
  const pushTitle = decorate(title);

  const webhook = process.env.WECOM_WEBHOOK;
  if (webhook) {
    try {
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
      const j = await res.json().catch(() => ({}));
      if (j.errcode) throw new Error(`errcode=${j.errcode} ${j.errmsg || ''}`);
      results.push('wecom: ok');
    } catch (e) {
      results.push(`wecom: FAIL ${e.message}`);
    }
  } else {
    results.push('wecom: skipped (WECOM_WEBHOOK not set)');
  }

  const topic = process.env.NTFY_TOPIC;
  if (topic) {
    try {
      const res = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
        method: 'POST',
        headers: { Title: pushTitle, Priority: '4', Tags: 'white_check_mark' },
        body,
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      results.push('ntfy: ok');
    } catch (e) {
      results.push(`ntfy: FAIL ${e.message}`);
    }
  } else {
    results.push('ntfy: skipped (NTFY_TOPIC not set)');
  }

  const barkKey = process.env.BARK_KEY;
  if (barkKey) {
    try {
      const server = (process.env.BARK_SERVER || 'https://api.day.app').replace(/\/$/, '');
      const res = await fetch(`${server}/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_key: barkKey,
          title: pushTitle,
          body,
          group: GROUP,
          level: level || 'active',
          ...(ttl ? { ttl } : {}),
        }),
        signal: AbortSignal.timeout(10000),
      });
      const j = await res.json().catch(() => ({}));
      if (j.code !== 200) throw new Error(`code=${j.code} ${j.message || ''}`);
      results.push('bark: ok');
    } catch (e) {
      results.push(`bark: FAIL ${e.message}`);
    }
  } else {
    results.push('bark: skipped (BARK_KEY not set)');
  }

  // WxPusher 极简推送 SPT（方案 §6 第四路）：服务号会话投递，微信主聊天列表可见。
  // SPT 等同密码，只存 GitHub Secrets，不进任何仓库文件。
  const spt = process.env.WXPUSHER_SPT;
  if (spt) {
    try {
      const text = `${pushTitle}\n\n${body}`;
      const res = await fetch(
        `https://wxpusher.zjiecode.com/api/send/message/${encodeURIComponent(spt)}/${encodeURIComponent(text)}`,
        { signal: AbortSignal.timeout(10000) }
      );
      const j = await res.json().catch(() => ({}));
      if (j.code !== 1000) throw new Error(`code=${j.code} ${j.msg || ''}`);
      results.push('wxpusher: ok');
    } catch (e) {
      results.push(`wxpusher: FAIL ${e.message}`);
    }
  } else {
    results.push('wxpusher: skipped (WXPUSHER_SPT not set)');
  }

  for (const r of results) console.log(r);
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const title = process.env.MSG_TITLE || 'Kimi Code 额度提醒';
  const body = process.env.MSG_BODY || '(empty)';
  pushAll({ title, body });
}
