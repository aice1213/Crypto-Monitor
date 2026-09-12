import type {
  ApiEnvelope,
  TickerDto,
  CandleDto,
  IndicatorSnapshotDto,
  AiStrategyDto,
  FundingRateDto,
  ContractStatsDto,
} from '@crypto-monitor/shared';
import { normalizeAndValidate } from '@crypto-monitor/shared';
import { computeSnapshot } from '@crypto-monitor/indicators';
import {
  fetchTicker,
  fetchCandles,
  fetchFundingRate,
  fetchContractStats,
  checkContractExists,
} from './gateio.js';
import { getCached, setMemory, setKV, setStale, getStale } from './cache.js';
import { rateLimit, withDedup } from './ratelimit.js';
import { generateStrategy, type AiContext, AI_CACHE_TTL_SEC } from './ai.js';

interface Env {
  CRYPTO_CACHE: KVNamespace;
  AI: Ai;
  GATEIO_BASE: string;
  AI_PROVIDER: string;
  AI_ENABLED: string;
  AI_DAILY_LIMIT: string;
  OPENAI_API_KEY: string;
  ALLOWED_ORIGINS: string;
}

/** 解析 CORS 白名单，返回允许的 Origin header 值 */
function resolveCorsOrigin(request: Request, env: Env): string {
  const origin = request.headers.get('Origin') || '';
  const allowed = env.ALLOWED_ORIGINS
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean) || [];
  if (allowed.length > 0 && allowed.includes(origin)) {
    return origin;
  }
  // 回退：本地开发或配置未设置时允许
  if (allowed.length === 0) return '*';
  return origin;
}

function ok<T>(data: T, msg?: string): ApiEnvelope<T> {
  return { code: 0, data, msg, ts: Date.now() };
}

function err(code: number, msg: string): ApiEnvelope<null> {
  return { code, data: null, msg, ts: Date.now() };
}

function json<T>(data: T, status = 200, corsOrigin?: string): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': corsOrigin || '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

