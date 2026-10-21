import type { CandleDto, IndicatorSnapshotDto } from '@crypto-monitor/shared';
import { ema } from './ema.js';
import { rsi } from './rsi.js';
import { macd } from './macd.js';
import { obv } from './obv.js';
import { supportResistance, ema99LastValue } from './pivots.js';
import { compositeScore, emaStructure, rsiZone } from './score.js';
import { buildTradePlan } from './tradePlan.js';
import { assessDataQuality } from './dataQuality.js';
import { detectPatterns } from './patterns.js';
import { classifyMarketState } from './marketState.js';
import { classifyMaStrategy } from './maStrategy.js';
import { analyzeTrendStructure } from './trendStructure.js';
import { classifySwingStrategy } from './swingStrategy.js';

/**
 * 各周期一根 K 线的秒数。
 *
 * 必须覆盖调用方实际会请求的全部周期：`Home` 页会用 `1h` 拉取多周期对比所需的 K 线，
 * 若此处缺项会退化为 900 秒，导致 1h K 线每根都被判为"缺口"，
 * `dataQuality` 恒为 `INSUFFICIENT`（实测确认）。
 */
const INTERVAL_SEC: Record<string, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '4h': 14400,
  '8h': 28800,
  '1d': 86400,
};

/** 未登记周期时的兜底秒数（15m） */
const DEFAULT_INTERVAL_SEC = 900;

/** 取周期对应秒数；未登记时回退到 15m 并保持行为可预期 */
export function intervalSeconds(interval: string): number {
  return INTERVAL_SEC[interval] ?? DEFAULT_INTERVAL_SEC;
}

/** 判定 K 线是否已收盘时允许的时钟偏差（秒） */
const CLOSE_SKEW_SEC = 5;

/**
 * 剔除尚未收盘的最后一根 K 线。
 *
 * Gate.io 返回的最后一根是**正在形成中**的 K 线（`time` 为开盘时间）。
 * 例如 15m 周期在开盘 19 秒时，该根成交量只有均量的 1.5%，
 * 若参与计算会让量比、OBV 流向、"地量/缩量"判断全部失真。
 * 指标一律基于已收盘 K 线计算。
 */
export function dropUnclosedCandle(
  candles: CandleDto[],
  intervalSec: number,
  nowSec = Math.floor(Date.now() / 1000),
): CandleDto[] {
  if (candles.length <= 1) return candles;
  const last = candles[candles.length - 1];
  if (!last || !Number.isFinite(last.time)) return candles;
  if (last.time + intervalSec > nowSec + CLOSE_SKEW_SEC) {
    return candles.slice(0, -1);
  }
  return candles;
}

/**
 * 计算完整指标快照（dev.md 4）
 */
export function computeSnapshot(
  inputCandles: CandleDto[],
  interval = '15m',
): IndicatorSnapshotDto {
  const intervalSec = intervalSeconds(interval);
  // 未收盘 K 线不参与任何指标计算
  const closedCandles = dropUnclosedCandle(inputCandles, intervalSec);
  const { candles, dataQuality } = assessDataQuality(closedCandles, intervalSec);

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
  const ema50Arr = ema(closes, 50);
  const ema99Arr = ema(closes, 99);
  const ema200Arr = ema(closes, 200);
  const ema7 = last(ema7Arr);
  const ema25 = last(ema25Arr);
  const ema50 = last(ema50Arr);
  const ema99 = last(ema99Arr);
  const ema200 = last(ema200Arr);

  const emaStruct = n < 120 ? 'MIXED' : emaStructure(ema7, ema25, ema99);

  const rsiArr = rsi(closes, 14);
  const rsi14 = last(rsiArr);
  const rsiZ = rsiZone(rsi14);

  const macdArr = macd(highs, lows, closes);
  const macdResult = macdArr[macdArr.length - 1] ?? {
    dif: 0,
    dea: 0,
    hist: 0,
    signal: 'NO_SIGNAL' as const,
    signalAge: null,
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

  // 价格行为形态检测
  const patternContext = {
    trend: trend.direction,
    support,
    resistance,
  };
  const patterns = detectPatterns(candles, patternContext, { windowBars: 30 });

  // 市场状态分类
  const marketState = classifyMarketState(candles, ema7, ema25, ema99, emaStruct);

  // 均线交易策略（EMA200趋势过滤 + EMA50价值区间回踩）
  const maStrategy = classifyMaStrategy(candles, ema50Arr, ema200Arr);

  // 趋势结构分析（HH/HL/LH/LL 波段高低点结构）
  const trendStructure = analyzeTrendStructure(candles);

  // 波段交易策略（区间震荡 / 顺势抓浪 / 逆势反转）
  const swingStrategy = classifySwingStrategy(candles, ema50Arr, support, resistance, patterns);

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
    ema50,
    ema99,
    ema200,
    emaStructure: emaStruct,
    rsi14,
    rsiZone: rsiZ,
    macd: macdResult,
    obv: obvResult,
    trend,
    support,
    resistance,
    patterns,
    marketState,
    trendStructure,
    maStrategy,
    swingStrategy,
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
