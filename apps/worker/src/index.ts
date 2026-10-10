import type {
  ApiEnvelope,
  TickerDto,
  CandleDto,
  IndicatorSnapshotDto,
  AiStrategyDto,
  FundingRateDto,
  ContractStatsDto,
  FomcSnapshot,
  MacroCalendarData,
  MacroFundingData,
  LiquidationHeatmap,
  LiquidityData,
} from '@crypto-monitor/shared';
import { isSupportedInterval, normalizeAndValidate } from '@crypto-monitor/shared';
import { computeSnapshot } from '@crypto-monitor/indicators';
import {
  fetchTicker,
  fetchCandles,
  fetchFundingRate,
  fetchContractStats,
  checkContractExists,
} from './gateio.js';
import { getCached, getKV, setMemory, setKV, setStale, getStale } from './cache.js';
import { rateLimit, withDedup } from './ratelimit.js';
import { generateStrategy, type AiContext, AI_CACHE_TTL_SEC } from './ai.js';
import {
  getFomcSnapshot,
  getMacroCalendar,
  getMacroFunding,
  getLiquidationHeatmap,
  getLiquidityData,
} from './macro.js';

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

/**
 * 解析 CORS 白名单，返回应回显的 Origin。
 *
 * 原实现最后一行为 `return origin`，即**不在白名单内的源也会被原样回显**，
 * 等于把 `ALLOWED_ORIGINS` 变成无效配置。
 * 现在返回空字符串表示"不回显"，由 `json()` 决定不输出 Allow-Origin 头，
 * 浏览器据此拦截跨域读取。
 */
function resolveCorsOrigin(request: Request, env: Env): string {
  const origin = request.headers.get('Origin') || '';
  const allowed = env.ALLOWED_ORIGINS
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean) || [];
  // 未配置白名单：本地开发或同源部署，放开
  if (allowed.length === 0) return '*';
  return allowed.includes(origin) ? origin : '';
}

function ok<T>(data: T, msg?: string): ApiEnvelope<T> {
  return { code: 0, data, msg, ts: Date.now() };
}

function err(code: number, msg: string): ApiEnvelope<null> {
  return { code, data: null, msg, ts: Date.now() };
}

function json<T>(data: T, status = 200, corsOrigin?: string): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  // 只有明确允许的源才输出 Allow-Origin；空字符串表示拒绝回显
  if (corsOrigin) headers['Access-Control-Allow-Origin'] = corsOrigin;
  return new Response(JSON.stringify(data), { status, headers });
}

