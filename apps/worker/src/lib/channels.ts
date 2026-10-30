/**
 * 推送通道适配（开发交付文档 §6、§8）
 *
 * - 钉钉：Webhook Markdown（msgtype: markdown），加签 HMAC-SHA256
 * - 飞书：交互式卡片（msg_type: interactive），签名 HMAC-SHA256
 * - 文案：统一模板（§8），关键词模式下标题以关键词开头
 * - 返回结构供调用方记录 PushLogDto.result
 *
 * 纯函数 + fetch 注入：不直接依赖全局 fetch（可测），签名与文案均可向量对拍。
 */
import { PUSH_RETRY_BACKOFF_SEC } from '@crypto-monitor/shared';

/** 推送消息数据（§8 模板字段） */
export interface PushMessageData {
  symbol: string;
  price: number;
  keyPrice: number | null;
  changePercent: number;
  thresholdUsed: number;
  multiplierUsed: number | null;
  triggerMode: string;
  emaState: string;
  trend: string;
  /** 触发时间（秒） */
  timeSec: number;
  keyword?: string;
}

/** 通道发送结果 */
export interface ChannelSendResult {
  ok: boolean;
  /** 通道返回的错误码（钉钉 errcode / 飞书 code），用于识别签名错误 */
  errorCode?: number;
  errorMsg?: string;
  status?: number;
}

/** 通道配置（解密后的运行时形状） */
export interface RuntimeChannel {
  type: 'DINGTALK' | 'FEISHU';
  webhook: string;
  secret?: string;
  keyword?: string;
  securityType: 'SIGN' | 'KEYWORD' | 'IP';
}

/** 加签（§6.1 钉钉 / §6.2 飞书）。钉钉：Base64(HMAC-SHA256(timestamp+"\n"+secret)) 后 URL 编码。 */
export async function signRequest(
  secret: string,
  timestampMs: number,
  urlEncode: boolean,
): Promise<string> {
  const key = new TextEncoder().encode(secret);
  const data = new TextEncoder().encode(`${timestampMs}\n${secret}`);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, data);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return urlEncode ? encodeURIComponent(b64) : b64;
}

