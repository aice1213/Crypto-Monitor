import type {
  AlertSnapshotDto,
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

/**
 * 构建卡片预警快照（dev.md 5.1.1）
 */
export function buildAlert(params: {
  snapshot15m: IndicatorSnapshotDto;
  snapshot1h?: IndicatorSnapshotDto;
  funding?: FundingRateDto;
  stats?: ContractStatsDto;
}): AlertSnapshotDto {
  const { snapshot15m, snapshot1h, funding, stats } = params;

  const fundingRate = funding?.fundingRate ?? 0;
  const longShortRatio = stats?.longShortRatio ?? 1;

  let fundingSignal: AlertSnapshotDto['fundingSignal'] = 'NEUTRAL';
  const crowded =
    Math.abs(fundingRate) > FUNDING_RATE_CROWDED_THRESHOLD ||
    longShortRatio > LONG_SHORT_RATIO_HIGH ||
    longShortRatio < LONG_SHORT_RATIO_LOW;
  if (crowded) {
    fundingSignal = fundingRate > 0 || longShortRatio > 1 ? 'LONG_HEAVY' : 'SHORT_HEAVY';
  }

  let volumePriceDivergence: AlertSnapshotDto['volumePriceDivergence'] = 'NONE';
  if (snapshot15m.rsi14 >= RSI_OVERBOUGHT && snapshot15m.obv.flow === 'OUTFLOW') {
    volumePriceDivergence = 'BEARISH_DIVERGENCE';
  } else if (snapshot15m.rsi14 <= RSI_OVERSOLD && snapshot15m.obv.flow === 'INFLOW') {
    volumePriceDivergence = 'BULLISH_DIVERGENCE';
  }

  const multiTfConflict =
    !!snapshot1h &&
    snapshot1h.trend.direction !== snapshot15m.trend.direction &&
    snapshot15m.trend.direction !== 'RANGING' &&
    snapshot1h.trend.direction !== 'RANGING';

  let extremeAlert: AlertSnapshotDto['extremeAlert'] = null;
  if (snapshot15m.rsi14 >= RSI_OVERBOUGHT) extremeAlert = 'OVERBOUGHT';
  else if (snapshot15m.rsi14 <= RSI_OVERSOLD) extremeAlert = 'OVERSOLD';

  return {
    fundingRate,
    fundingSignal,
    longShortRatio,
    volumePriceDivergence,
    multiTfConflict,
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
