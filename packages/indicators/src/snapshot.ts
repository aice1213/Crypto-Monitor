import type { CandleDto, IndicatorSnapshotDto } from '@crypto-monitor/shared';
import { ema } from './ema.js';
import { rsi } from './rsi.js';
import { macd } from './macd.js';
import { obv } from './obv.js';
import { supportResistance, ema99LastValue } from './pivots.js';
import { compositeScore, emaStructure, rsiZone } from './score.js';
import { buildTradePlan } from './tradePlan.js';
import { assessDataQuality } from './dataQuality.js';

const INTERVAL_SEC: Record<string, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
};

/**
 * 计算完整指标快照（dev.md 4）
 */
export function computeSnapshot(
  inputCandles: CandleDto[],
  interval = '15m',
): IndicatorSnapshotDto {
  const intervalSec = INTERVAL_SEC[interval] ?? 900;
  const { candles, dataQuality } = assessDataQuality(inputCandles, intervalSec);

  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);
  const n = candles.length;

  const last = (arr: number[]) => {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (!Number.isNaN(arr[i])) return arr[i];
    }
    return 0;
  };

  const ema7Arr = ema(closes, 7);
  const ema25Arr = ema(closes, 25);
  const ema99Arr = ema(closes, 99);
  const ema7 = last(ema7Arr);
  const ema25 = last(ema25Arr);
  const ema99 = last(ema99Arr);

  const emaStruct = n < 120 ? 'MIXED' : emaStructure(ema7, ema25, ema99);

  const rsiArr = rsi(closes, 14);
  const rsi14 = last(rsiArr);
  const rsiZ = rsiZone(rsi14);

  const macdArr = macd(highs, lows, closes);
  const macdResult = macdArr[macdArr.length - 1] ?? {
    dif: 0,
    dea: 0,
    hist: 0,
    signal: 'NONE' as const,
  };

  const obvArr = obv(closes, volumes);
  const obvResult = obvArr[obvArr.length - 1] ?? {
    value: 0,
    ma20: 0,
    flow: 'BALANCED' as const,
  };

  const trend = compositeScore({
    emaStructure: emaStruct,
    macd: macdResult,
    rsiZone: rsiZ,
    obvFlow: obvResult.flow,
  });

  const ema99Last = ema99LastValue(closes);
  const { support, resistance } = supportResistance(candles, ema99Last);

  let plan = null;
  if (dataQuality !== 'INSUFFICIENT') {
    plan = buildTradePlan({
      direction: trend.direction,
      score: trend.score,
      ema25,
      support,
      resistance,
    });
  }

  return {
    ema7,
    ema25,
    ema99,
    emaStructure: emaStruct,
    rsi14,
    rsiZone: rsiZ,
    macd: macdResult,
    obv: obvResult,
    trend,
    support,
    resistance,
    plan,
    dataQuality,
  };
}

/**
 * 量价背离检测（卡片预警用）
 */
export function detectVolumePriceDivergence(
  candles: CandleDto[],
  obvValues: number[],
): 'BULLISH_DIVERGENCE' | 'BEARISH_DIVERGENCE' | 'NONE' {
  const window = 5;
  if (candles.length < window) return 'NONE';

  const recentCloses = candles.slice(-window).map((c) => c.close);
  const recentObv = obvValues.slice(-window);
  const recentVolumes = candles.slice(-window).map((c) => c.volume);

  const lastClose = recentCloses[recentCloses.length - 1];
  const lastObv = recentObv[recentObv.length - 1];
  const lastVol = recentVolumes[recentVolumes.length - 1];

  const prevCloses = recentCloses.slice(0, -1);
  const prevObv = recentObv.slice(0, -1);
  const prevVols = recentVolumes.slice(0, -1);

  const priceNewHigh = lastClose >= Math.max(...prevCloses);
  const priceNewLow = lastClose <= Math.min(...prevCloses);
  const obvNewHigh = lastObv >= Math.max(...prevObv);
  const obvNewLow = lastObv <= Math.min(...prevObv);
  const volNewHigh = lastVol >= Math.max(...prevVols);

  if (priceNewHigh && (!obvNewHigh || !volNewHigh)) return 'BEARISH_DIVERGENCE';
  if (priceNewLow && !obvNewLow) return 'BULLISH_DIVERGENCE';

  return 'NONE';
}
