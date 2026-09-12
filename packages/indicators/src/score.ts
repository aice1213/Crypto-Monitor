import type {
  EmaStructure,
  MacdResult,
  ObvFlow,
  TrendResult,
  RsiZone,
} from '@crypto-monitor/shared';
import { RSI_OVERBOUGHT, RSI_OVERSOLD, SCORE_BEARISH_THRESHOLD, SCORE_BULLISH_THRESHOLD } from '@crypto-monitor/shared';

/**
 * 综合评分（dev.md 4.1，满分 ±100）
 */
export function compositeScore(params: {
  emaStructure: EmaStructure;
  macd: MacdResult;
  rsiZone: RsiZone;
  obvFlow: ObvFlow;
}): TrendResult {
  let score = 0;
  const { emaStructure, macd, rsiZone, obvFlow } = params;

  if (emaStructure === 'BULLISH') score += 30;
  else if (emaStructure === 'BEARISH') score -= 30;

  if (macd.signal === 'GOLDEN_CROSS') score += 25;
  else if (macd.signal === 'DEATH_CROSS') score -= 25;

  if (rsiZone === 'OVERSOLD') score += 20;
  else if (rsiZone === 'OVERBOUGHT') score -= 20;

  if (obvFlow === 'INFLOW') score += 25;
  else if (obvFlow === 'OUTFLOW') score -= 25;

  score = Math.max(-100, Math.min(100, score));

  let direction: TrendResult['direction'] = 'RANGING';
  if (score >= SCORE_BULLISH_THRESHOLD) direction = 'BULLISH';
  else if (score <= SCORE_BEARISH_THRESHOLD) direction = 'BEARISH';

  return { score, direction };
}

export function emaStructure(ema7: number, ema25: number, ema99: number): EmaStructure {
  if (ema7 > ema25 && ema25 > ema99) return 'BULLISH';
  if (ema7 < ema25 && ema25 < ema99) return 'BEARISH';
  return 'MIXED';
}

export function rsiZone(rsi: number): RsiZone {
  if (rsi >= RSI_OVERBOUGHT) return 'OVERBOUGHT';
  if (rsi <= RSI_OVERSOLD) return 'OVERSOLD';
  return 'NEUTRAL';
}
