import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CandleDto } from '@crypto-monitor/shared';

/**
 * Worker 路由层测试。
 *
 * 覆盖审查项 F27（CORS 白名单未生效）与 F28（interval 未校验、缓存 key 不含 limit、
 * candles 缺少 last-known-good 降级）。
 *
 * 注意：`rateLimit()` 用的是模块级令牌桶（容量 20），因此本文件内的请求次数需保持克制；
 * 每个测试文件有独立的模块实例，不会与 worker.test.ts 互相影响。
 */

// 用 spy 包住真实的缓存实现，以便断言 candles 分支确实写入了降级缓存
vi.mock('./cache.js', async () => {
  const actual = await vi.importActual<typeof import('./cache.js')>('./cache.js');
  return {
    ...actual,
    setStale: vi.fn(actual.setStale),
    getStale: vi.fn(actual.getStale),
  };
});

import worker from './index.js';
import * as cache from './cache.js';

type FetchMock = ReturnType<typeof vi.fn>;
let fetchMock: FetchMock;

/** 供 KV 绑定使用的空实现（always miss），让 getCached 走内存层 */
const emptyKV = {
  get: async () => null,
  put: async () => undefined,
} as unknown as KVNamespace;

function makeEnv(over: Partial<Record<string, unknown>> = {}) {
  return {
    CRYPTO_CACHE: emptyKV,
    GATEIO_BASE: 'https://api.gateio.ws',
    ALLOWED_ORIGINS: '',
    ...over,
  } as unknown as Parameters<typeof worker.fetch>[1];
}

function jsonResponse(data: unknown, ok = true, status = ok ? 200 : 400): Response {
  return { ok, status, json: async () => data } as unknown as Response;
}

async function call(path: string, init?: RequestInit & { origin?: string }) {
  const headers = new Headers(init?.headers);
  if (init?.origin) headers.set('Origin', init.origin);
  const req = new Request(`https://worker.test${path}`, { ...init, headers });
  return worker.fetch(req, makeEnv());
}

/** 一段合法的最小 K 线响应 */
const candleRows = (n = 40) =>
  Array.from({ length: n }, (_, i) => ({
    t: 1_700_000_000 + i * 900,
    o: '100',
    h: '101',
    l: '99',
    c: '100',
    v: 1000,
    sum: 'x',
  }));

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.mocked(cache.setStale).mockClear();
  vi.mocked(cache.getStale).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('candles 路由：interval 白名单校验（F28）', () => {
  it('未登记的周期返回 400，且不触达上游', async () => {
    const res = await call('/api/candles/AAA_USDT?interval=7d');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: number; msg?: string };
    expect(body.code).toBe(400);
    expect(body.msg).toContain('不支持的周期');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('注入型 interval 被拒（不会拼进上游 URL）', async () => {
    const res = await call('/api/candles/AAB_USDT?interval=1m%26limit=999');
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Home 页需要的 1h 属于白名单，可正常请求', async () => {
    fetchMock.mockResolvedValue(jsonResponse(candleRows()));
    const res = await call('/api/candles/AAC_USDT?interval=1h&limit=200');
    expect(res.status).toBe(200);
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('interval=1h');
    const body = (await res.json()) as { data: { snapshot: { dataQuality: string } } };
    // 1h 已被 INTERVAL_SEC 登记 => 不应恒为 INSUFFICIENT
    expect(body.data.snapshot.dataQuality).not.toBe('INSUFFICIENT');
  });

  it('缺省周期为 15m', async () => {
    fetchMock.mockResolvedValue(jsonResponse(candleRows()));
    await call('/api/candles/AAD_USDT');
    expect(String(fetchMock.mock.calls[0]![0])).toContain('interval=15m');
  });
});

// 说明：内存缓存是模块级共享状态，因此每个用例都使用**不同的 symbol**，
// 否则前一个用例写入的缓存会让后一个用例不再触达上游。
describe('candles 路由：limit 夹取与缓存维度（F28）', () => {
  it('limit 超过 500 被夹到 500', async () => {
    fetchMock.mockResolvedValue(jsonResponse(candleRows()));
    await call('/api/candles/BBB_USDT?interval=15m&limit=9999');
    expect(String(fetchMock.mock.calls[0]![0])).toContain('limit=500');
  });

  it('limit 非法时退回 200', async () => {
    fetchMock.mockResolvedValue(jsonResponse(candleRows()));
    await call('/api/candles/BB C_USDT'.replace(' ', '') + '?interval=15m&limit=abc');
    expect(String(fetchMock.mock.calls[0]![0])).toContain('limit=200');
  });

  it('limit 为 0 或负数被夹到 1', async () => {
    fetchMock.mockResolvedValue(jsonResponse(candleRows()));
    await call('/api/candles/BBD_USDT?interval=15m&limit=0');
    expect(String(fetchMock.mock.calls[0]![0])).toContain('limit=1');
  });

  it('不同 limit 使用不同的缓存维度（先小后大不得命中同一份数据）', async () => {
    fetchMock.mockResolvedValue(jsonResponse(candleRows(50)));
    await call('/api/candles/BBE_USDT?interval=15m&limit=50');
    // 换 limit 后必须是缓存未命中，因而再次触达上游
    await call('/api/candles/BBE_USDT?interval=15m&limit=120');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]![0])).toContain('limit=50');
    expect(String(fetchMock.mock.calls[1]![0])).toContain('limit=120');
  });

  it('相同 symbol+interval+limit 命中缓存，不重复请求上游', async () => {
    fetchMock.mockResolvedValue(jsonResponse(candleRows(50)));
    await call('/api/candles/CCC_USDT?interval=15m&limit=66');
    await call('/api/candles/CCC_USDT?interval=15m&limit=66');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('candles 路由：last-known-good 降级（F28）', () => {
  it('成功时写入降级缓存（此前只对 ticker 写入）', async () => {
    fetchMock.mockResolvedValue(jsonResponse(candleRows()));
    await call('/api/candles/DDD_USDT?interval=15m&limit=200');
    expect(cache.setStale).toHaveBeenCalled();
    const [key, payload] = vi.mocked(cache.setStale).mock.calls[0]!;
    expect(String(key)).toContain('candles:DDD_USDT:15m:200');
    expect(Array.isArray(payload)).toBe(true);
  });

  it('上游失败且无降级缓存时返回 503', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ label: 'err' }, false, 500));
    const res = await call('/api/candles/EEE_USDT?interval=15m&limit=77');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: number };
    expect(body.code).toBe(503);
  });

  it('有降级缓存时返回旧数据而不是 503', async () => {
    const cached: CandleDto[] = [
      { time: 1_700_000_000, open: 1, high: 1, low: 1, close: 1, volume: 1 },
    ];
    // 直接注入降级缓存，再让上游失败
    cache.setStale('candles:FFF_USDT:15m:88', cached);
    fetchMock.mockResolvedValue(jsonResponse({ label: 'err' }, false, 500));
    const res = await call('/api/candles/FFF_USDT?interval=15m&limit=88');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: number; data: { candles: CandleDto[] } };
    expect(body.code).toBe(0);
    expect(body.data.candles).toEqual(cached);
  });
});

