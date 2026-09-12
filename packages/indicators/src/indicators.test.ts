import { describe, it, expect } from 'vitest';
import { ema, rsi, computeSnapshot, buildTradePlan, compositeScore } from './index.js';
import type { CandleDto } from '@crypto-monitor/shared';

function genCandles(n: number, start = 100, drift = 0.1): CandleDto[] {
  const out: CandleDto[] = [];
  let price = start;
  for (let i = 0; i < n; i++) {
    const open = price;
    const close = price + drift + (Math.sin(i) * 2);
    const high = Math.max(open, close) + 1;
    const low = Math.min(open, close) - 1;
    out.push({
      time: 1700000000 + i * 900,
      open,
      high,
      low,
      close,
      volume: 1000 + i * 10,
    });
    price = close;
  }
  return out;
}

describe('ema', () => {
  it('平滑上升序列，EMA 单调递增', () => {
    const vals = Array.from({ length: 50 }, (_, i) => 100 + i);
    const e = ema(vals, 14);
    expect(e.length).toBe(50);
    expect(e[13]).toBeGreaterThan(0);
    expect(e[49]).toBeGreaterThan(e[13]);
  });
});

describe('rsi', () => {
  it('持续上涨 RSI 接近 100', () => {
    const vals = Array.from({ length: 30 }, (_, i) => 100 + i);
    const r = rsi(vals, 14);
    const last = r[r.length - 1];
    expect(last).toBeGreaterThan(90);
  });

  it('持续下跌 RSI 接近 0', () => {
    const vals = Array.from({ length: 30 }, (_, i) => 100 - i);
    const r = rsi(vals, 14);
    const last = r[r.length - 1];
    expect(last).toBeLessThan(10);
  });
});

describe('computeSnapshot', () => {
  it('数据不足 30 根返回 INSUFFICIENT 且无 plan', () => {
    const candles = genCandles(10);
    const snap = computeSnapshot(candles, '15m');
    expect(snap.dataQuality).toBe('INSUFFICIENT');
    expect(snap.plan).toBeNull();
  });

  it('200 根数据能计算完整快照', () => {
    const candles = genCandles(200);
    const snap = computeSnapshot(candles, '15m');
    expect(snap.dataQuality).not.toBe('INSUFFICIENT');
    expect(snap.ema7).toBeGreaterThan(0);
    expect(snap.ema25).toBeGreaterThan(0);
    expect(snap.rsi14).toBeGreaterThanOrEqual(0);
    expect(snap.rsi14).toBeLessThanOrEqual(100);
    expect(snap.trend.score).toBeGreaterThanOrEqual(-100);
    expect(snap.trend.score).toBeLessThanOrEqual(100);
    expect(snap.support.length).toBeLessThanOrEqual(3);
    expect(snap.resistance.length).toBeLessThanOrEqual(3);
  });
});

describe('compositeScore', () => {
  it('全部看涨信号得分 >= 40', () => {
    const t = compositeScore({
      emaStructure: 'BULLISH',
      macd: { dif: 1, dea: 0, hist: 2, signal: 'GOLDEN_CROSS' },
      rsiZone: 'OVERSOLD',
      obvFlow: 'INFLOW',
    });
    expect(t.direction).toBe('BULLISH');
    expect(t.score).toBeGreaterThanOrEqual(40);
  });

  it('全部看跌信号得分 <= -40', () => {
    const t = compositeScore({
      emaStructure: 'BEARISH',
      macd: { dif: -1, dea: 0, hist: -2, signal: 'DEATH_CROSS' },
      rsiZone: 'OVERBOUGHT',
      obvFlow: 'OUTFLOW',
    });
    expect(t.direction).toBe('BEARISH');
    expect(t.score).toBeLessThanOrEqual(-40);
  });
});

describe('buildTradePlan', () => {
  it('盈亏比不足时返回 null', () => {
    const plan = buildTradePlan({
      direction: 'BULLISH',
      score: 50,
      ema25: 100,
      support: [99],
      resistance: [100.5],
    });
    expect(plan).toBeNull();
  });

  it('震荡方向返回 null', () => {
    const plan = buildTradePlan({
      direction: 'RANGING',
      score: 0,
      ema25: 100,
      support: [95],
      resistance: [105],
    });
    expect(plan).toBeNull();
  });

  it('多头计划参数合理', () => {
    const plan = buildTradePlan({
      direction: 'BULLISH',
      score: 60,
      ema25: 100,
      support: [95, 90],
      resistance: [110, 120],
    });
    expect(plan).not.toBeNull();
    expect(plan!.side).toBe('LONG');
    expect(plan!.tp1).toBe(110);
    expect(plan!.tp2).toBeGreaterThan(plan!.tp1);
    expect(plan!.sl).toBeLessThan(plan!.entryLow);
    expect(plan!.rrRatio).toBeGreaterThanOrEqual(1.5);
  });
});
