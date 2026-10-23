import { describe, it, expect } from 'vitest';
import type { CandleDto } from '@crypto-monitor/shared';
import { analyzePullbackHealth } from './pullbackHealth.js';

/**
 * Create candles from close prices.
 * high = close + 1, low = close - 1, volume = 1000 (default).
 *
 * With this mapping, pivot detection reduces to:
 *   pivot high at i: close[i] > close[i-w..i+w]  (strict local max)
 *   pivot low  at i: close[i] < close[i-w..i+w]  (strict local min)
 *
 * findPivots checks i from window to n-1-window (exclusive).
 * So for n=24, window=2: pivots only at i=2..21.
 * Peak at i=22 or later CANNOT form a pivot → good for UP trend tests.
 */
function seq(closes: number[], volumes?: number[]): CandleDto[] {
  return closes.map((c, i) => ({
    time: 1000 + i * 60,
    open: c,
    high: c + 1,
    low: c - 1,
    close: c,
    volume: volumes ? volumes[i] ?? 1000 : 1000,
  }));
}

// ── Shared test datasets ──

/**
 * UP trend: n=24, window=min(3,floor(24/10))=2
 *
 * Pivot high at i=6  (high=43 > neighbors 39,41,41,39)
 * Pivot low  at i=16 (low=24 < neighbors 27,26,26,28)
 *
 * lastLow.index=16 > lastHigh.index=6 → trendDir=UP
 * anchorIdx=16, anchorPrice=25
 *
 * Peak scan i=17..23: close[22]=35 is max (i=22 > n-window=22, so NO pivot)
 * totalMove = 35 - 25 = 10
 *
 * Vary close[23] to control pullbackPct:
 *   close[23]=31 → pullbackPct = (35-31)/10 = 0.4  (shallow)
 *   close[23]=30 → pullbackPct = (35-30)/10 = 0.5  (50% Fib)
 *   close[23]=25 → pullbackPct = (35-25)/10 = 0.9  (deep)
 */
const UP_BASE = [
  30, 32, 34, 36, 38, 40, 42,   // i=0-6
  40, 38, 36, 34, 32, 30, 28,   // i=7-13
  26, 27, 25, 27, 29, 31, 32,   // i=14-20
  33, 35,                        // i=21-22
]; // length 23, append close[23] per test

/**
 * DOWN trend: n=30, window=min(3,3)=3
 *
 * Pivot low  at i=4  (low=44 < neighbors 49,47,45,46,49,52)
 * Pivot high at i=13 (high=71 > neighbors 66,69,70,69,67,66)
 *
 * lastHigh.index=13 > lastLow.index=4 → trendDir=DOWN
 * anchorIdx=13, anchorPrice=70
 *
 * Trough scan i=14..29: close[27]=54 is min (i=27 > n-1-window=26, so NO pivot)
 * totalMove = 70 - 54 = 16
 *
 * Vary close[29] to control pullbackPct:
 *   close[29]=60 → pullbackPct = (60-54)/16 = 0.375 (shallow)
 *   close[29]=62 → pullbackPct = (62-54)/16 = 0.5   (50% Fib)
 */
const DOWN_BASE = [
  50, 50, 48, 46, 45,              // i=0-4
  47, 50, 53, 56, 59, 62, 65, 68,  // i=5-11
  69, 70, 68,                      // i=12-14
  66, 65, 63, 62, 61, 60, 59,      // i=15-21
  58, 57, 56, 55, 56, 54, 55,      // i=22-28
]; // length 29, append close[29] per test