function parsePath(pathname: string): { route: string; param: string | null; subRoute: string | null } {
  const parts = pathname.replace(/^\/+/, '').split('/');
  // /api/ticker/BTC_USDT -> route=ticker, param=BTC_USDT
  // /api/macro/fomc -> route=macro, subRoute=fomc
  if (parts[0] === 'api' && parts.length >= 2) {
    if (parts[1] === 'macro' && parts.length >= 3) {
      return { route: 'macro', subRoute: parts[2], param: parts[3] ?? null };
    }
    return { route: parts[1], param: parts[2] ?? null, subRoute: null };
  }
  return { route: '', param: null, subRoute: null };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { route, param, subRoute } = parsePath(url.pathname);
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

      // 周期必须走白名单：原先直接把查询串透传给上游，且未做 URL 编码，
      // 既可能触发未登记周期（dataQuality 恒为 INSUFFICIENT），也存在参数注入面。
      const interval = url.searchParams.get('interval') || '15m';
      if (!isSupportedInterval(interval)) {
        return json(err(400, `不支持的周期: ${interval}`), 400, corsOrigin);
      }

      // limit 夹到 [1, 500]，并与 dev.md 3.2 的缓存维度保持一致（key 必须含 limit，
      // 否则先请求 limit=50 会把结果写进缓存，后续 limit=200 的请求会命中这 50 根）。
      const rawLimit = parseInt(url.searchParams.get('limit') || '200', 10);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 500) : 200;

      const base = env.GATEIO_BASE || 'https://api.gateio.ws';
      const key = `candles:${symbol}:${interval}:${limit}`;

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
          // last-known-good 降级缓存：原先只对 ticker 调用 setStale，
          // 导致 candles 的失败分支永远拿不到 stale、直接 503（dev.md 3.2 要求最长容忍 60s）。
          setStale(key, candles);
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
      const cached = await getCached<FundingRateDto>(env.CRYPTO_CACHE, key, 30_000);
      if (cached) return json(ok(cached), 200, corsOrigin);
      try {
        const data = await withDedup(`gate:${key}`, () => fetchFundingRate(symbol, base));
        setMemory(key, data, 30_000);
        setKV(env.CRYPTO_CACHE, key, data, 60);
        return json(ok(data), 200, corsOrigin);
      } catch {
        return json(err(503, '资金费率数据延迟，自动重连'), 503, corsOrigin);
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
        // 日额度计数走 KV，避免"每个 isolate 各算一份"（审查项 F32）
        KV: env.CRYPTO_CACHE,
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

    // ===== 宏观看板 =====
    if (route === 'macro') {
      const base = env.GATEIO_BASE || 'https://api.gateio.ws';

      // FOMC 快照
      if (subRoute === 'fomc') {
        const key = 'macro:fomc';
        const cached = await getCached<FomcSnapshot>(env.CRYPTO_CACHE, key, 3600_000);
        if (cached) return json(ok(cached), 200, corsOrigin);
        const data = getFomcSnapshot();
        setMemory(key, data, 3600_000);
        setKV(env.CRYPTO_CACHE, key, data, 3600);
        return json(ok(data), 200, corsOrigin);
      }

      // 14天宏观日历
      if (subRoute === 'calendar') {
        const key = 'macro:calendar';
        const cached = await getCached<MacroCalendarData>(env.CRYPTO_CACHE, key, 3600_000);
        if (cached) return json(ok(cached), 200, corsOrigin);
        const data = getMacroCalendar();
        setMemory(key, data, 3600_000);
        setKV(env.CRYPTO_CACHE, key, data, 3600);
        return json(ok(data), 200, corsOrigin);
      }

      // BTC/SOL 多交易所资金费率
      if (subRoute === 'funding' && param) {
        const { symbol, valid } = normalizeAndValidate(param);
        if (!valid) return json(err(400, '无效的交易对符号'), 400, corsOrigin);
        const key = `macro:funding:${symbol}`;
        const cached = await getCached<MacroFundingData>(env.CRYPTO_CACHE, key, 60_000);
        if (cached) return json(ok(cached), 200, corsOrigin);
        try {
          const data = await withDedup(`gate:${key}`, () => getMacroFunding(symbol, base));
          setMemory(key, data, 60_000);
          setKV(env.CRYPTO_CACHE, key, data, 300);
          return json(ok(data), 200, corsOrigin);
        } catch {
          return json(err(503, '资金费率数据延迟'), 503, corsOrigin);
        }
      }

      // 清算热力图（真实强平订单；取不到数据时 data.live=false，由 UI 显示"暂不可用"）
      if (subRoute === 'liquidation' && param) {
        const { symbol, valid } = normalizeAndValidate(param);
        if (!valid) return json(err(400, '无效的交易对符号'), 400, corsOrigin);
        const key = `macro:liquidation:${symbol}`;
        const cached = await getCached<LiquidationHeatmap>(env.CRYPTO_CACHE, key, 60_000);
        if (cached) return json(ok(cached), 200, corsOrigin);
        const data = await withDedup(`gate:${key}`, () => getLiquidationHeatmap(symbol, base));
        // 失败结果不能长缓存，否则一次上游抖动会让面板空白一整个 TTL
        setMemory(key, data, data.live ? 60_000 : 10_000);
        setKV(env.CRYPTO_CACHE, key, data, data.live ? 60 : 15);
        return json(ok(data), 200, corsOrigin);
      }

      // 净流动性（FRED 实时数据；失败时回退到最近一次成功结果并标注陈旧）
      if (subRoute === 'liquidity') {
        const key = 'macro:liquidity';
        const lastGoodKey = 'macro:liquidity:lastgood';
        const cached = await getCached<LiquidityData>(env.CRYPTO_CACHE, key, 3600_000);
        if (cached) return json(ok(cached), 200, corsOrigin);

        const data = await withDedup(`gate:${key}`, () => getLiquidityData());
        if (data.live) {
          // FRED 序列变化很慢，成功时缓存 1 小时，并额外保留 7 天作为兜底
          setMemory(key, data, 3600_000);
          setKV(env.CRYPTO_CACHE, key, data, 3600);
          setKV(env.CRYPTO_CACHE, lastGoodKey, data, 7 * 86400);
          return json(ok(data), 200, corsOrigin);
        }

        // 抓取失败：短缓存失败态（便于快速恢复），并尝试用最近一次成功结果兜底
        setMemory(key, data, 60_000);
        setKV(env.CRYPTO_CACHE, key, data, 60);
        const lastGood = await getKV<LiquidityData>(env.CRYPTO_CACHE, lastGoodKey);
        if (lastGood && lastGood.history.length > 0) {
          return json(
            ok({
              ...lastGood,
              live: false,
              reason: `实时抓取失败（${data.reason ?? 'unknown'}），展示 ${lastGood.asOf ?? '—'} 的最近一次成功数据`,
            }),
            200,
            corsOrigin,
          );
        }
        return json(ok(data), 200, corsOrigin);
      }

      return json(err(404, '未知宏观接口'), 404, corsOrigin);
    }

    return json(err(404, 'Not Found'), 404, corsOrigin);
  },
};
