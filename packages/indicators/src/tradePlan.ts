import type { TradePlan, TrendDirection } from '@crypto-monitor/shared';
import { BASE_SL_PCT, MAX_SL_PCT, MIN_RR_RATIO } from '@crypto-monitor/shared';

/**
 * 止损计算（dev.md 4.3）
 *
 * 基础止损 = 进场区远端 ±1.5%；允许为"躲开次近关键位"而放宽，
 * 但放宽后不得宽于 MAX_SL_PCT（3%）。若无上限，次近关键位越远止损越宽、
 * 盈亏比越低，会把本来合格的计划判死。
 *
 * @param far  进场区远端（做多 = entryLow，做空 = entryHigh）
 * @param next 次近关键位（做多 = support[1]，做空 = resistance[1]）
 */
export function stopLoss(far: number, next: number | undefined, side: 'LONG' | 'SHORT'): number {
  const base = side === 'LONG' ? far * (1 - BASE_SL_PCT) : far * (1 + BASE_SL_PCT);
  if (next == null || !Number.isFinite(next)) return base;

  // 结构位：贴在该关键位外侧 0.1%，避免止损正好落在结构上被扫
  const structural = side === 'LONG' ? next * (1 - 0.001) : next * (1 + 0.001);
  // 最宽限制
  const limit = side === 'LONG' ? far * (1 - MAX_SL_PCT) : far * (1 + MAX_SL_PCT);

  // 仅当结构位比基础止损更宽、且仍在最宽限制之内时才采用
  if (side === 'LONG') {
    return structural < base && structural >= limit ? structural : base;
  }
  return structural > base && structural <= limit ? structural : base;
}

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

    const sl = stopLoss(entryLow, support[1], 'LONG');

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

  const sl = stopLoss(entryHigh, resistance[1], 'SHORT');

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