/** 格式化触发时间（UTC，§8 模板：YYYY-MM-DD HH:mm:ss）。worker 运行于 UTC，用 UTC 方法保证确定性。 */
export function formatTime(timeSec: number): string {
  const d = new Date(timeSec * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(
    d.getUTCHours(),
  )}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** 触发模式中文文案（§8） */
export function triggerModeText(mode: string): string {
  switch (mode) {
    case 'PERCENT_ONLY':
      return '波动幅度';
    case 'KEY_CONFIRM':
      return '关键位确认';
    case 'DUAL_CONFIRM':
      return '双条件';
    default:
      return mode;
  }
}

/** EMA 状态中文（§8） */
function emaStateText(state: string): string {
  if (state === 'BULLISH' || state === '多头') return '多头';
  if (state === 'BEARISH' || state === '空头') return '空头';
  return '纠缠';
}

/** 趋势方向中文（§8） */
function trendText(trend: string): string {
  if (trend === 'BULLISH' || trend === '上涨') return '上涨';
  if (trend === 'BEARISH' || trend === '下跌') return '下跌';
  return '震荡';
}

/**
 * 生成推送文案（§8 统一模板）。
 * 关键词模式：标题以 keyword 开头。
 */
export function buildPushText(data: PushMessageData): { title: string; text: string } {
  const kw = data.keyword ?? '价格异动预警';
  const title = `🔔 ${kw} ${data.symbol}`;
  const sign = data.changePercent >= 0 ? '+' : '';
  const lines = [
    `触发时间: ${formatTime(data.timeSec)}`,
    `${data.symbol} 当前价 ${fmtPrice(data.price)}，关键价位 ${
      data.keyPrice != null ? fmtPrice(data.keyPrice) : '—'
    }，涨幅 ${sign}${data.changePercent.toFixed(2)}%`,
    `触发阈值: ${data.thresholdUsed.toFixed(2)}%${
      data.multiplierUsed != null ? `（20日波动率×${data.multiplierUsed.toFixed(2)}）` : ''
    }`,
    `触发模式: ${triggerModeText(data.triggerMode)}`,
    `EMA结构：${emaStateText(data.emaState)} | 趋势方向：${trendText(data.trend)}`,
  ];
  return { title, text: lines.join('\n') };
}

/** 价格格式化（§8 PRICE 示例 $80,269.52） */
function fmtPrice(v: number): string {
  // 4 位小数（与看板一致，价格<0.01 时 6 位）
  const digits = v < 0.01 ? 6 : 4;
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/**
 * 构建钉钉请求体（§6.1）。
 * - Markdown：msgtype=markdown，title=标题，text=正文
 * - 加签：timestamp + sign 查询参数（§6.1 安全）
 */
export async function buildDingTalkBody(
  data: PushMessageData,
  channel: RuntimeChannel,
): Promise<{ url: string; body: Record<string, unknown> }> {
  const { title, text } = buildPushText(data);
  const body: Record<string, unknown> = {
    msgtype: 'markdown',
    markdown: { title, text },
  };
  let url = channel.webhook;
  if (channel.secret && channel.securityType === 'SIGN') {
    const ts = Date.now();
    const sign = await signRequest(channel.secret, ts, true);
    url = `${channel.webhook}${channel.webhook.includes('?') ? '&' : '?'}timestamp=${ts}&sign=${sign}`;
  }
  return { url, body };
}

/**
 * 构建飞书请求体（§6.2）。
 * - 交互式卡片：msg_type=interactive，卡片含"查看详情"按钮
 * - 签名：timestamp + sign 字段在请求体
 */
export async function buildFeishuBody(
  data: PushMessageData,
  channel: RuntimeChannel,
): Promise<{ url: string; body: Record<string, unknown> }> {
  const { title, text } = buildPushText(data);
  const timestamp = Math.floor(Date.now() / 1000);
  const body: Record<string, unknown> = {
    msg_type: 'interactive',
    card: {
      header: { title: { tag: 'plain_text', content: title }, template: 'orange' },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: text } },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '查看详情' },
              type: 'primary',
              url: `/detail?symbol=${data.symbol}_USDT`,
            },
          ],
        },
      ],
    },
  };
  if (channel.secret && channel.securityType === 'SIGN') {
    const sign = await signRequest(channel.secret, timestamp, false);
    body.timestamp = String(timestamp);
    body.sign = sign;
  }
  return { url: channel.webhook, body };
}

/** 发送到通道，带指数退避重试（§11：1s/3s/9s，最多 3 次）。backoffSec 可注入（测试用 [0,0,0]）。 */
export async function sendToChannel(
  url: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
  backoffSec: number[] = PUSH_RETRY_BACKOFF_SEC,
): Promise<ChannelSendResult> {
  let lastErr: ChannelSendResult = { ok: false, errorMsg: 'unknown' };
  for (let attempt = 0; attempt <= backoffSec.length; attempt++) {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const raw = await res.text();
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // 非 JSON 响应
      }
      const errcode = typeof parsed.errcode === 'number' ? parsed.errcode : undefined;
      const code = typeof parsed.code === 'number' ? parsed.code : undefined;
      const errcodeFinal = errcode ?? code;
      // 钉钉 errcode=0 成功；飞书 code=0 成功
      if (res.ok && (errcodeFinal === undefined || errcodeFinal === 0)) {
        return { ok: true, status: res.status };
      }
      lastErr = {
        ok: false,
        status: res.status,
        errorCode: errcodeFinal,
        errorMsg: (parsed.errmsg as string) ?? (parsed.msg as string) ?? raw.slice(0, 200),
      };
    } catch (e) {
      lastErr = { ok: false, errorMsg: (e as Error).message };
    }
    if (attempt < backoffSec.length) {
      await new Promise((r) => setTimeout(r, backoffSec[attempt] * 1000));
    }
  }
  return lastErr;
}

/** 判断是否签名错误（§6.4：钉钉 310000 / 飞书 19021 类） */
export function isSignatureError(result: ChannelSendResult): boolean {
  return result.errorCode === 310000 || result.errorCode === 19021;
}
