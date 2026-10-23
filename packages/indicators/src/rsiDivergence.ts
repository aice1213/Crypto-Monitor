import type { CandleDto, RsiDivergenceSignal } from '@crypto-monitor/shared';
import { findPivots } from './pivots.js';

/** Pivot window for swing detection (same as trendStructure) */
const PIVOT_WINDOW = 3;

/** Minimum RSI delta to consider a divergence meaningful (percentage points) */
const MIN_RSI_DELTA = 3;

/** Maximum bars from the most recent pivot to consider "recent" divergence */
const MAX_RECENT_BARS = 20;

/** Minimum bars between two swing points (avoids noise from adjacent candles) */
const MIN_GAP = 3;

/** Maximum bars between two swing points (divergence should be visible, not stretched) */
const MAX_GAP = 25;

/**
 * Detect RSI divergence between consecutive swing points.
 *
 * Logic:
 * - Bullish (bottom) divergence: price makes a lower low, but RSI makes a higher low.
 *   Indicates weakening downward momentum → potential reversal up.
 * - Bearish (top) divergence: price makes a higher high, but RSI makes a lower high.
 *   Indicates weakening upward momentum → potential reversal down.
 *
 * Only reports the most recent divergence (within MAX_RECENT_BARS from latest pivot),
 * if any. Returns null when no meaningful divergence is found.
 */
export function detectRsiDivergence(
  candles: CandleDto[],
  rsiArr: number[],
): RsiDivergenceSignal | null {
  const n = candles.length;
  if (n < PIVOT_WINDOW * 2 + 2) return null;

  const { highs, lows } = findPivots(candles, PIVOT_WINDOW);

  // ── Bullish divergence: consecutive swing lows ──
  if (lows.length >= 2) {
    const first = lows[lows.length - 2]!;
    const second = lows[lows.length - 1]!;
    const gap = second.index - first.index;
    const rsiFirst = rsiArr[first.index];
    const rsiSecond = rsiArr[second.index];

    if (
      Number.isFinite(rsiFirst) &&
      Number.isFinite(rsiSecond) &&
      gap >= MIN_GAP && // not too close (noise)
      gap <= MAX_GAP && // not too stretched
      second.price < first.price && // price makes lower low
      rsiSecond > rsiFirst && // RSI makes higher low
      rsiSecond - rsiFirst >= MIN_RSI_DELTA // meaningful delta
    ) {
      const delta = rsiSecond - rsiFirst;
      const recent = n - second.index <= MAX_RECENT_BARS;
      if (recent) {
        return {
          type: 'BULLISH',
          firstIndex: first.index,
          firstPrice: first.price,
          firstRsi: rsiFirst,
          secondIndex: second.index,
          secondPrice: second.price,
          secondRsi: rsiSecond,
          rsiDelta: delta,
          interpretation: `RSI底背离：价格新低(${first.price.toFixed(2)}→${second.price.toFixed(2)})，RSI反弹(${rsiFirst.toFixed(1)}→${rsiSecond.toFixed(1)}，+${delta.toFixed(1)})，下跌动能减弱，关注反转机会`,
        };
      }
    }
  }

  // ── Bearish divergence: consecutive swing highs ──
  if (highs.length >= 2) {
    const first = highs[highs.length - 2]!;
    const second = highs[highs.length - 1]!;
    const gap = second.index - first.index;
    const rsiFirst = rsiArr[first.index];
    const rsiSecond = rsiArr[second.index];

    if (
      Number.isFinite(rsiFirst) &&
      Number.isFinite(rsiSecond) &&
      gap >= MIN_GAP &&
      gap <= MAX_GAP &&
      second.price > first.price && // price makes higher high
      rsiSecond < rsiFirst && // RSI makes lower high
      rsiFirst - rsiSecond >= MIN_RSI_DELTA // meaningful delta
    ) {
      const delta = rsiFirst - rsiSecond;
      const recent = n - second.index <= MAX_RECENT_BARS;
      if (recent) {
        return {
          type: 'BEARISH',
          firstIndex: first.index,
          firstPrice: first.price,
          firstRsi: rsiFirst,
          secondIndex: second.index,
          secondPrice: second.price,
          secondRsi: rsiSecond,
          rsiDelta: delta,
          interpretation: `RSI顶背离：价格新高(${first.price.toFixed(2)}→${second.price.toFixed(2)})，RSI回落(${rsiFirst.toFixed(1)}→${rsiSecond.toFixed(1)}，-${delta.toFixed(1)})，上涨动能减弱，警惕回调`,
        };
      }
    }
  }

  return null;
}
