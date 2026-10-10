import type {
  TickerDto,
  CandleDto,
  FundingRateDto,
  ContractStatsDto,
} from '@crypto-monitor/shared';

/**
 * Gate.io USDT 永续合约公开 API 客户端（dev.md 3.1）
 */
const DEFAULT_BASE = 'https://api.gateio.ws';

async function fetchWithRetry(
  url: string,
  base: string,
  retries = 1,
): Promise<Response> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`${base}${url}`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      clearTimeout(timer);
      if (res.ok) return res;
      lastErr = new Error(`Gate.io ${res.status}`);
    } catch (e) {
      clearTimeout(timer);
      lastErr = e as Error;
    }
    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, 300 * Math.pow(2, attempt)));
    }
  }
  throw lastErr ?? new Error('Gate.io request failed');
}

export async function fetchTicker(
  symbol: string,
  base = DEFAULT_BASE,
): Promise<TickerDto> {
  const res = await fetchWithRetry(
    `/api/v4/futures/usdt/tickers?contract=${encodeURIComponent(symbol)}`,
    base,
  );
  // 注意：volume_24h 是"合约张数"（= 基础币数量 ÷ quanto_multiplier），
  // 不是成交额。USDT 成交额必须取 volume_24h_quote（USDT 本位时等价于 volume_24h_settle）。
  // 实测 BTC_USDT：volume_24h = 882,634,383 张 vs volume_24h_quote = 7,220,823,068 USDT。
  const rows = (await res.json()) as {
    contract: string;
    last: string;
    change_percentage: string;
    high_24h: string;
    low_24h: string;
    volume_24h_quote?: string;
    volume_24h_settle?: string;
  }[];
  const data = rows[0];
  if (!data) throw new Error(`Gate.io ticker empty for ${symbol}`);
  const quoteVolume = parseFloat(
    data.volume_24h_quote ?? data.volume_24h_settle ?? '',
  );
  return {
    symbol: data.contract,
    last: parseFloat(data.last),
    change24h: parseFloat(data.change_percentage) / 100,
    high24h: parseFloat(data.high_24h),
    low24h: parseFloat(data.low_24h),
    volume24h: Number.isFinite(quoteVolume) ? quoteVolume : 0,
    ts: Date.now(),
  };
}

export async function fetchCandles(
  symbol: string,
  interval: string,
  limit = 200,
  base = DEFAULT_BASE,
): Promise<CandleDto[]> {
  const res = await fetchWithRetry(
    // interval 同样需要编码：调用方已做白名单校验，这里再编码一次以杜绝参数注入
    `/api/v4/futures/usdt/candlesticks?contract=${encodeURIComponent(
      symbol,
    )}&interval=${encodeURIComponent(interval)}&limit=${Math.min(limit, 500)}`,
    base,
  );
  // futures candlesticks: [{ o, v, t(seconds), c, l, h, sum }]
  const rows = (await res.json()) as {
    o: string;
    v: number;
    t: number;
    c: string;
    l: string;
    h: string;
  }[];
  return rows
    .map((r) => ({
      time: r.t,
      open: parseFloat(r.o),
      high: parseFloat(r.h),
      low: parseFloat(r.l),
      close: parseFloat(r.c),
      volume: r.v,
    }))
    .sort((a, b) => a.time - b.time);
}

export async function checkContractExists(
  symbol: string,
  base = DEFAULT_BASE,
): Promise<boolean> {
  try {
    const res = await fetchWithRetry(
      `/api/v4/futures/usdt/contracts/${encodeURIComponent(symbol)}`,
      base,
    );
    const data = (await res.json()) as { status?: string };
    return data.status === 'open' || res.ok;
  } catch {
    return false;
  }
}

/** Gate.io 合约元信息中宏观模块需要的字段 */
export interface GateContractMeta {
  /** 当期资金费率（小数） */
  fundingRate: number;
  /** 结算周期（小时），来自 funding_interval（秒） */
  fundingIntervalHours: number;
  /** 未平仓名义金额（USDT）= position_size × quanto_multiplier × mark_price */
  openInterestUsd: number;
  markPrice: number;
  quantoMultiplier: number;
}

/**
 * 获取合约元信息。
 *
 * Gate.io 的合约对象没有 `open_interest` 字段，持仓量只能由
 * `position_size`（当前持仓张数）× `quanto_multiplier`（每张对应基础币数量）× `mark_price` 折算，
 * 因此这里一并返回 quanto_multiplier 供强平订单换算名义金额。
 */
