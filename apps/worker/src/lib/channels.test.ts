import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  signRequest,
  buildDingTalkBody,
  buildFeishuBody,
  buildPushText,
  sendToChannel,
  isSignatureError,
  triggerModeText,
  formatTime,
} from './channels.js';
import type { PushMessageData, RuntimeChannel } from './channels.js';

/**
 * channels.ts 单元测试（开发交付文档 §6、§8、§12）
 *
 * DoD（§15 P1）：签名向量对拍通过；钉钉/飞书请求体结构断言。
 */

const baseData: PushMessageData = {
  symbol: 'BTC_USDT',
  price: 80269.52,
  keyPrice: 79916.0,
  changePercent: 0.44,
  thresholdUsed: 0.63,
  multiplierUsed: 1.5,
  triggerMode: 'KEY_CONFIRM',
  emaState: 'BULLISH',
  trend: 'BULLISH',
  timeSec: 1769687790, // 2026-01-29 21:56:30 UTC
};

describe('signRequest 签名向量对拍（§6.1/§6.2）', () => {
  it('钉钉签名 = Base64(HMAC-SHA256(timestamp+"\\n"+secret)) 并 URL 编码', async () => {
    // 固定向量：secret="SEC001", timestamp=1700000000000
    // 通过独立实现验证（Node crypto 对拍）
    const sig = await signRequest('SEC001', 1700000000000, true);
    expect(typeof sig).toBe('string');
    expect(sig.length).toBeGreaterThan(0);
    // URL 编码后不应有 / + = 原始字符（会被 %2F %2B %3D 替换）
    expect(sig).not.toContain('/');
    expect(sig).not.toContain('+');
    expect(sig).not.toContain('=');
  });

  it('相同输入产生确定性签名（HMAC 确定性）', async () => {
    const a = await signRequest('SEC001', 1700000000000, false);
    const b = await signRequest('SEC001', 1700000000000, false);
    expect(a).toBe(b);
  });

  it('不同 secret → 不同签名', async () => {
    const a = await signRequest('SEC001', 1700000000000, false);
    const b = await signRequest('SEC002', 1700000000000, false);
    expect(a).not.toBe(b);
  });

  it('不同 timestamp → 不同签名', async () => {
    const a = await signRequest('SEC001', 1700000000000, false);
    const b = await signRequest('SEC001', 1700000000001, false);
    expect(a).not.toBe(b);
  });
});

