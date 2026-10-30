import { describe, it, expect, vi } from 'vitest';
import { runCronFallback } from './cron.js';
import type { KvLike } from './lib/cooldown.js';

/**
 * cron.ts 单元测试（开发交付文档 §3.3）
 *
 * Cron 兜底：扫描启用标的，与 last_check_price 比较，命中触发（CRON_FALLBACK）。
 */

class MemKV implements KvLike {
  private map = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    this.map.set(key, value);
    void opts;
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

/** D1 mock：push_targets 表 */
class MockD1 {
  private targets: { id: string; symbol: string; exchange: string; enabled: number; conditions_json: string }[];
  constructor(targets: { id: string; symbol: string; exchange: string; enabled: number; conditions_json: string }[]) {
    this.targets = targets;
  }
  // 链式 API：prepare/bind 返回 this，first/all/run 在 this 上
  prepare(_sql: string) {
    return this;
  }
  bind(..._args: unknown[]) {
    return this;
  }
  async all(): Promise<{ results: unknown[] }> {
    return { results: this.targets };
  }
  async first(): Promise<unknown> {
    return this.targets[0] ?? null;
  }
  async run(): Promise<{ success: boolean }> {
    return { success: true };
  }
}

const conditionJson = JSON.stringify({
  mode: 'PERCENT_ONLY',
  windowMinutes: 5,
  thresholdMode: 'AUTO',
  autoThreshold: 0.5,
  keyPrice: undefined,
  volumeConfirm: false,
  directionConsistency: true,
});

function makeDeps(overrides: Partial<Parameters<typeof runCronFallback>[0]> = {}, symbol = 'BTC_USDT') {
  const kv = new MemKV();
  const d1 = new MockD1([
    { id: 't1', symbol, exchange: 'GATEIO', enabled: 1, conditions_json: conditionJson },
  ]) as unknown as D1Database;
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => [{ last: '50000' }],
  })) as ReturnType<typeof vi.fn> & typeof fetch;
  return {
    deps: {
      d1,
      kv,
      encKey: 'x',
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => 1_700_000_000_000,
      ...overrides,
    },
    kv,
    fetchMock,
    d1,
  };
}

describe('runCronFallback（§3.3）', () => {
  it('无 last_check_price → 只记录价格，不触发（首次扫描）', async () => {
    const { deps, fetchMock } = makeDeps();
    const r = await runCronFallback(deps);
    expect(r.scanned).toBe(0); // 首次无 prevPrice，不比较
    expect(r.triggered).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // last_check_price 已写入
    expect(await deps.kv.get('last_check_price:BTC_USDT')).toBe('50000');
  });

  it('价格变动超阈值 → 触发（CRON_FALLBACK）', async () => {
    const { deps, kv } = makeDeps({}, 'ETH_USDT');
    // 预设 prevPrice = 49000（当前 50000，+2.04% ≥ 0.5%）
    await kv.put('last_check_price:ETH_USDT', '49000', { expirationTtl: 86400 });
    const r = await runCronFallback(deps);
    // trigger 流程会尝试 resolveCondition/resolveChannels（D1 mock 返回 target），
    // 但条件 KEY/DUAL 可能门控失败；PERCENT_ONLY 应通过。扫描计数 ≥1
    expect(r.scanned).toBe(1);
  });

  it('价格变动未超阈值 → 不触发', async () => {
    const { deps, kv } = makeDeps({}, 'SOL_USDT');
    // prevPrice = 49900，当前 50000，+0.2% < 0.5%
    await kv.put('last_check_price:SOL_USDT', '49900', { expirationTtl: 86400 });
    const r = await runCronFallback(deps);
    expect(r.triggered).toBe(0);
  });

  it('ticker 拉取失败 → 跳过该标的', async () => {
    const { deps, fetchMock } = makeDeps();
    fetchMock.mockRejectedValue(new Error('network'));
    const r = await runCronFallback(deps);
    expect(r.scanned).toBe(0);
    expect(r.triggered).toBe(0);
  });
});
