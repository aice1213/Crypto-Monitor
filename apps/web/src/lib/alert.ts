import type {
  AlertSnapshotDto,
  CandleDto,
  IndicatorSnapshotDto,
  FundingRateDto,
  ContractStatsDto,
} from '@crypto-monitor/shared';
import {
  FUNDING_RATE_CROWDED_THRESHOLD,
  LONG_SHORT_RATIO_HIGH,
  LONG_SHORT_RATIO_LOW,
  RSI_OVERBOUGHT,
  RSI_OVERSOLD,
} from '@crypto-monitor/shared';
import { detectVolumePriceDivergence, obv } from '@crypto-monitor/indicators';

/**
 * 构建卡片预警快照（dev.md 5.1.1）
 *
 * @param candles15m 15m **已收盘** K 线（调用方需先经 dropUnclosedCandle 过滤）；
 *                   量价背离按 dev.md 5.1.1 的"价格创 5 根新高/新低而 OBV 未同步"判定。
 */
export function buildAlert(params: {
  snapshot15m: IndicatorSnapshotDto;
  candles15m?: CandleDto[];
  snapshot1h?: IndicatorSnapshotDto;
  funding?: FundingRateDto;
  stats?: ContractStatsDto;
}): AlertSnapshotDto {
  const { snapshot15m, candles15m, snapshot1h, funding, stats } = params;

  const fundingRate = funding?.fundingRate ?? 0;
  const longShortRatio = stats?.longShortRatio ?? 1;

  // 拥挤方向判定。
  //
  // 修复前写法是 `fundingRate > 0 || longShortRatio > 1 ? LONG_HEAVY : SHORT_HEAVY`，
  // 会把**未达拥挤阈值**的费率（例如 +0.01% 的噪声）当成"多头拥挤"的方向依据：
  // 实测 rate=0.0001、ratio=0.3 时，拥挤完全由"账户口径一边倒偏空"造成，
  // 却返回 LONG_HEAVY —— 卡片因此显示"多头拥挤，谨慎追高"，方向与多空比相反。
  //
  // 现规则：账户多空比是最直接的持仓拥挤度量，优先用它决定方向；
  // 多空比处于中性区间时，再用**已越过阈值**的资金费率决定方向。
  // 两者同时越界且互相矛盾时，以多空比为准（保证文案方向与用户看到的多空比一致）。
  let fundingSignal: AlertSnapshotDto['fundingSignal'] = 'NEUTRAL';
  const ratioHigh = longShortRatio > LONG_SHORT_RATIO_HIGH;
  const ratioLow = longShortRatio < LONG_SHORT_RATIO_LOW;
  const fundingCrowded = Math.abs(fundingRate) > FUNDING_RATE_CROWDED_THRESHOLD;
  if (ratioHigh) {
    fundingSignal = 'LONG_HEAVY';
  } else if (ratioLow) {
    fundingSignal = 'SHORT_HEAVY';
  } else if (fundingCrowded) {
    fundingSignal = fundingRate > 0 ? 'LONG_HEAVY' : 'SHORT_HEAVY';
  }

  // 量价背离：严格按 dev.md 5.1.1 的规则实现（原先用"RSI 极端 + OBV 流向"替代，语义不符）
  let volumePriceDivergence: AlertSnapshotDto['volumePriceDivergence'] = 'NONE';
  if (candles15m && candles15m.length > 0) {
    const obvValues = obv(
      candles15m.map((c) => c.close),
      candles15m.map((c) => c.volume),
    ).map((o) => o.value);
    volumePriceDivergence = detectVolumePriceDivergence(candles15m, obvValues);
  }

  const multiTfConflict =
    !!snapshot1h &&
    snapshot1h.trend.direction !== snapshot15m.trend.direction &&
    snapshot15m.trend.direction !== 'RANGING' &&
    snapshot1h.trend.direction !== 'RANGING';

  const multiTfState: AlertSnapshotDto['multiTfState'] = !snapshot1h
    ? 'INSUFFICIENT'
    : snapshot15m.trend.direction === snapshot1h.trend.direction
      ? snapshot15m.trend.direction === 'BULLISH'
        ? 'BULL_ALIGN'
        : snapshot15m.trend.direction === 'BEARISH'
          ? 'BEAR_ALIGN'
          : 'RANGE_ALIGN'
      : 'CONFLICT';

  let extremeAlert: AlertSnapshotDto['extremeAlert'] = null;
  if (snapshot15m.rsi14 >= RSI_OVERBOUGHT) extremeAlert = 'OVERBOUGHT';
  else if (snapshot15m.rsi14 <= RSI_OVERSOLD) extremeAlert = 'OVERSOLD';

  return {
    fundingRate,
    fundingSignal,
    longShortRatio,
    volumePriceDivergence,
    multiTfConflict,
    multiTfState,
    extremeAlert,
    dataQuality: snapshot15m.dataQuality,
  };
}

export function hasAlert(alert: AlertSnapshotDto): boolean {
  return (
    alert.fundingSignal !== 'NEUTRAL' ||
    alert.volumePriceDivergence !== 'NONE' ||
    alert.multiTfConflict ||
    alert.extremeAlert !== null
  );
}
