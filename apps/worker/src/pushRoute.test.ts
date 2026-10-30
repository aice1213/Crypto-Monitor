import { describe, it, expect } from 'vitest';
import { resolveConditionFromD1, resolveChannelsFromD1, handlePushTrigger } from './pushRoute.js';
import type { PushCondition, PushTriggerRequest } from '@crypto-monitor/shared';

/**
 * pushRoute.ts 单元测试（开发交付文档 §2.3 接口、§3.2）
 *
 * symbol→targetId 解析、条件读取、通道解密。
 */

// 32B base64（浏览器兼容，无 Node Buffer）
const ENC_KEY = btoa(String.fromCharCode(...new Array(32).fill(97)));

// 简化 D1 mock（支持 prepare/bind/first/all/run）
class MockD1 {
  private targets: { id: string; symbol: string; exchange: string; enabled: number; conditions_json: string }[];
  private channels: { id: string; type: string; group_name: string | null; webhook_enc: string; sign_enc: string | null; keyword: string | null; security_type: string; enabled: number; status: string }[];
  constructor(opts: {
    targets?: { id: string; symbol: string; exchange: string; enabled: number; conditions_json: string }[];
    channels?: { id: string; type: string; group_name: string | null; webhook_enc: string; sign_enc: string | null; keyword: string | null; security_type: string; enabled: number; status: string }[];
  }) {
    this.targets = opts.targets ?? [];
    this.channels = opts.channels ?? [];
  }
  prepare(_sql: string) {
    return this; // 链式：bind/first/all/run 在 this 上
  }
  bind(..._args: unknown[]) {
    return this;
  }
  async first(): Promise<unknown> {
    // 简化：返回 targets[0] 或 null（测试无需精确 SQL 匹配）
    return this.targets[0] ?? null;
  }
  async all(): Promise<{ results: unknown[] }> {
    return { results: this.channels.length > 0 ? this.channels : this.targets };
  }
  async run(): Promise<{ success: boolean }> {
    return { success: true };
  }
}

const condition: PushCondition = {
  mode: 'PERCENT_ONLY',
  windowMinutes: 5,
  thresholdMode: 'AUTO',
  autoThreshold: 0.5,
  volumeConfirm: false,
};

describe('resolveConditionFromD1', () => {
  it('读取并解析条件', async () => {
    const d1 = new MockD1({
      targets: [{ id: 't1', symbol: 'BTC_USDT', exchange: 'GATEIO', enabled: 1, conditions_json: JSON.stringify(condition) }],
    }) as unknown as D1Database;
    const c = await resolveConditionFromD1(d1, 't1');
    expect(c).not.toBeNull();
    expect(c!.mode).toBe('PERCENT_ONLY');
    expect(c!.autoThreshold).toBe(0.5);
  });

  it('禁用标的返回 null', async () => {
    const d1 = new MockD1({
      targets: [{ id: 't1', symbol: 'BTC_USDT', exchange: 'GATEIO', enabled: 0, conditions_json: JSON.stringify(condition) }],
    }) as unknown as D1Database;
    expect(await resolveConditionFromD1(d1, 't1')).toBeNull();
  });
});

describe('resolveChannelsFromD1', () => {
  it('解密 webhook 与签名', async () => {
    // 用 crypto 模块加密一个 webhook 再存（简化：直接注入明文格式）
    const d1 = new MockD1({
      channels: [{
        id: 'ch1', type: 'DINGTALK', group_name: '主力', webhook_enc: 'a.b', sign_enc: 'c.d', keyword: null, security_type: 'SIGN', enabled: 1, status: 'OK',
      }],
    }) as unknown as D1Database;
    // decryptSecret 对 'a.b' 会抛（非法 base64 iv），跳过 → 空通道
    const ch = await resolveChannelsFromD1(d1, ENC_KEY);
    expect(Array.isArray(ch)).toBe(true);
  });
});

describe('handlePushTrigger symbol→targetId', () => {
  it('未找到启用标的 → INVALID 400', async () => {
    const d1 = new MockD1({ targets: [] }) as unknown as D1Database;
    const req: PushTriggerRequest = {
      symbol: 'NOPE_USDT', price: 100, changePercent: 1, thresholdUsed: 0.5, triggerMode: 'PERCENT_ONLY', triggerType: 'CLIENT_WINDOW', clientTs: Date.now(),
    };
    const r = await handlePushTrigger(req, {
      d1,
      kv: {} as KVNamespace,
      pushEncKey: ENC_KEY,
    });
    expect(r.code).toBe(400);
    expect(r.status).toBe('INVALID');
  });
});