describe('analyzePullbackHealth', () => {
  it('returns INSUFFICIENT_DATA when < 20 candles', () => {
    const closes = [50, 51, 52, 53, 54, 55, 56, 57, 58, 59,
                    60, 61, 62, 63, 64, 65, 66, 67, 68]; // 19 candles
    const result = analyzePullbackHealth(seq(closes));
    expect(result.state).toBe('INSUFFICIENT_DATA');
    expect(result.rating).toBe('UNKNOWN');
  });

  it('returns all-zero fields for INSUFFICIENT_DATA', () => {
    const result = analyzePullbackHealth(seq([50, 50, 50]));
    expect(result.state).toBe('INSUFFICIENT_DATA');
    expect(result.rating).toBe('UNKNOWN');
    expect(result.pullbackPct).toBe(0);
    expect(result.pullbackBars).toBe(0);
    expect(result.volumeRatio).toBe(0);
    expect(result.atrSlope).toBe(0);
    expect(result.trendDir).toBe('NONE');
  });

  it('returns NO_SWING for flat data (no strict pivots)', () => {
    const result = analyzePullbackHealth(seq(new Array(24).fill(50)));
    expect(result.state).toBe('NO_SWING');
    expect(result.rating).toBe('UNKNOWN');
  });

  it('returns NO_SWING for monotonic decline (only highs, no lows)', () => {
    const closes = [60, 60, 60, 58, 56, 54, 52, 50, 48, 46, 44, 42,
                    40, 38, 36, 34, 32, 30, 28, 26, 24, 22, 20, 18];
    const result = analyzePullbackHealth(seq(closes));
    expect(result.state).toBe('NO_SWING');
    expect(result.rating).toBe('UNKNOWN');
  });

  it('detects UP trend with shallow pullback (40%)', () => {
    // close[23]=31 → pullbackPct = (35-31)/10 = 0.4
    const closes = [...UP_BASE, 31];
    const result = analyzePullbackHealth(seq(closes));

    expect(result.trendDir).toBe('UP');
    expect(result.pullbackPct).toBeCloseTo(0.4, 1);
    expect(result.pullbackPct).toBeGreaterThan(0.2);
    expect(result.pullbackPct).toBeLessThan(0.5);
    expect(result.rating).toBeDefined();
    expect(result.pullbackBars).toBe(1); // peak at i=22, last at i=23
  });

  it('detects UP trend with deep pullback (>78.6%)', () => {
    // close[23]=25 → pullbackPct = (35-25)/10 = 0.9
    const closes = [...UP_BASE, 25];
    const result = analyzePullbackHealth(seq(closes));

    expect(result.trendDir).toBe('UP');
    expect(result.pullbackPct).toBeCloseTo(0.9, 1);
    expect(result.pullbackPct).toBeGreaterThan(0.78);
    expect(result.rating).toBe('DEEP');
  });

  it('detects DOWN trend with shallow bounce (37.5%)', () => {
    // close[29]=60 → pullbackPct = (60-54)/16 = 0.375
    const closes = [...DOWN_BASE, 60];
    const result = analyzePullbackHealth(seq(closes));

    expect(result.trendDir).toBe('DOWN');
    expect(result.pullbackPct).toBeCloseTo(0.375, 1);
    expect(result.pullbackPct).toBeGreaterThan(0.2);
    expect(result.pullbackPct).toBeLessThan(0.5);
    expect(result.rating).toBeDefined();
    expect(result.pullbackBars).toBe(2); // trough at i=27, last at i=29
  });

  it('detects DOWN trend with bounce near 50% Fibonacci', () => {
    // close[29]=62 → pullbackPct = (62-54)/16 = 0.5
    const closes = [...DOWN_BASE, 62];
    const result = analyzePullbackHealth(seq(closes));

    expect(result.trendDir).toBe('DOWN');
    expect(result.pullbackPct).toBeCloseTo(0.5, 1);
    expect(result.pullbackPct).toBeGreaterThan(0.4);
    expect(result.pullbackPct).toBeLessThan(0.6);
  });

  it('computes volumeRatio correctly for UP trend', () => {
    // High volume (2000) during trend, low (500) during pullback
    const closes = [...UP_BASE, 31];
    const volumes = [
      2000, 2000, 2000, 2000, 2000, 2000, 2000,
      2000, 2000, 2000, 2000, 2000, 2000, 2000,
      2000, 2000, 2000, 2000, 2000, 2000, 2000,
      2000, 2000, 500,
    ];
    const result = analyzePullbackHealth(seq(closes, volumes));

    expect(result.trendDir).toBe('UP');
    expect(result.volumeRatio).toBeGreaterThan(0);
    expect(result.volumeRatio).toBeLessThan(1); // pullback < trend volume
    expect(result.atrSlope).toBeDefined();
  });

  it('builds meaningful interpretation for UP trend', () => {
    const closes = [...UP_BASE, 31];
    const result = analyzePullbackHealth(seq(closes));

    expect(result.interpretation).toContain('上涨');
    expect(result.interpretation).toContain('回调');
    expect(result.interpretation.length).toBeGreaterThan(10);
  });

  it('interpretation includes Fibonacci reference near 50%', () => {
    // close[23]=30 → pullbackPct = (35-30)/10 = 0.5 → near Fib 50%
    const closes = [...UP_BASE, 30];
    const result = analyzePullbackHealth(seq(closes));

    expect(result.trendDir).toBe('UP');
    expect(result.pullbackPct).toBeCloseTo(0.5, 1);
    expect(result.interpretation).toContain('50%');
  });

  it('computes pullbackBars as distance from peak to last bar', () => {
    const closes = [...UP_BASE, 31];
    const result = analyzePullbackHealth(seq(closes));
    // Peak at i=22, last at i=23 → 1 bar
    expect(result.pullbackBars).toBe(1);
  });

  it('returns DEEP rating for UP deep pullback with heavy volume', () => {
    // close[23]=25 → pullbackPct=0.9, high pullback volume → DEEP
    const closes = [...UP_BASE, 25];
    const volumes = [
      2000, 2000, 2000, 2000, 2000, 2000, 2000,
      2000, 2000, 2000, 2000, 2000, 2000, 2000,
      2000, 2000, 2000, 2000, 2000, 2000, 2000,
      2000, 2000, 2000,
    ];
    const result = analyzePullbackHealth(seq(closes, volumes));

    expect(result.trendDir).toBe('UP');
    expect(result.pullbackPct).toBeGreaterThan(0.78);
    // volumeRatio ≈ 2000/2000 = 1.0, not > 1, so DEEP (not BROKEN)
    expect(result.rating).toBe('DEEP');
  });
});
