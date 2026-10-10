import type {
  EmaStructure,
  MacdResult,
  ObvFlow,
  TrendResult,
  RsiZone,
} from '@crypto-monitor/shared';
import {
  RSI_OVERBOUGHT,
  RSI_OVERSOLD,
  SCORE_BEARISH_THRESHOLD,
  SCORE_BULLISH_THRESHOLD,
  SCORE_MACD_RECENT_WEIGHT,
  SCORE_MACD_WEIGHT,
  SCORE_RSI_WEIGHT,
} from '@crypto-monitor/shared';

/**
 * 综合评分（dev.md 4.1，满分 ±100）
 *
 * RSI 极值使用弱权重 SCORE_RSI_WEIGHT：RSI 描述"位置"而非"方向"，
 * 若与 EMA/MACD/OBV 同权重，强趋势会被超买扣分抵消而误判为震荡。
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

  // MACD：只有**当根**交叉（signalAge === 0）计满权重；
  // 保留期内的"近期信号"按弱权重计——dev.md 4.1 规定保留期仅用于 UI 弱化显示，
  // 若与当根交叉等价，同一个交叉会在 4 根 K 线里持续投满票。
  const macdWeight = macd.signalAge === 0 ? SCORE_MACD_WEIGHT : SCORE_MACD_RECENT_WEIGHT;
  if (macd.signal === 'GOLDEN_CROSS') score += macdWeight;
  else if (macd.signal === 'DEATH_CROSS') score -= macdWeight;

  if (rsiZone === 'OVERSOLD') score += SCORE_RSI_WEIGHT;
  else if (rsiZone === 'OVERBOUGHT') score -= SCORE_RSI_WEIGHT;

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
