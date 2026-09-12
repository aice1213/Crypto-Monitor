import { describe, it, expect } from 'vitest';
import { getMemory, setMemory, setStale, getStale } from './cache.js';
import { rateLimit, withDedup } from './ratelimit.js';
import { normalizeAndValidate } from '@crypto-monitor/shared';

describe('cache', () => {
  it('memory cache 写入与读取', () => {
    setMemory('test:1', { a: 1 }, 100);
    expect(getMemory<{ a: number }>('test:1')).toEqual({ a: 1 });
  });

  it('stale 降级缓存可返回', () => {
    setStale('stale:1', { b: 2 });
    const r = getStale<{ b: number }>('stale:1');
    expect(r).not.toBeNull();
    expect(r!.data).toEqual({ b: 2 });
    expect(r!.stale).toBe(true);
  });
});

describe('ratelimit', () => {
  it('令牌桶初始 burst 可消费', () => {
    const results: boolean[] = [];
    for (let i = 0; i < 25; i++) results.push(rateLimit());
    expect(results.filter(Boolean).length).toBeGreaterThanOrEqual(20);
  });

  it('withDedup 并发请求合并', async () => {
    let callCount = 0;
    const fn = () =>
      new Promise<number>((resolve) => {
        callCount++;
        setTimeout(() => resolve(42), 10);
      });
    const [a, b] = await Promise.all([
      withDedup('dedup:1', fn),
      withDedup('dedup:1', fn),
    ]);
    expect(a).toBe(42);
    expect(b).toBe(42);
    expect(callCount).toBe(1);
  });
});

describe('symbol normalization', () => {
  it('BTC -> BTC_USDT', () => {
    expect(normalizeAndValidate('BTC').symbol).toBe('BTC_USDT');
  });
  it('btcusdt -> BTC_USDT', () => {
    expect(normalizeAndValidate('btcusdt').symbol).toBe('BTC_USDT');
  });
  it('btc-usdt -> BTC_USDT', () => {
    expect(normalizeAndValidate('btc-usdt').symbol).toBe('BTC_USDT');
  });
  it('无效符号返回 valid=false', () => {
    expect(normalizeAndValidate('!!!').valid).toBe(false);
  });
});
