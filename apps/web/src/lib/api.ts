import type {
  ApiEnvelope,
  TickerDto,
  CandleDto,
  IndicatorSnapshotDto,
  AiStrategyDto,
  FundingRateDto,
  ContractStatsDto,
} from '@crypto-monitor/shared';

const API_BASE = import.meta.env.VITE_API_BASE || '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers || {}),
      },
    });
    clearTimeout(timer);
    const env = (await res.json()) as ApiEnvelope<T>;
    if (env.code !== 0) {
      throw new Error(env.msg || '请求失败');
    }
    return env.data;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

export const api = {
  getTicker: (symbol: string) => request<TickerDto>(`/ticker/${symbol}`),

  getCandles: (symbol: string, interval = '15m', limit = 200) =>
    request<{ candles: CandleDto[]; snapshot: IndicatorSnapshotDto }>(
      `/candles/${symbol}?interval=${interval}&limit=${limit}`,
    ),

  getFunding: (symbol: string) => request<FundingRateDto>(`/funding/${symbol}`),

  getStats: (symbol: string) => request<ContractStatsDto>(`/stats/${symbol}`),

  checkContract: (symbol: string) =>
    request<{ symbol: string; exists: boolean }>(`/contract/${symbol}`),

  getAiStrategy: (body: {
    symbol: string;
    interval?: string;
    ticker: { last: number; change24h: number };
    snapshot: IndicatorSnapshotDto;
  }) =>
    request<AiStrategyDto>('/ai/strategy', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};