describe('宏观：净流动性的 last-known-good 兜底（F38）', () => {
  /** 带内存存储的 KV 桩 */
  function kvWith(seed: Record<string, string> = {}) {
    const store = new Map(Object.entries(seed));
    return {
      store,
      kv: {
        get: async (k: string) => store.get(k) ?? null,
        put: async (k: string, v: string) => void store.set(k, v),
      } as unknown as KVNamespace,
    };
  }

  const lastGood = {
    current: 5865,
    weeklyChange: 82,
    regime: 'EXPANSION' as const,
    history: [
      { date: '2026-09-30', walcl: 6743, tga: 948, rrp: 11, netLiquidity: 5783 },
      { date: '2026-10-07', walcl: 6747, tga: 880, rrp: 2, netLiquidity: 5865 },
    ],
    updatedAt: 0,
    source: 'FRED',
    live: true,
    asOf: '2026-10-07',
    comparedTo: '2026-09-30',
  };

  it('FRED 不可达但有历史成功结果时，返回陈旧数据并标注原因', async () => {
    const { kv } = kvWith({ 'macro:liquidity:lastgood': JSON.stringify(lastGood) });
    fetchMock.mockRejectedValue(new Error('fred unreachable'));

    const req = new Request('https://worker.test/api/macro/liquidity');
    const res = await worker.fetch(req, makeEnv({ CRYPTO_CACHE: kv }));
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      code: number;
      data: { live: boolean; history: unknown[]; asOf?: string; reason?: string; current: number };
    };
    expect(body.code).toBe(0);
    expect(body.data.live).toBe(false);
    expect(body.data.history).toHaveLength(2);
    expect(body.data.current).toBe(5865);
    expect(body.data.reason).toContain('2026-10-07');
    expect(body.data.reason).toContain('最近一次成功数据');
  });

  it('FRED 不可达且无历史结果时，返回 live=false 与空序列（不编造数据）', async () => {
    const { kv } = kvWith();
    fetchMock.mockRejectedValue(new Error('fred unreachable'));

    const req = new Request('https://worker.test/api/macro/liquidity');
    const res = await worker.fetch(req, makeEnv({ CRYPTO_CACHE: kv }));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: { live: boolean; history: unknown[]; current: number } };
    expect(body.data.live).toBe(false);
    expect(body.data.history).toEqual([]);
    expect(body.data.current).toBe(0);
  });
});

describe('CORS 白名单（F27）', () => {
  it('未配置白名单时回显 *', async () => {
    const res = await call('/api/health');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('白名单内的源被原样回显', async () => {
    const req = new Request('https://worker.test/api/health', {
      headers: { Origin: 'https://crypto-monitor.pages.dev' },
    });
    const res = await worker.fetch(
      req,
      makeEnv({ ALLOWED_ORIGINS: 'https://crypto-monitor.pages.dev,https://example.com' }),
    );
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://crypto-monitor.pages.dev');
  });

  it('白名单外的源不再被回显（修复前会把任意 Origin 原样放行）', async () => {
    const req = new Request('https://worker.test/api/health', {
      headers: { Origin: 'https://evil.example' },
    });
    const res = await worker.fetch(
      req,
      makeEnv({ ALLOWED_ORIGINS: 'https://crypto-monitor.pages.dev' }),
    );
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('错误响应同样遵守白名单', async () => {
    const req = new Request('https://worker.test/api/candles/BTC_USDT?interval=7d', {
      headers: { Origin: 'https://evil.example' },
    });
    const res = await worker.fetch(
      req,
      makeEnv({ ALLOWED_ORIGINS: 'https://crypto-monitor.pages.dev' }),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('其他路由基础行为', () => {
  it('health 返回 ok', async () => {
    const res = await call('/api/health');
    const body = (await res.json()) as { code: number; data: { status: string } };
    expect(body.code).toBe(0);
    expect(body.data.status).toBe('ok');
  });

  it('未知路由返回 404', async () => {
    const res = await call('/api/nope');
    expect(res.status).toBe(404);
  });

  it('非法符号返回 400', async () => {
    const res = await call('/api/ticker/!!!');
    expect(res.status).toBe(400);
  });
});
