import type { TradePlan, TrendDirection } from '@crypto-monitor/shared';
import { MIN_RR_RATIO } from '@crypto-monitor/shared';

/**
 * 交易计划生成（dev.md 4.3）
 */
export function buildTradePlan(params: {
  direction: TrendDirection;
  score: number;
  ema25: number;
  support: number[];
  resistance: number[];
}): TradePlan | null {
  const { direction, ema25, support, resistance } = params;

  if (direction !== 'BULLISH' && direction !== 'BEARISH') {
    return null;
  }

  if (direction === 'BULLISH') {
    const nearestSupport = support[0];
    if (nearestSupport == null) return null;
    const baseEntry = Math.min(ema25, nearestSupport);
    const entryLow = baseEntry * 0.997;
    const entryHigh = baseEntry * 1.003;
    const entryMid = (entryLow + entryHigh) / 2;

    const tp1 = resistance[0];
    if (tp1 == null || tp1 <= entryMid) return null;
    const tp2 = tp1 * 1.01;

    const slCandidate = entryLow * 0.985;
    const secondSupport = support[1];
    const sl = secondSupport != null ? Math.min(slCandidate, secondSupport * 0.999) : slCandidate;

    const rr = Math.abs(tp1 - entryMid) / Math.abs(entryMid - sl);
    if (rr < MIN_RR_RATIO) {
      return null;
    }

    return {
      side: 'LONG',
      entryLow,
      entryHigh,
      tp1,
      tp2,
      sl,
      rrRatio: rr,
      reason: `多头趋势评分 ${params.score}，EMA25/支撑共振进场，盈亏比 ${rr.toFixed(2)}`,
    };
  }

  const nearestResistance = resistance[0];
  if (nearestResistance == null) return null;
  const baseEntry = Math.max(ema25, nearestResistance);
  const entryLow = baseEntry * 0.997;
  const entryHigh = baseEntry * 1.003;
  const entryMid = (entryLow + entryHigh) / 2;

  const tp1 = support[0];
  if (tp1 == null || tp1 >= entryMid) return null;
  const tp2 = tp1 * 0.99;

  const slCandidate = entryHigh * 1.015;
  const secondResistance = resistance[1];
  const sl = secondResistance != null ? Math.max(slCandidate, secondResistance * 1.001) : slCandidate;

  const rr = Math.abs(entryMid - tp1) / Math.abs(sl - entryMid);
  if (rr < MIN_RR_RATIO) {
    return null;
  }

  return {
    side: 'SHORT',
    entryLow,
    entryHigh,
    tp1,
    tp2,
    sl,
    rrRatio: rr,
    reason: `空头趋势评分 ${params.score}，EMA25/阻力共振进场，盈亏比 ${rr.toFixed(2)}`,
  };
}
