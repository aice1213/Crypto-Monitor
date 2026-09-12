/**
 * 统一响应信封
 */
export interface ApiEnvelope<T> {
  code: number;
  data: T;
  msg?: string;
  ts: number;
}

export interface TickerDto {
  symbol: string;
  last: number;
  change24h: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  ts: number;
  stale?: boolean;
}

export interface CandleDto {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type EmaStructure = 'BULLISH' | 'BEARISH' | 'MIXED';
export type RsiZone = 'OVERBOUGHT' | 'OVERSOLD' | 'NEUTRAL';
export type MacdSignal = 'GOLDEN_CROSS' | 'DEATH_CROSS' | 'NONE';
export type ObvFlow = 'INFLOW' | 'OUTFLOW' | 'BALANCED';
export type TrendDirection = 'BULLISH' | 'BEARISH' | 'RANGING';
export type DataQuality = 'FULL' | 'GAPS_FILLED' | 'INSUFFICIENT';

export interface MacdResult {
  dif: number;
  dea: number;
  hist: number;
  signal: MacdSignal;
}

export interface ObvResult {
  value: number;
  ma20: number;
  flow: ObvFlow;
}

export interface TrendResult {
  score: number;
  direction: TrendDirection;
}

export interface TradePlan {
  entryLow: number;
  entryHigh: number;
  tp1: number;
  tp2: number;
  sl: number;
  rrRatio: number;
  side: 'LONG' | 'SHORT';
  reason: string;
}

export interface IndicatorSnapshotDto {
  ema7: number;
  ema25: number;
  ema99: number;
  emaStructure: EmaStructure;
  rsi14: number;
  rsiZone: RsiZone;
  macd: MacdResult;
  obv: ObvResult;
  trend: TrendResult;
  support: number[];
  resistance: number[];
  plan: TradePlan | null;
  dataQuality: DataQuality;
}

export interface AlertSnapshotDto {
  fundingRate: number;
  fundingSignal: 'LONG_HEAVY' | 'SHORT_HEAVY' | 'NEUTRAL';
  longShortRatio: number;
  volumePriceDivergence: 'BULLISH_DIVERGENCE' | 'BEARISH_DIVERGENCE' | 'NONE';
  multiTfConflict: boolean;
  extremeAlert: 'OVERBOUGHT' | 'OVERSOLD' | null;
  dataQuality: DataQuality;
}

export interface AiStrategyDto {
  symbol: string;
  summary: string;
  signals: {
    trend: TrendDirection;
    confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  };
  disclaimer: string;
  generatedAt: number;
  model: string;
}

export interface FundingRateDto {
  symbol: string;
  fundingRate: number;
  ts: number;
}

export interface ContractStatsDto {
  symbol: string;
  longShortRatio: number;
  ts: number;
}
