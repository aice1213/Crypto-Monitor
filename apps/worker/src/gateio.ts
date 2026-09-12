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
  const rows = (await res.json()) as {
    contract: string;
    last: string;
    change_percentage: string;
    high_24h: string;
    low_24h: string;
    volume_24h: string;
  }[];
  const data = rows[0];
  if (!data) throw new Error(`Gate.io ticker empty for ${symbol}`);
  return {
    symbol: data.contract,
    last: parseFloat(data.last),
    change24h: parseFloat(data.change_percentage) / 100,
    high24h: parseFloat(data.high_24h),
    low24h: parseFloat(data.low_24h),
    volume24h: parseFloat(data.volume_24h),
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
    `/api/v4/futures/usdt/candlesticks?contract=${encodeURIComponent(
      symbol,
    )}&interval=${interval}&limit=${Math.min(limit, 500)}`,
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

export async function fetchFundingRate(
  symbol: string,
  base = DEFAULT_BASE,
): Promise<FundingRateDto> {
  const res = await fetchWithRetry(
    `/api/v4/futures/usdt/funding_rate?contract=${encodeURIComponent(symbol)}`,
    base,
  );
  const rows = (await res.json()) as { r?: string; rate?: string }[];
  const rate = rows.length > 0 ? parseFloat(rows[0].r ?? rows[0].rate ?? '0') : 0;
  return { symbol, fundingRate: rate, ts: Date.now() };
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
  const rows = (await res.json()) as { lsr_account?: number; lsr_taker?: number }[];
  const ratio =
    rows.length > 0 ? rows[0].lsr_account ?? rows[0].lsr_taker ?? 1 : 1;
  return { symbol, longShortRatio: ratio, ts: Date.now() };
}
