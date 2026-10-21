import { describe, it, expect } from 'vitest';
import type { CandleDto, PatternSignal } from '@crypto-monitor/shared';
import { classifySwingStrategy } from './swingStrategy.js';
import { ema } from './ema.js';

/**
 * 构造测试用 K 线。
 */
function candle(i: number, o: number, h: number, l: number, c: number, v = 1000): CandleDto {
  return { time: 1_700_000_000 + i * 900, open: o, high: h, low: l, close: c, volume: v };
}

/**
 * 生成稳定的 warmup K 线（价格围绕 base 小幅波动）。
 */
function makeWarmup(count: number, base = 100): CandleDto[] {
  const candles: CandleDto[] = [];
  for (let i = 0; i < count; i++) {
    const open = base + i * 0.05;
    candles.push(candle(i, open, open + 0.8, open - 0.6, open + 0.3));
  }
  return candles;
}

/**
 * 生成 EMA50 数组（需要与 candles 等长）。
 */
function makeEma50Arr(candles: CandleDto[]): number[] {
  return ema(candles.map(c => c.close), 50);
}

/**
 * 构造最小 PatternSignal（用于测试假突破等场景）。
 */
function fakePattern(overrides: Partial<PatternSignal>): PatternSignal {
  return {
    type: 'FAKEY',
    direction: 'BEARISH',
    strength: 0.7,
    quality: 'HIGH',
    score: 3,
    index: 95,
    time: 1_700_000_000 + 95 * 900,
    eventZoneId: null,
    failed: false,
    strategy: 'REVERSAL',
    breakoutLevel: null,
    retracementEntry: null,
    ...overrides,
  };
}

/* ─── 基础行为 ─── */

describe('classifySwingStrategy 基础行为', () => {
  it('数据不足返回 NO_SETUP', () => {
    const candles = makeWarmup(10);
    const ema50Arr = makeEma50Arr(candles);
    const result = classifySwingStrategy(candles, ema50Arr, [], [], []);
    expect(result.setup).toBe('NO_SETUP');
    expect(result.direction).toBe('NEUTRAL');
    expect(result.confidence).toBe(0);
  });

  it('价格在中间位置无关键位无形态 → NO_SETUP', () => {
    // 下跌 warmup：价格远离 EMA50（不在 1.5% 阈值内），影线短不触发拒绝信号
    const candles: CandleDto[] = [];
    for (let i = 0; i < 40; i++) {
      const open = 100 - i * 0.2;
      candles.push(candle(i, open, open + 0.1, open - 0.3, open - 0.1));
    }
    const ema50Arr = makeEma50Arr(candles);
    // 支撑/阻力都远离当前价格
    const price = candles[candles.length - 1]!.close;
    const result = classifySwingStrategy(
      candles,
      ema50Arr,
      [price - 100],
      [price + 100],
      [],
    );
    expect(result.setup).toBe('NO_SETUP');
  });
});

/* ─── 区间震荡 ─── */

describe('区间震荡策略', () => {
  it('价格在支撑位附近 + 看涨 Pinbar → RANGE_LOW', () => {
    const candles = makeWarmup(35);
    // 在支撑位附近制造看涨 Pinbar（长下影线）
    candles.push(candle(35, 100.5, 101, 98, 100.8)); // 长下影线，close 靠近支撑
    const ema50Arr = makeEma50Arr(candles);
    const price = candles[candles.length - 1]!.close;
    const supportArr = [price]; // 支撑位 = 当前价格附近

    const patterns = [fakePattern({
      type: 'PINBAR',
      direction: 'BULLISH',
      index: candles.length - 1,
      strategy: 'REVERSAL',
    })];

    const result = classifySwingStrategy(candles, ema50Arr, supportArr, [], patterns);
    expect(result.setup).toBe('RANGE_LOW');
    expect(result.direction).toBe('LONG');
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.stopLoss).not.toBeNull();
    expect(result.takeProfit).not.toBeNull();
  });
});

/* ─── 顺势抓浪 ─── */

