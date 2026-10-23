import { describe, it, expect } from 'vitest';
import type { CandleDto } from '@crypto-monitor/shared';
import { detectRsiDivergence } from './rsiDivergence.js';

/**
 * Build a baseline array of uniform candles (open=close=60, high=61, low=59).
 * Override specific indices with custom OHLC to create swing points.
 */
function makeCandles(
  length = 50,
  overrides?: Record<number, Partial<CandleDto>>,
): CandleDto[] {
  return Array.from({ length }, (_, i) => {
    const base: CandleDto = {
      time: 1000 + i * 3600,
      open: 60,
      high: 61,
      low: 59,
      close: 60,
      volume: 1000,
    };
    return overrides?.[i] ? { ...base, ...overrides[i] } : base;
  });
}

/** Build an RSI array with a default value, overriding specific indices. */
function makeRsiArr(
  length: number,
  defaultValue = 50,
  overrides?: Record<number, number>,
): number[] {
  return Array.from({ length }, (_, i) => overrides?.[i] ?? defaultValue);
}

describe('detectRsiDivergence', () => {
  // ── Bullish divergence ──

  it('detects bullish divergence: price lower low, RSI higher low', () => {
    // Swing lows: idx 20 (low=49), idx 40 (low=44)
    // Price: 44 < 49 (lower low) ✓
    // RSI: 40 > 25 (higher low) ✓
    // Gap: 20, within [3, 25] ✓
    const candles = makeCandles(50, {
      20: { low: 49 },
      40: { low: 44 },
    });
    const rsiArr = makeRsiArr(50, 50, { 20: 25, 40: 40 });

    const result = detectRsiDivergence(candles, rsiArr);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('BULLISH');
    expect(result!.firstPrice).toBe(49);
    expect(result!.secondPrice).toBe(44);
    expect(result!.secondPrice).toBeLessThan(result!.firstPrice);
    expect(result!.secondRsi).toBeGreaterThan(result!.firstRsi);
    expect(result!.rsiDelta).toBeGreaterThanOrEqual(3);
    expect(result!.firstIndex).toBe(20);
    expect(result!.secondIndex).toBe(40);
  });

  // ── Bearish divergence ──

  it('detects bearish divergence: price higher high, RSI lower high', () => {
    // Swing highs: idx 20 (high=81), idx 40 (high=86)
    // Price: 86 > 81 (higher high) ✓
    // RSI: 60 < 75 (lower high) ✓
    // Gap: 20, within [3, 25] ✓
    const candles = makeCandles(50, {
      20: { high: 81 },
      40: { high: 86 },
    });
    const rsiArr = makeRsiArr(50, 50, { 20: 75, 40: 60 });

    const result = detectRsiDivergence(candles, rsiArr);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('BEARISH');
    expect(result!.firstPrice).toBe(81);
    expect(result!.secondPrice).toBe(86);
    expect(result!.secondPrice).toBeGreaterThan(result!.firstPrice);
    expect(result!.secondRsi).toBeLessThan(result!.firstRsi);
    expect(result!.rsiDelta).toBeGreaterThanOrEqual(3);
    expect(result!.firstIndex).toBe(20);
    expect(result!.secondIndex).toBe(40);
  });

  // ── Null cases ──

  it('returns null for insufficient data', () => {
    const candles = makeCandles(5);
    const rsiArr = makeRsiArr(5);
    expect(detectRsiDivergence(candles, rsiArr)).toBeNull();
  });

  it('returns null when RSI delta is below MIN_RSI_DELTA (3)', () => {
    // Bullish shape but delta = 2 < 3
    const candles = makeCandles(50, {
      20: { low: 49 },
      40: { low: 44 },
    });
    const rsiArr = makeRsiArr(50, 50, { 20: 25, 40: 27 });

    expect(detectRsiDivergence(candles, rsiArr)).toBeNull();
  });

  it('returns null when gap exceeds MAX_GAP (25)', () => {
    // Swing lows at idx 10 and 40 → gap = 30 > 25
    const candles = makeCandles(55, {
      10: { low: 49 },
      40: { low: 44 },
    });
    const rsiArr = makeRsiArr(55, 50, { 10: 25, 40: 40 });

    expect(detectRsiDivergence(candles, rsiArr)).toBeNull();
  });

  it('returns null when second pivot is beyond MAX_RECENT_BARS', () => {
    // Second swing low at idx 30, candle length 60 → 60-30=30 > 20
    const candles = makeCandles(60, {
      10: { low: 49 },
      30: { low: 44 },
    });
    const rsiArr = makeRsiArr(60, 50, { 10: 25, 30: 40 });

    expect(detectRsiDivergence(candles, rsiArr)).toBeNull();
  });

  it('returns null for continuous uptrend (no swing lows)', () => {
    const candles: CandleDto[] = Array.from({ length: 50 }, (_, i) => ({
      time: 1000 + i * 3600,
      open: 50 + i,
      high: 52 + i,
      low: 49 + i,
      close: 51 + i,
      volume: 1000,
    }));
    const rsiArr = makeRsiArr(50);

    expect(detectRsiDivergence(candles, rsiArr)).toBeNull();
  });

  it('returns null when RSI confirms price lower low (no divergence)', () => {
    // Price lower low AND RSI lower low → no bullish divergence
    const candles = makeCandles(50, {
      20: { low: 49 },
      40: { low: 44 },
    });
    const rsiArr = makeRsiArr(50, 50, { 20: 25, 40: 20 });

    expect(detectRsiDivergence(candles, rsiArr)).toBeNull();
  });

  // ── Interpretation & indices ──

  it('includes correct interpretation text for bullish divergence', () => {
    const candles = makeCandles(50, {
      20: { low: 49 },
      40: { low: 44 },
    });
    const rsiArr = makeRsiArr(50, 50, { 20: 25, 40: 40 });

    const result = detectRsiDivergence(candles, rsiArr)!;
    expect(result.interpretation).toContain('底背离');
    expect(result.interpretation).toContain('RSI反弹');
    expect(result.interpretation).toContain('下跌动能减弱');
  });

  it('includes correct interpretation text for bearish divergence', () => {
    const candles = makeCandles(50, {
      20: { high: 81 },
      40: { high: 86 },
    });
    const rsiArr = makeRsiArr(50, 50, { 20: 75, 40: 60 });

    const result = detectRsiDivergence(candles, rsiArr)!;
    expect(result.interpretation).toContain('顶背离');
    expect(result.interpretation).toContain('RSI回落');
    expect(result.interpretation).toContain('上涨动能减弱');
  });

  it('reports correct index ordering and bounds', () => {
    const candles = makeCandles(50, {
      20: { low: 49 },
      40: { low: 44 },
    });
    const rsiArr = makeRsiArr(50, 50, { 20: 25, 40: 40 });

    const result = detectRsiDivergence(candles, rsiArr)!;
    expect(result.firstIndex).toBeGreaterThanOrEqual(0);
    expect(result.firstIndex).toBeLessThan(candles.length);
    expect(result.secondIndex).toBeGreaterThan(result.firstIndex);
    expect(result.secondIndex).toBeLessThan(candles.length);
  });

  it('bullish divergence is checked before bearish when both could match', () => {
    // Candles have both swing lows (for bullish) and swing highs (for bearish).
    // Bullish should take priority since it's checked first.
    const candles = makeCandles(50, {
      20: { low: 49, high: 81 },
      40: { low: 44, high: 86 },
    });
    const rsiArr = makeRsiArr(50, 50, { 20: 25, 40: 40 });

    const result = detectRsiDivergence(candles, rsiArr);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('BULLISH');
  });
});