function parsePath(pathname: string): { route: string; param: string | null } {
  const parts = pathname.replace(/^\/+/, '').split('/');
  // /api/ticker/BTC_USDT -> route=ticker, param=BTC_USDT
  if (parts[0] === 'api' && parts.length >= 2) {
    return { route: parts[1], param: parts[2] ?? null };
  }
  return { route: '', param: null };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { route, param } = parsePath(url.pathname);
    const corsOrigin = resolveCorsOrigin(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': corsOrigin,
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // Health
    if (route === 'health') {
      return json(ok({ status: 'ok' }), 200, corsOrigin);
    }

    // Ticker
    if (route === 'ticker' && param) {
      if (!rateLimit()) return json(err(429, '限流中，请稍后重试'), 429, corsOrigin);
      const { symbol, valid } = normalizeAndValidate(param);
      if (!valid) return json(err(400, '无效的交易对符号'), 400, corsOrigin);

      const base = env.GATEIO_BASE || 'https://api.gateio.ws';
      const key = `ticker:${symbol}`;
      const cached = await getCached<TickerDto>(env.CRYPTO_CACHE, key, 3000);
      if (cached) return json(ok(cached), 200, corsOrigin);

      try {
        const data = await withDedup(`gate:${key}`, () => fetchTicker(symbol, base));
        setMemory(key, data, 3000);
        setKV(env.CRYPTO_CACHE, key, data, 30);
        setStale(key, data);
        return json(ok(data), 200, corsOrigin);
      } catch {
        const stale = getStale<TickerDto>(key);
        if (stale) return json(ok({ ...stale.data, stale: true }), 200, corsOrigin);
        return json(err(503, '数据延迟，自动重连'), 503, corsOrigin);
      }
    }

    // Candles + snapshot
    if (route === 'candles' && param) {
      if (!rateLimit()) return json(err(429, '限流中，请稍后重试'), 429, corsOrigin);
      const { symbol, valid } = normalizeAndValidate(param);
      if (!valid) return json(err(400, '无效的交易对符号'), 400, corsOrigin);

      const interval = url.searchParams.get('interval') || '15m';
      const limit = parseInt(url.searchParams.get('limit') || '200', 10);
      const base = env.GATEIO_BASE || 'https://api.gateio.ws';
      const key = `candles:${symbol}:${interval}`;

      const cached = await getCached<CandleDto[]>(env.CRYPTO_CACHE, key, 10_000);
      let candles: CandleDto[];
      if (cached) {
        candles = cached;
      } else {
        try {
          candles = await withDedup(`gate:${key}`, () =>
            fetchCandles(symbol, interval, limit, base),
          );
          setMemory(key, candles, 10_000);
          setKV(env.CRYPTO_CACHE, key, candles, 30);
        } catch {
          const stale = getStale<CandleDto[]>(key);
          if (stale) candles = stale.data;
          else return json(err(503, '数据延迟，自动重连'), 503, corsOrigin);
        }
      }

      const snapshot = computeSnapshot(candles, interval);
      return json(ok({ candles, snapshot }), 200, corsOrigin);
    }

    // Funding rate
    if (route === 'funding' && param) {
      const { symbol, valid } = normalizeAndValidate(param);
      if (!valid) return json(err(400, '无效的交易对符号'), 400, corsOrigin);
      const base = env.GATEIO_BASE || 'https://api.gateio.ws';
      const key = `funding:${symbol}`;
      const cached = await getCached<FundingRateDto>(env.CRYPTO_CACHE, key, 60_000);
      if (cached) return json(ok(cached), 200, corsOrigin);
      try {
        const data = await withDedup(`gate:${key}`, () => fetchFundingRate(symbol, base));
        setMemory(key, data, 60_000);
        setKV(env.CRYPTO_CACHE, key, data, 300);
        return json(ok(data), 200, corsOrigin);
      } catch {
        return json(ok({ symbol, fundingRate: 0, ts: Date.now() }), 200, corsOrigin);
      }
    }

    // Long/short ratio
    if (route === 'stats' && param) {
      const { symbol, valid } = normalizeAndValidate(param);
      if (!valid) return json(err(400, '无效的交易对符号'), 400, corsOrigin);
      const base = env.GATEIO_BASE || 'https://api.gateio.ws';
      const key = `stats:${symbol}`;
      const cached = await getCached<ContractStatsDto>(env.CRYPTO_CACHE, key, 60_000);
      if (cached) return json(ok(cached), 200, corsOrigin);
      try {
        const data = await withDedup(`gate:${key}`, () => fetchContractStats(symbol, '1h', base));
        setMemory(key, data, 60_000);
        setKV(env.CRYPTO_CACHE, key, data, 300);
        return json(ok(data), 200, corsOrigin);
      } catch {
        return json(ok({ symbol, longShortRatio: 1, ts: Date.now() }), 200, corsOrigin);
      }
    }

    // Contract preflight
    if (route === 'contract' && param) {
      const { symbol, valid } = normalizeAndValidate(param);
      if (!valid) return json(err(400, '无效的交易对符号'), 400, corsOrigin);
      const base = env.GATEIO_BASE || 'https://api.gateio.ws';
      const exists = await checkContractExists(symbol, base);
      return json(ok({ symbol, exists }), 200, corsOrigin);
    }

    // AI strategy
    if (route === 'ai' && request.method === 'POST') {
      if (!rateLimit()) return json(err(429, '限流中，请稍后重试'), 429, corsOrigin);
      const body = (await request.json()) as {
        symbol: string;
        interval?: string;
        ticker: { last: number; change24h: number };
        snapshot: IndicatorSnapshotDto;
      };
      const { symbol, valid } = normalizeAndValidate(body.symbol);
      if (!valid) return json(err(400, '无效的交易对符号'), 400, corsOrigin);

      const interval = body.interval || '15m';
      const key = `ai:${symbol}:${interval}`;
      const cached = await getCached<AiStrategyDto>(
        env.CRYPTO_CACHE,
        key,
        AI_CACHE_TTL_SEC * 1000,
      );
      if (cached) return json(ok(cached), 200, corsOrigin);

      const aiCtx: AiContext = {
        AI: env.AI,
        AI_PROVIDER: env.AI_PROVIDER,
        AI_ENABLED: env.AI_ENABLED,
        AI_DAILY_LIMIT: env.AI_DAILY_LIMIT,
        OPENAI_API_KEY: env.OPENAI_API_KEY,
      };

      const result = await generateStrategy({
        symbol,
        interval,
        ticker: body.ticker,
        snap: body.snapshot,
        ctx: aiCtx,
      });
      setMemory(key, result, AI_CACHE_TTL_SEC * 1000);
      setKV(env.CRYPTO_CACHE, key, result, AI_CACHE_TTL_SEC);
      return json(ok(result), 200, corsOrigin);
    }

    return json(err(404, 'Not Found'), 404, corsOrigin);
  },
};