describe('顺势抓浪策略', () => {
  it('价格在 EMA50 附近（上方）+ 看涨信号 → TREND_PULLBACK_LONG', () => {
    const candles = makeWarmup(35);
    const ema50Arr = makeEma50Arr(candles);
    const ema50Val = ema50Arr[ema50Arr.length - 1]!;
    // 确保价格在 EMA50 附近
    // 添加一根在 EMA50 附近的看涨 K 线
    candles.push(candle(35, ema50Val, ema50Val * 1.005, ema50Val * 0.995, ema50Val * 1.003));

    const price = candles[candles.length - 1]!.close;
    const ema50 = ema50Arr[ema50Arr.length - 1]!;
    // EMA50 价值区间内
    expect(Math.abs(price - ema50) / ema50).toBeLessThanOrEqual(0.015);
    expect(price).toBeGreaterThanOrEqual(ema50);

    const result = classifySwingStrategy(
      candles,
      ema50Arr,
      [],
      [],
      [fakePattern({
        type: 'PINBAR',
        direction: 'BULLISH',
        index: candles.length - 1,
        strategy: 'REVERSAL',
      })],
    );
    expect(result.setup).toBe('TREND_PULLBACK_LONG');
    expect(result.direction).toBe('LONG');
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.stopLoss).toBeLessThan(ema50);
    expect(result.takeProfit).toBeGreaterThan(ema50);
  });
});

/* ─── 逆势反转 ─── */

describe('逆势反转策略', () => {
  it('价格在阻力位 + 假突破 → COUNTER_TREND_BEARISH', () => {
    const candles = makeWarmup(35);
    const ema50Arr = makeEma50Arr(candles);
    // 阻力位附近 + 假突破看跌形态
    const resistance = 101;
    candles.push(candle(35, 100.5, 101.5, 100, 100.2)); // 假突破：冲高回落

    const price = candles[candles.length - 1]!.close;
    const resistanceArr = [resistance];

    const patterns = [fakePattern({
      type: 'FAKEY',
      direction: 'BEARISH',
      index: candles.length - 1,
      strategy: 'REVERSAL',
    })];

    const result = classifySwingStrategy(candles, ema50Arr, [], resistanceArr, patterns);
    expect(result.setup).toBe('COUNTER_TREND_BEARISH');
    expect(result.direction).toBe('SHORT');
    expect(result.confidence).toBeGreaterThanOrEqual(90);
    expect(result.stopLoss).toBeGreaterThan(resistance);
    expect(result.takeProfit).toBeLessThan(price);
    expect(result.riskNote).toContain('逆势');
  });

  it('价格在支撑位 + 假突破看涨 → COUNTER_TREND_BULLISH', () => {
    const candles = makeWarmup(35);
    const ema50Arr = makeEma50Arr(candles);
    const support = 99;
    // 收盘靠近支撑位（1% 阈值内）：下探收回形成假突破看涨
    candles.push(candle(35, 99.5, 100, 98.5, 99.2));

    const price = candles[candles.length - 1]!.close;
    const supportArr = [support];

    const patterns = [fakePattern({
      type: 'FAKEY',
      direction: 'BULLISH',
      index: candles.length - 1,
      strategy: 'REVERSAL',
    })];

    const result = classifySwingStrategy(candles, ema50Arr, supportArr, [], patterns);
    expect(result.setup).toBe('COUNTER_TREND_BULLISH');
    expect(result.direction).toBe('LONG');
    expect(result.confidence).toBeGreaterThanOrEqual(90);
    expect(result.stopLoss).toBeLessThan(support);
    expect(result.takeProfit).toBeGreaterThan(price);
  });
});

/* ─── 优先级 ─── */