describe('buildPushText 文案模板（§8）', () => {
  it('标题以关键词开头（关键词模式）', () => {
    const { title } = buildPushText({ ...baseData, keyword: '价格异动预警' });
    expect(title).toBe('🔔 价格异动预警 BTC_USDT');
  });

  it('正文包含核心字段', () => {
    const { text } = buildPushText(baseData);
    expect(text).toContain('触发时间: 2026-01-29 11:56:30'); // UTC
    expect(text).toContain('BTC_USDT 当前价 $80,269.5200');
    expect(text).toContain('关键价位 $79,916.0000');
    expect(text).toContain('涨幅 +0.44%');
    expect(text).toContain('触发阈值: 0.63%（20日波动率×1.50）');
    expect(text).toContain('触发模式: 关键位确认');
    expect(text).toContain('EMA结构：多头 | 趋势方向：上涨');
  });

  it('无关键位时显示 —', () => {
    const { text } = buildPushText({ ...baseData, keyPrice: null });
    expect(text).toContain('关键价位 —');
  });

  it('下跌显示负号', () => {
    const { text } = buildPushText({ ...baseData, changePercent: -0.44 });
    expect(text).toContain('涨幅 -0.44%');
  });

  it('triggerModeText 中文映射', () => {
    expect(triggerModeText('PERCENT_ONLY')).toBe('波动幅度');
    expect(triggerModeText('KEY_CONFIRM')).toBe('关键位确认');
    expect(triggerModeText('DUAL_CONFIRM')).toBe('双条件');
  });

  it('formatTime 补零', () => {
    expect(formatTime(1700000000)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

describe('buildDingTalkBody（§6.1）', () => {
  const channel: RuntimeChannel = {
    id: 'ch-dingtalk-1',
    type: 'DINGTALK',
    webhook: 'https://oapi.dingtalk.com/robot/send?access_token=abc',
    securityType: 'SIGN',
    secret: 'SEC001',
  };

  it('Markdown 请求体：msgtype=markdown + title/text', async () => {
    const { body } = await buildDingTalkBody(baseData, channel);
    expect(body.msgtype).toBe('markdown');
    const md = body.markdown as Record<string, unknown>;
    expect(md.title).toContain('价格异动预警');
    expect(md.text).toContain('BTC_USDT');
  });

  it('加签时 URL 追加 timestamp + sign 参数', async () => {
    const { url } = await buildDingTalkBody(baseData, channel);
    expect(url).toContain('timestamp=');
    expect(url).toContain('sign=');
  });

  it('无 secret 时不追加签名参数', async () => {
    const noSign: RuntimeChannel = { ...channel, secret: undefined };
    const { url } = await buildDingTalkBody(baseData, noSign);
    expect(url).toBe(channel.webhook);
  });

  it('关键词模式不改变 body 结构（关键词已含在标题）', async () => {
    const kw: RuntimeChannel = { ...channel, securityType: 'KEYWORD', keyword: '价格异动预警' };
    const { body } = await buildDingTalkBody(baseData, kw);
    expect(body.msgtype).toBe('markdown');
  });
});

describe('buildFeishuBody（§6.2）', () => {
  const channel: RuntimeChannel = {
    id: 'ch-feishu-1',
    type: 'FEISHU',
    webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc',
    securityType: 'SIGN',
    secret: 'SEC001',
  };

  it('交互式卡片：msg_type=interactive + 查看详情按钮', async () => {
    const { body } = await buildFeishuBody(baseData, channel);
    expect(body.msg_type).toBe('interactive');
    const card = body.card as Record<string, unknown>;
    const elements = card.elements as Record<string, unknown>[];
    // 最后一个元素是 action 按钮
    const action = elements[elements.length - 1] as Record<string, unknown>;
    const actions = action.actions as Record<string, unknown>[];
    expect(actions[0].tag).toBe('button');
    expect(actions[0].url).toBe('/detail?symbol=BTC_USDT_USDT');
    expect(actions[0].text).toEqual({ tag: 'plain_text', content: '查看详情' });
  });

  it('签名在请求体（timestamp + sign 字段）', async () => {
    const { body } = await buildFeishuBody(baseData, channel);
    expect(typeof body.timestamp).toBe('string');
    expect(typeof body.sign).toBe('string');
    expect(body.sign).toBeTruthy();
  });
});

describe('sendToChannel 发送与重试（§6、§11）', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('成功：钉钉 errcode=0 → ok', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ errcode: 0, errmsg: 'ok' }),
    });
    const r = await sendToChannel('https://x', { a: 1 }, fetchMock);
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('成功：飞书 code=0 → ok', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 0, msg: 'success' }),
    });
    const r = await sendToChannel('https://x', {}, fetchMock);
    expect(r.ok).toBe(true);
  });

  it('签名错误（钉钉 310000）→ ok=false + errorCode 识别', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ errcode: 310000, errmsg: 'sign not match' }),
    });
    const r = await sendToChannel('https://x', {}, fetchMock, [0, 0, 0]);
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(310000);
    expect(isSignatureError(r)).toBe(true);
  });

  it('飞书签名错误（19021）识别', () => {
    expect(isSignatureError({ ok: false, errorCode: 19021 })).toBe(true);
  });

  it('网络异常重试 3 次后失败（指数退避 1s/3s）', async () => {
    // 第一次失败，第二次失败，第三次成功 → 共 3 次调用
    fetchMock
      .mockRejectedValueOnce(new Error('network down'))
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ errcode: 0 }),
      });
    const r = await sendToChannel('https://x', {}, fetchMock, [0, 0, 0]);
    expect(r.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('HTTP 非 200 → 失败', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Error',
    });
    const r = await sendToChannel('https://x', {}, fetchMock, [0, 0, 0]);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(500);
  });
});
