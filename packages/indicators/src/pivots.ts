import type { CandleDto } from '@crypto-monitor/shared';
import { ema } from './ema.js';

interface Cluster {
  center: number;
  totalVolume: number;
  count: number;
}

/** 局部极值点（`index` 为原始数组下标） */
export interface PivotPoint {
  index: number;
  price: number;
}

/**
 * 找局部极值（swing high / swing low）：左右各 `window` 根内严格最大 / 最小。
 *
 * 支撑阻力与价格行为分析（结构、区间、双顶双底）共用同一套判定，
 * 避免两处各写一份、口径漂移。
 */
export function findPivots(
  candles: CandleDto[],
  window = 3,
): { highs: PivotPoint[]; lows: PivotPoint[] } {
  const highs: PivotPoint[] = [];
  const lows: PivotPoint[] = [];
  if (candles.length < window * 2 + 1) return { highs, lows };

  for (let i = window; i < candles.length - window; i++) {
    const cur = candles[i]!;
    let isHigh = true;
    let isLow = true;
    for (let j = i - window; j <= i + window; j++) {
      if (j === i) continue;
      const other = candles[j]!;
      if (other.high >= cur.high) isHigh = false;
      if (other.low <= cur.low) isLow = false;
    }
    if (isHigh) highs.push({ index: i, price: cur.high });
    if (isLow) lows.push({ index: i, price: cur.low });
  }
  return { highs, lows };
}

/**
 * 支撑/阻力位计算（dev.md 4.2）
 */
export function supportResistance(
  candles: CandleDto[],
  ema99Last: number,
): { support: number[]; resistance: number[] } {
  if (candles.length === 0) return { support: [], resistance: [] };

  const slice = candles.slice(-100);
  const currentPrice = slice[slice.length - 1].close;
  const window = 3;

  const { highs, lows } = findPivots(slice, window);
  const resistanceCands = highs.map((h) => ({
    price: h.price,
    volume: slice[h.index]!.volume,
  }));
  const supportCands = lows.map((l) => ({
    price: l.price,
    volume: slice[l.index]!.volume,
  }));

  const cluster = (cands: { price: number; volume: number }[]): number[] => {
    if (cands.length === 0) return [];
    const sorted = [...cands].sort((a, b) => a.price - b.price);
    const clusters: Cluster[] = [];
    const band = 0.003;
    for (const c of sorted) {
      const last = clusters[clusters.length - 1];
      if (last && Math.abs(c.price - last.center) / last.center <= band) {
        last.center =
          (last.center * last.totalVolume + c.price * c.volume) / (last.totalVolume + c.volume);
        last.totalVolume += c.volume;
        last.count++;
      } else {
        clusters.push({ center: c.price, totalVolume: c.volume, count: 1 });
      }
    }
    return clusters.map((c) => c.center);
  };

  let supports = cluster(supportCands).filter((p) => p < currentPrice);
  let resistances = cluster(resistanceCands).filter((p) => p > currentPrice);

  supports.sort((a, b) => b - a);
  resistances.sort((a, b) => a - b);

  supports = supports.slice(0, 3);
  resistances = resistances.slice(0, 3);

  // 动态补充位（dev.md 4.2 步骤 3）：以 EMA99 ± 当前价 × 0.8% 作为不足时的补充。
  //
  // 注意：绝不使用 currentPrice × 1.008 / 0.992 这类纯由现价推导的价位——
  // 它会随每一轮轮询跟着价格漂移，却以"支撑/阻力"的名义展示，误导性强。
  // EMA99 是真实指标位，只有它才有资格作为补充位。
  const offset = currentPrice * 0.008;
  if (resistances.length < 3 && Number.isFinite(ema99Last) && ema99Last > 0) {
    const emaUp = ema99Last + offset;
    if (emaUp > currentPrice) resistances.push(emaUp);
  }
  if (supports.length < 3 && Number.isFinite(ema99Last) && ema99Last > 0) {
    const emaDown = ema99Last - offset;
    if (emaDown < currentPrice) supports.push(emaDown);
  }

  resistances.sort((a, b) => a - b);
  supports.sort((a, b) => b - a);
  resistances = dedupe(resistances);
  supports = dedupe(supports);
  resistances.sort((a, b) => a - b);
  supports.sort((a, b) => b - a);

  return {
    support: supports.slice(0, 3),
    resistance: resistances.slice(0, 3),
  };
}

function dedupe(prices: number[]): number[] {
  const sorted = [...prices].sort((a, b) => a - b);
  const result: number[] = [];
  for (const p of sorted) {
    const last = result[result.length - 1];
    if (last == null || Math.abs(p - last) / Math.max(Math.abs(p), Math.abs(last)) > 0.0001) {
      result.push(p);
    }
  }
  return result;
}

export function ema99LastValue(closes: number[]): number {
  if (closes.length === 0) return 0;
  const e = ema(closes, 99);
  const last = e[e.length - 1];
  return Number.isNaN(last) ? closes[closes.length - 1] : last;
}

/**
 * Fibonacci 回撤关键位计算
 *
 * 从最近 swing high/low 区间计算 0.382 / 0.5 / 0.618 回撤位。
 * 看涨趋势（低点→高点）：回撤位 = high - (high-low) × ratio
 * 看跌趋势（高点→低点）：反弹位 = low + (high-low) × ratio
 *
 * 文档规则2-条件3：形态出现在 Fibonacci 黄金分割位上是高质量关键价位。
 *
 * @param candles 最近 K 线
 * @param lookback 回溯根数（默认 50）
 * @returns Fibonacci 关键位数组，或空数组
 */
export function fibonacciLevels(
  candles: CandleDto[],
  lookback = 50,
): number[] {
  if (candles.length < 10) return [];
  const slice = candles.slice(-Math.min(lookback, candles.length));
  const { highs, lows } = findPivots(slice, 3);
  if (highs.length === 0 || lows.length === 0) return [];

  // 取最近的高点和低点
  const latestHigh = highs[highs.length - 1]!;
  const latestLow = lows[lows.length - 1]!;

  // 判断趋势方向：高点在低点之后 → 看涨
  const isBullish = latestHigh.index > latestLow.index;
  const range = Math.abs(latestHigh.price - latestLow.price);
  if (range === 0) return [];

  const ratios = [0.382, 0.5, 0.618];
  const levels: number[] = [];

  for (const r of ratios) {
    if (isBullish) {
      levels.push(latestHigh.price - range * r);
    } else {
      levels.push(latestLow.price + range * r);
    }
  }

  return levels.filter(p => p > 0 && Number.isFinite(p));
}
