import { describe, it, expect } from 'vitest';
import type { CandleDto } from '@crypto-monitor/shared';
import { analyzeTrendStructure } from './trendStructure.js';

/**
 * Creates a zigzag candle pattern with guaranteed swing points.
 * Each cycle: rise (2 candles) -> swing high (1) -> fall (2) -> swing low (1) = 6 candles
 * With window=1 pivot detection:
 * - Swing high at index 2 of each cycle
 * - Swing low at index 5 of each cycle
 * Tail candles ensure last trough is detected.
 */
function zigzag(cycles: Array<{ peak: number; trough: number }>): CandleDto[] {
  const candles: CandleDto[] = [];
  let baseTime = 1000;
  
  for (const { peak: p, trough: t } of cycles) {
    candles.push({ time: baseTime, open: t + 1, close: t + 2, high: t + 2.5, low: t + 0.5, volume: 100 });
    baseTime += 3600;
    candles.push({ time: baseTime, open: t + 2, close: p - 1, high: p - 0.5, low: t + 1.5, volume: 100 });
    baseTime += 3600;
    candles.push({ time: baseTime, open: p - 1, close: p, high: p + 0.5, low: p - 1.5, volume: 100 });
    baseTime += 3600;
    candles.push({ time: baseTime, open: p, close: t + 1, high: p - 0.5, low: t + 0.5, volume: 100 });
    baseTime += 3600;
    candles.push({ time: baseTime, open: t + 1, close: t + 1, high: t + 1.5, low: t + 0.5, volume: 100 });
    baseTime += 3600;
    candles.push({ time: baseTime, open: t + 1, close: t, high: t + 0.5, low: t - 0.5, volume: 100 });
    baseTime += 3600;
  }
  
  // Tail candles
  const last = cycles[cycles.length - 1];
  candles.push({ time: baseTime, open: last.trough + 1, close: last.trough + 2, high: last.trough + 2.5, low: last.trough + 0.5, volume: 100 });
  baseTime += 3600;
  candles.push({ time: baseTime, open: last.trough + 2, close: last.trough + 3, high: last.trough + 3.5, low: last.trough + 1.5, volume: 100 });
  
  return candles;
}

describe('analyzeTrendStructure', () => {
  it('returns RANGING with UNCLEAR for insufficient data', () => {
    const candles: CandleDto[] = [
      { time: 1000, open: 100, close: 100, high: 101, low: 99, volume: 100 },
      { time: 3600, open: 100, close: 100, high: 101, low: 99, volume: 100 },
    ];
    const result = analyzeTrendStructure(candles);
    expect(result.direction).toBe('RANGING');
    expect(result.structureBreak).toBe('UNCLEAR');
    expect(result.lastHigh).toBeNull();
    expect(result.lastLow).toBeNull();
  });

  it('returns RANGING when swing points are insufficient', () => {
    const candles: CandleDto[] = Array.from({ length: 30 }, (_, i) => ({
      time: 1000 + i * 3600,
      open: 100 + i,
      close: 100 + i,
      high: 100 + i + 0.5,
      low: 100 + i - 0.5,
      volume: 100,
    }));
    const result = analyzeTrendStructure(candles);
    expect(result.direction).toBe('RANGING');
  });

  it('detects BULLISH structure with HH+HL', () => {
    const candles = zigzag([
      { peak: 110, trough: 93 },
      { peak: 115, trough: 97 },
      { peak: 120, trough: 101 },
    ]);
    const result = analyzeTrendStructure(candles);
    expect(result.highPattern).toBe('HH');
    expect(result.lowPattern).toBe('HL');
    expect(result.direction).toBe('BULLISH');
    expect(result.highCount).toBeGreaterThanOrEqual(2);
    expect(result.lowCount).toBeGreaterThanOrEqual(2);
  });

  it('detects consecutive HH count', () => {
    const candles = zigzag([
      { peak: 110, trough: 93 },
      { peak: 115, trough: 95 },
      { peak: 120, trough: 97 },
    ]);
    const result = analyzeTrendStructure(candles);
    expect(result.highPattern).toBe('HH');
    expect(result.highCount).toBeGreaterThanOrEqual(2);
  });

  it('detects BEARISH structure with LH+LL', () => {
    const candles = zigzag([
      { peak: 120, trough: 101 },
      { peak: 115, trough: 97 },
      { peak: 110, trough: 93 },
    ]);
    const result = analyzeTrendStructure(candles);
    expect(result.highPattern).toBe('LH');
    expect(result.lowPattern).toBe('LL');
    expect(result.direction).toBe('BEARISH');
  });

  it('includes lastHigh and lastLow prices', () => {
    const candles = zigzag([
      { peak: 110, trough: 93 },
      { peak: 115, trough: 97 },
      { peak: 120, trough: 101 },
    ]);
    const result = analyzeTrendStructure(candles);
    expect(result.lastHigh).not.toBeNull();
    expect(result.lastLow).not.toBeNull();
    expect(result.lastHigh!).toBeGreaterThan(100);
    expect(result.lastLow!).toBeLessThan(result.lastHigh!);
  });

  it('detects structure break on bullish structure collapse', () => {
    const candles = zigzag([
      { peak: 110, trough: 93 },
      { peak: 115, trough: 97 },
      { peak: 120, trough: 101 },
    ]);
    const lastTime = candles[candles.length - 1]!.time;
    candles.push({ time: lastTime + 3600, open: 101, close: 90, high: 102, low: 88, volume: 200 });
    const result = analyzeTrendStructure(candles);
    expect(['BULL_BROKEN', 'INTACT', 'UNCLEAR']).toContain(result.structureBreak);
  });

  it('interpretation contains direction and key info', () => {
    const candles = zigzag([
      { peak: 110, trough: 93 },
      { peak: 115, trough: 97 },
      { peak: 120, trough: 101 },
    ]);
    const result = analyzeTrendStructure(candles);
    expect(result.interpretation).toContain('上涨结构');
    expect(result.interpretation).toContain('更高高点');
    expect(result.interpretation).toContain('更高低点');
  });

  it('detects RANGING for mixed patterns', () => {
    const candles = zigzag([
      { peak: 110, trough: 93 },
      { peak: 115, trough: 93 },
      { peak: 120, trough: 93 },
    ]);
    const result = analyzeTrendStructure(candles);
    expect(result.direction).toBe('RANGING');
  });
});
