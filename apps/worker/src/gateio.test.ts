import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchTicker,
  fetchCandles,
  fetchContractStats,
  fetchFundingRate,
  checkContractExists,
} from './gateio.js';

/**
 * Gate.io 接入层测试。
 *
 * 重点锁住两个曾经出错的字段语义：
 * - `volume_24h` 是"合约张数"，USDT 成交额必须取 `volume_24h_quote`（审查项 F4）
 * - `contract_stats` 按时间升序返回，必须取最新一条而非 `rows[0]`（审查项 F5）
 * 以及 dev.md 13.1 第 7 条要求的 K 线字段顺序契约。
 */

type FetchMock = ReturnType<typeof vi.fn>;

function jsonResponse(data: unknown, ok = true, status = ok ? 200 : 400): Response {
  return {
    ok,
    status,
    json: async () => data,
  } as unknown as Response;
}

let fetchMock: FetchMock;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fetchTicker 字段映射', () => {
  const baseRow = {
    contract: 'BTC_USDT',
    last: '83274.5',
    change_percentage: '1.09',
    high_24h: '84000',
    low_24h: '82000',
  };

  it('volume24h 取 volume_24h_quote（USDT 成交额），而不是合约张数', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        { ...baseRow, volume_24h: '882011889', volume_24h_quote: '7215640452', volume_24h_base: '88201' },
      ]),
    );
    const t = await fetchTicker('BTC_USDT');
    expect(t.volume24h).toBe(7215640452);
    expect(t.volume24h).not.toBe(882011889);
    expect(t.change24h).toBeCloseTo(0.0109, 10);
    expect(t.high24h).toBe(84000);
    expect(t.last).toBe(83274.5);
  });

  it('volume_24h_quote 缺失时回退 volume_24h_settle', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([{ ...baseRow, volume_24h: '882011889', volume_24h_settle: '7215640452' }]),
    );
    const t = await fetchTicker('BTC_USDT');
    expect(t.volume24h).toBe(7215640452);
  });

  it('只有合约张数时不得把张数当成成交额（宁可返回 0）', async () => {
    fetchMock.mockResolvedValue(jsonResponse([{ ...baseRow, volume_24h: '882011889' }]));
    const t = await fetchTicker('BTC_USDT');
    expect(t.volume24h).toBe(0);
  });

  it('请求 URL 对 symbol 做编码', async () => {
    fetchMock.mockResolvedValue(jsonResponse([{ ...baseRow, volume_24h_quote: '1' }]));
    await fetchTicker('BTC/USDT');
    expect(String(fetchMock.mock.calls[0]![0])).toContain('contract=BTC%2FUSDT');
  });

  it('返回空数组时报错，避免上层拿到假数据', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    await expect(fetchTicker('BTC_USDT')).rejects.toThrow(/empty/);
  });
});

describe('fetchCandles 字段顺序契约（dev.md 13.1 第 7 条）', () => {
  it('按 o/h/l/c/v/t 命名映射，不依赖位置下标', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        { t: 1700000900, o: '101', h: '103', l: '100', c: '102', v: 500, sum: 'x' },
        { t: 1700000000, o: '100', h: '102', l: '99', c: '101', v: 400, sum: 'x' },
      ]),
    );
    const candles = await fetchCandles('BTC_USDT', '15m');
    // 必须按时间升序返回
    expect(candles.map((c) => c.time)).toEqual([1700000000, 1700000900]);
    expect(candles[0]).toMatchObject({ open: 100, high: 102, low: 99, close: 101, volume: 400 });
    // 关键：high 不能等于 low，避免把 low/high 写反
    expect(candles[0]!.high).toBeGreaterThan(candles[0]!.low);
  });

  it('limit 上限被夹到 500', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    await fetchCandles('BTC_USDT', '15m', 5000);
    expect(String(fetchMock.mock.calls[0]![0])).toContain('limit=500');
  });
});

describe('fetchContractStats 取最新记录（审查项 F5）', () => {
  it('Gate.io 按时间升序返回时，取最后一条而非 rows[0]', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        { time: 1791442800, lsr_account: 1.738681179996845 },
        { time: 1791494400, lsr_account: 1.6 },
        { time: 1791547200, lsr_account: 1.443170111942861 },
      ]),
    );
    const s = await fetchContractStats('BTC_USDT');
    expect(s.longShortRatio).toBeCloseTo(1.443170111942861, 10);
    expect(s.longShortRatio).not.toBeCloseTo(1.738681179996845, 6);
  });

  it('即便顺序被打乱也按 time 取最新', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        { time: 1791547200, lsr_account: 9 },
        { time: 1791442800, lsr_account: 1 },
        { time: 1791494400, lsr_account: 5 },
      ]),
    );
    expect((await fetchContractStats('BTC_USDT')).longShortRatio).toBe(9);
  });

  it('lsr_account 缺失时回退 lsr_taker', async () => {
    fetchMock.mockResolvedValue(jsonResponse([{ time: 1, lsr_taker: 2.5 }]));
    expect((await fetchContractStats('BTC_USDT')).longShortRatio).toBe(2.5);
  });

  it('空数组或字段非法时退化为中性 1', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    expect((await fetchContractStats('BTC_USDT')).longShortRatio).toBe(1);
    fetchMock.mockResolvedValue(jsonResponse([{ time: 1, lsr_account: null }]));
    expect((await fetchContractStats('BTC_USDT')).longShortRatio).toBe(1);
  });
});

describe('fetchFundingRate', () => {
  it('解析 funding_rate（小数）', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ funding_rate: '-0.000044', funding_interval: 28800 }));
    const f = await fetchFundingRate('BTC_USDT');
    expect(f.fundingRate).toBeCloseTo(-0.000044, 12);
    expect(f.symbol).toBe('BTC_USDT');
  });

  it('字段缺失或非法时抛错，交由上层走降级', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await expect(fetchFundingRate('BTC_USDT')).rejects.toThrow(/malformed/);
  });
});

describe('checkContractExists', () => {
  it('200 时视为存在', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'trading' }));
    expect(await checkContractExists('BTC_USDT')).toBe(true);
  });

  it('400（CONTRACT_NOT_FOUND）时视为不存在', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ label: 'CONTRACT_NOT_FOUND' }, false, 400));
    expect(await checkContractExists('NOPE_USDT')).toBe(false);
  });

  it('网络异常时视为不存在，不抛出', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    expect(await checkContractExists('BTC_USDT')).toBe(false);
  });
});

describe('fetchWithRetry 重试语义（dev.md 3.2：超时 5s，重试 1 次）', () => {
  it('首次失败、第二次成功时返回成功结果', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ label: 'err' }, false, 500))
      .mockResolvedValueOnce(jsonResponse({ funding_rate: '0.0001' }));
    const f = await fetchFundingRate('BTC_USDT');
    expect(f.fundingRate).toBeCloseTo(0.0001, 12);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('连续失败则抛出上游错误', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ label: 'err' }, false, 503));
    await expect(fetchFundingRate('BTC_USDT')).rejects.toThrow(/Gate\.io 503/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