export async function fetchContractMeta(
  symbol: string,
  base = DEFAULT_BASE,
): Promise<GateContractMeta> {
  const res = await fetchWithRetry(
    `/api/v4/futures/usdt/contracts/${encodeURIComponent(symbol)}`,
    base,
  );
  const data = (await res.json()) as Record<string, unknown>;

  const raw = data.funding_rate ?? data.r;
  const fundingRate = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : NaN;
  if (!Number.isFinite(fundingRate)) {
    throw new Error(`Gate.io funding malformed for ${symbol}`);
  }

  const intervalSec = Number(data.funding_interval);
  const positionSize = Number(data.position_size);
  const quantoMultiplier = Number(data.quanto_multiplier);
  const markPrice = Number(data.mark_price);

  const oiOk = [positionSize, quantoMultiplier, markPrice].every((v) => Number.isFinite(v) && v > 0);

  return {
    fundingRate,
    // 28800 秒 = 8 小时；异常时退回 8 小时
    fundingIntervalHours: Number.isFinite(intervalSec) && intervalSec > 0 ? intervalSec / 3600 : 8,
    openInterestUsd: oiOk ? positionSize * quantoMultiplier * markPrice : 0,
    markPrice: Number.isFinite(markPrice) ? markPrice : 0,
    quantoMultiplier: Number.isFinite(quantoMultiplier) ? quantoMultiplier : 0,
  };
}

export async function fetchFundingRate(
  symbol: string,
  base = DEFAULT_BASE,
): Promise<FundingRateDto> {
  // 使用 contracts 端点获取当前预测资金费率（非历史结算费率）
  const meta = await fetchContractMeta(symbol, base);
  return { symbol, fundingRate: meta.fundingRate, ts: Date.now() };
}

/** 强平订单原始条目（Gate.io /futures/usdt/liq_orders） */
export interface GateLiqOrder {
  time: number;
  /** 用户仓位张数，带方向（负=空头仓位） */
  size: number;
  /** 强平委托张数，带方向（负=卖出委托 => 多头被强平） */
  orderSize: number;
  /** 强平委托价 */
  orderPrice: number;
  /** 实际成交均价 */
  fillPrice: number;
}

/**
 * 拉取强平订单。
 *
 * Gate.io 限制单次 `from`/`to` 跨度 **不得超过 1 小时**（实测超出会返回
 * `INVALID_PARAM_VALUE: range from/to must in 1 hour`），因此本函数只取最近一个窗口，
 * 不做多窗口拼接（避免每次请求打出十几个上游调用）。
 */
export async function fetchLiquidationOrders(
  symbol: string,
  base = DEFAULT_BASE,
  windowHours = 1,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<GateLiqOrder[]> {
  const hours = Math.min(Math.max(windowHours, 0.1), 1);
  const from = Math.floor(nowSec - hours * 3600);
  const res = await fetchWithRetry(
    `/api/v4/futures/usdt/liq_orders?contract=${encodeURIComponent(
      symbol,
    )}&from=${from}&to=${nowSec}&limit=1000`,
    base,
  );
  const rows = (await res.json()) as Record<string, unknown>[];
  return rows.map((r) => ({
    time: Number(r.time),
    size: Number(r.size),
    orderSize: Number(r.order_size),
    orderPrice: Number(r.order_price),
    fillPrice: Number(r.fill_price),
  }));
}

export async function fetchContractStats(
  symbol: string,
  interval = '1h',
  base = DEFAULT_BASE,
): Promise<ContractStatsDto> {
  const res = await fetchWithRetry(
    `/api/v4/futures/usdt/contract_stats?contract=${encodeURIComponent(
      symbol,
    )}&interval=${interval}`,
    base,
  );
  // Gate.io 按时间**升序**返回（实测 30 行，最新在末尾）。
  // 必须按 time 取最新一条——取 rows[0] 会拿到最多滞后 29 小时的历史值，
  // 实测 BTC 最旧 1.739 vs 最新 1.443，足以让卡片"偏多/中性"的结论翻转。
  const rows = (await res.json()) as {
    time?: number;
    lsr_account?: number;
    lsr_taker?: number;
  }[];
  const latest = rows.reduce<(typeof rows)[number] | undefined>(
    (acc, row) => (acc == null || (row.time ?? 0) >= (acc.time ?? 0) ? row : acc),
    undefined,
  );
  const raw = latest?.lsr_account ?? latest?.lsr_taker;
  const ratio = typeof raw === 'number' && Number.isFinite(raw) ? raw : 1;
  return { symbol, longShortRatio: ratio, ts: Date.now() };
}