describe('策略优先级', () => {
  it('逆势反转优先于区间震荡', () => {
    // 同一价格同时在支撑位和阻力位附近（不可能，但用假突破强制触发逆势）
    const candles = makeWarmup(35);
    const ema50Arr = makeEma50Arr(candles);
    const resistance = 101;
    candles.push(candle(35, 100.5, 101.5, 100, 100.2));

    const price = candles[candles.length - 1]!.close;
    const supportArr = [price];
    const resistanceArr = [resistance];

    const patterns = [fakePattern({
      type: 'FAKEY',
      direction: 'BEARISH',
      index: candles.length - 1,
      strategy: 'REVERSAL',
    })];

    const result = classifySwingStrategy(candles, ema50Arr, supportArr, resistanceArr, patterns);
    // 假突破看跌 → 逆势做空优先
    expect(result.setup).toBe('COUNTER_TREND_BEARISH');
  });

  it('顺势抓浪优先于区间震荡', () => {
    const candles = makeWarmup(35);
    const ema50Arr = makeEma50Arr(candles);
    const ema50Val = ema50Arr[ema50Arr.length - 1]!;
    // 价格在 EMA50 附近 + 同时有支撑位
    candles.push(candle(35, ema50Val, ema50Val * 1.005, ema50Val * 0.995, ema50Val * 1.003));

    const price = candles[candles.length - 1]!.close;
    const supportArr = [price];

    const patterns = [fakePattern({
      type: 'PINBAR',
      direction: 'BULLISH',
      index: candles.length - 1,
      strategy: 'REVERSAL',
    })];

    const result = classifySwingStrategy(candles, ema50Arr, supportArr, [], patterns);
    // EMA50 附近 → 顺势优先于区间
    expect(result.setup).toBe('TREND_PULLBACK_LONG');
  });
});

/* ─── 止损止盈合理性 ─── */

describe('止损止盈合理性', () => {
  it('做多止损 < 入场价，止盈 > 入场价', () => {
    const candles = makeWarmup(35);
    const ema50Arr = makeEma50Arr(candles);
    const ema50Val = ema50Arr[ema50Arr.length - 1]!;
    candles.push(candle(35, ema50Val, ema50Val * 1.005, ema50Val * 0.995, ema50Val * 1.003));

    const price = candles[candles.length - 1]!.close;
    const result = classifySwingStrategy(
      candles,
      ema50Arr,
      [],
      [],
      [fakePattern({
        type: 'PINBAR',
        direction: 'BULLISH',
        index: candles.length - 1,
        strategy: 'REVERSAL',
      })],
    );
    expect(result.setup).not.toBe('NO_SETUP');
    if (result.direction === 'LONG') {
      expect(result.stopLoss!).toBeLessThan(price);
      expect(result.takeProfit!).toBeGreaterThan(price);
    }
  });

  it('做空止损 > 入场价，止盈 < 入场价', () => {
    const candles = makeWarmup(35);
    const ema50Arr = makeEma50Arr(candles);
    const resistance = 101;
    candles.push(candle(35, 100.5, 101.5, 100, 100.2));

    const price = candles[candles.length - 1]!.close;
    const result = classifySwingStrategy(
      candles,
      ema50Arr,
      [],
      [resistance],
      [fakePattern({
        type: 'FAKEY',
        direction: 'BEARISH',
        index: candles.length - 1,
        strategy: 'REVERSAL',
      })],
    );
    expect(result.setup).not.toBe('NO_SETUP');
    if (result.direction === 'SHORT') {
      expect(result.stopLoss!).toBeGreaterThan(price);
      expect(result.takeProfit!).toBeLessThan(price);
    }
  });
});

/* ─── 风险文案 ─── */

describe('风险文案', () => {
  it('逆势交易包含紧凑止损提示', () => {
    const candles = makeWarmup(35);
    const ema50Arr = makeEma50Arr(candles);
    const resistance = 101;
    candles.push(candle(35, 100.5, 101.5, 100, 100.2));

    const patterns = [fakePattern({
      type: 'FAKEY',
      direction: 'BEARISH',
      index: candles.length - 1,
      strategy: 'REVERSAL',
    })];

    const result = classifySwingStrategy(candles, ema50Arr, [], [resistance], patterns);
    expect(result.riskNote).toContain('紧凑');
  });

  it('顺势交易包含 EMA50 离场提示', () => {
    const candles = makeWarmup(35);
    const ema50Arr = makeEma50Arr(candles);
    const ema50Val = ema50Arr[ema50Arr.length - 1]!;
    candles.push(candle(35, ema50Val, ema50Val * 1.005, ema50Val * 0.995, ema50Val * 1.003));

    const result = classifySwingStrategy(
      candles,
      ema50Arr,
      [],
      [],
      [fakePattern({
        type: 'PINBAR',
        direction: 'BULLISH',
        index: candles.length - 1,
        strategy: 'REVERSAL',
      })],
    );
    expect(result.riskNote).toContain('EMA50');
  });
});
