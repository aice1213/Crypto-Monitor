import { describe, it, expect } from 'vitest';
import type { CandleDto, PatternContext } from '@crypto-monitor/shared';
import { detectPatterns } from './patterns.js';

/**
 * 构造测试用 K 线。time 从固定基准起递增。
 */
function candle(i: number, o: number, h: number, l: number, c: number, v = 1000): CandleDto {
  return { time: 1_700_000_000 + i * 900, open: o, high: h, low: l, close: c, volume: v };
}

const ctx: PatternContext = { trend: 'BULLISH', support: [], resistance: [] };

/**
 * ATR 需要 15 根预热期，所以每个测试用例前需要 >= 15 根历史K线。
 * 生成稳定的 warmup K 线，每根 range=2，确保 ATR 有值。
 */
function makeWarmup(count: number): CandleDto[] {
  const candles: CandleDto[] = [];
  for (let i = 0; i < count; i++) {
    const open = 100 + i * 0.1;
    candles.push(candle(i, open, open + 1.2, open - 0.8, open + 0.5));
  }
  return candles;
}

describe('detectPatterns 基础行为', () => {
  it('空输入返回空数组', () => {
    expect(detectPatterns([], ctx)).toEqual([]);
  });

  it('K线少于3根返回空数组', () => {
    expect(detectPatterns([candle(0, 10, 11, 9, 10.5), candle(1, 10, 11, 9, 10.5)], ctx)).toEqual([]);
  });

  it('正常上涨序列无虚假形态', () => {
    const candles: CandleDto[] = [];
    let p = 100;
    for (let i = 0; i < 20; i++) {
      const o = p;
      const c = p + 2;
      candles.push(candle(i, o, c + 0.3, o - 0.3, c, 1000));
      p = c;
    }
    const signals = detectPatterns(candles, ctx);
    const bearish = signals.filter(s => s.direction === 'BEARISH');
    expect(bearish.length).toBeLessThan(3);
  });
});

describe('Pinbar 检测', () => {
  it('看涨 Pinbar：长下影线', () => {
    const candles = makeWarmup(16);
    const i = candles.length;
    candles.push(candle(i, 116.6, 116.8, 112, 116.9)); // 下影线=4.6, 上影线=0.3, body=0.3
    const signals = detectPatterns(candles, ctx);
    const pinbar = signals.find(s => s.type === 'PINBAR');
    expect(pinbar).toBeDefined();
    expect(pinbar!.direction).toBe('BULLISH');
    expect(pinbar!.strength).toBeGreaterThan(0);
  });

  it('看跌 Pinbar：长上影线', () => {
    const candles = makeWarmup(16);
    const i = candles.length;
    candles.push(candle(i, 116.6, 121, 116.5, 116.9)); // 上影线=4.1, 下影线=0.1, body=0.3
    const signals = detectPatterns(candles, ctx);
    const pinbar = signals.find(s => s.type === 'PINBAR');
    expect(pinbar).toBeDefined();
    expect(pinbar!.direction).toBe('BEARISH');
  });

  it('正常K线不触发 Pinbar', () => {
    const candles = makeWarmup(16);
    const i = candles.length;
    candles.push(candle(i, 116.6, 116.9, 116.3, 116.7)); // body=0.1, 影线极短
    const signals = detectPatterns(candles, ctx);
    const pinbar = signals.find(s => s.type === 'PINBAR');
    expect(pinbar).toBeUndefined();
  });

  it('影线长但对称：不是 Pinbar', () => {
    const candles = makeWarmup(16);
    const i = candles.length;
    candles.push(candle(i, 116.6, 121, 112, 116.9)); // 上下影线都长 → 十字星
    const signals = detectPatterns(candles, ctx);
    const pinbar = signals.find(s => s.type === 'PINBAR');
    expect(pinbar).toBeUndefined();
  });
});

describe('Inside Bar 检测', () => {
  it('检测标准内包K线', () => {
    const candles = makeWarmup(15);
    // 加一个大的母K线，然后一个小的内包K线
    const i = candles.length;
    candles.push(candle(i, 100, 120, 80, 115));    // 母K线
    candles.push(candle(i + 1, 110, 115, 90, 112)); // 内包K线
    const signals = detectPatterns(candles, ctx);
    const inside = signals.find(s => s.type === 'INSIDE_BAR');
    expect(inside).toBeDefined();
    expect(inside!.direction).toBe('BULLISH'); // 母K线 close=115 > open=100
  });

  it('非内包K线不触发', () => {
    const candles = makeWarmup(15);
    const i = candles.length;
    candles.push(candle(i, 100, 120, 80, 115));
    candles.push(candle(i + 1, 110, 125, 90, 112)); // high=125 > 120 → 突破
    const signals = detectPatterns(candles, ctx);
    const inside = signals.find(s => s.type === 'INSIDE_BAR');
    expect(inside).toBeUndefined();
  });

  it('连续内包只记录最强的一根', () => {
    const candles = makeWarmup(15);
    const i = candles.length;
    candles.push(candle(i, 100, 120, 80, 115));
    candles.push(candle(i + 1, 110, 115, 90, 112));
    candles.push(candle(i + 2, 111, 113, 92, 111.5)); // 也是内包
    const signals = detectPatterns(candles, ctx);
    const inside = signals.filter(s => s.type === 'INSIDE_BAR');
    expect(inside.length).toBeLessThanOrEqual(2);
  });
});

describe('Fakey 假突破', () => {
  it('检测看涨突破后收回的看跌 Fakey', () => {
    const candles = makeWarmup(15);
    const i = candles.length;
    candles.push(candle(i, 100, 115, 85, 110));    // 母K线
    candles.push(candle(i + 1, 105, 110, 90, 105)); // 内包
    candles.push(candle(i + 2, 105, 120, 103, 118)); // 突破：close=118 > 115
    candles.push(candle(i + 3, 118, 112, 88, 105)); // 收回：high=112<=115, low=88>=85
    const signals = detectPatterns(candles, ctx);
    const fakey = signals.find(s => s.type === 'FAKEY');
    expect(fakey).toBeDefined();
    expect(fakey!.direction).toBe('BEARISH');
  });

  it('超时不触发 Fakey', () => {
    const candles = makeWarmup(15);
    const i = candles.length;
    candles.push(candle(i, 100, 115, 85, 110));
    candles.push(candle(i + 1, 105, 110, 90, 105));
    candles.push(candle(i + 2, 105, 120, 103, 118));
    // 4根K线都没有收回
    for (let j = 0; j < 4; j++) {
      candles.push(candle(i + 3 + j, 118, 122, 116, 120));
    }
    const signals = detectPatterns(candles, ctx);
    const fakey = signals.find(s => s.type === 'FAKEY');
    expect(fakey).toBeUndefined();
  });
});

describe('共振评分', () => {
  it('BULLISH 趋势 + 看涨形态 + 高强度 = MEDIUM', () => {
    const bullCtx: PatternContext = { trend: 'BULLISH', support: [], resistance: [] };
    const candles = makeWarmup(16);
    const i = candles.length;
    // 大下影线 Pinbar，body=0.3, lower=4.6
    candles.push(candle(i, 116.6, 116.8, 112, 116.9));
    const signals = detectPatterns(candles, bullCtx);
    const pinbar = signals.find(s => s.type === 'PINBAR' && s.direction === 'BULLISH');
    expect(pinbar).toBeDefined();
    // 趋势一致+1, 强度>=0.5+1 = 2 → MEDIUM（无关键位）
    expect(pinbar!.score).toBeGreaterThanOrEqual(2);
    expect(pinbar!.quality).toBe('MEDIUM');
  });

  it('BEARISH 趋势 + 看涨形态 = 降低质量', () => {
    const bearCtx: PatternContext = { trend: 'BEARISH', support: [], resistance: [] };
    const candles = makeWarmup(16);
    const i = candles.length;
    candles.push(candle(i, 116.6, 116.8, 112, 116.9));
    const signals = detectPatterns(candles, bearCtx);
    const pinbar = signals.find(s => s.type === 'PINBAR' && s.direction === 'BULLISH');
    expect(pinbar).toBeDefined();
    // 趋势不一致，只有强度分 → 最多 1 → LOW
    expect(pinbar!.score).toBeLessThan(2);
    expect(pinbar!.quality).toBe('LOW');
  });

  it('支撑位附近加分 → HIGH', () => {
    // 支撑位在 117 附近，Pinbar close=116.9 距离 < 3%
    const sCtx: PatternContext = { trend: 'BULLISH', support: [117], resistance: [] };
    const candles = makeWarmup(16);
    const i = candles.length;
    candles.push(candle(i, 116.6, 116.8, 112, 116.9));
    const signals = detectPatterns(candles, sCtx);
    const pinbar = signals.find(s => s.type === 'PINBAR');
    expect(pinbar).toBeDefined();
    // 趋势一致+1, 关键位+1, 强度+1 = 3 → HIGH
    expect(pinbar!.score).toBe(3);
    expect(pinbar!.quality).toBe('HIGH');
  });
});

describe('窗口和去重', () => {
  it('只返回最近 windowBars 根内的信号', () => {
    const candles: CandleDto[] = [];
    // 前20根：稳定K线
    let p = 100;
    for (let i = 0; i < 20; i++) {
      const o = p;
      const c = p + 1;
      candles.push(candle(i, o, c + 0.2, o - 0.2, c, 1000));
      p = c;
    }
    // 第21根：大 Pinbar
    candles.push(candle(20, p, p + 0.1, p - 5, p + 0.3));

    // 窗口=15 → 起始索引=21-15=6，index=20 >= 6 → 应包含
    const allSignals = detectPatterns(candles, ctx, { windowBars: 15 });
    expect(allSignals.some(s => s.index === 20)).toBe(true);

    // 窗口=5 → 起始索引=21-5=16，index=20 >= 16 → 仍包含
    const fewSignals = detectPatterns(candles, ctx, { windowBars: 5 });
    expect(fewSignals.some(s => s.index === 20)).toBe(true);

    // 窗口=1 → 起始索引=20，index=20 >= 20 → 刚好包含
    const oneBar = detectPatterns(candles, ctx, { windowBars: 1 });
    expect(oneBar.some(s => s.index === 20)).toBe(true);
  });

  it('同一根K线只保留最强的形态', () => {
    const candles = makeWarmup(15);
    const i = candles.length;
    candles.push(candle(i, 100, 120, 80, 115));   // 大母K线
    candles.push(candle(i + 1, 110, 115, 90, 112)); // 内包 + 可能有Pinbar
    const signals = detectPatterns(candles, ctx);
    const indices = signals.map(s => s.index);
    expect(new Set(indices).size).toBe(indices.length);
  });
});

/* ─── 策略分类 & 突破价位 ─── */

describe('策略分类（REVERSAL vs BREAKOUT）', () => {
  it('关键位附近的形态 → REVERSAL', () => {
    // 支撑位在 117 附近，Pinbar close=116.9 距离 < 3%
    const sCtx: PatternContext = { trend: 'BULLISH', support: [117], resistance: [] };
    const candles = makeWarmup(16);
    const i = candles.length;
    candles.push(candle(i, 116.6, 116.8, 112, 116.9));
    const signals = detectPatterns(candles, sCtx);
    const pinbar = signals.find(s => s.type === 'PINBAR');
    expect(pinbar).toBeDefined();
    expect(pinbar!.strategy).toBe('REVERSAL');
    expect(pinbar!.breakoutLevel).toBeNull();
  });

  it('非关键位形态 → BREAKOUT', () => {
    // 无关键位
    const noCtx: PatternContext = { trend: 'BULLISH', support: [], resistance: [] };
    const candles = makeWarmup(16);
    const i = candles.length;
    candles.push(candle(i, 116.6, 116.8, 112, 116.9)); // BULLISH Pinbar
    const signals = detectPatterns(candles, noCtx);
    const pinbar = signals.find(s => s.type === 'PINBAR');
    expect(pinbar).toBeDefined();
    expect(pinbar!.strategy).toBe('BREAKOUT');
  });

  it('看涨突破 → breakoutLevel = rangeHigh + 0.25×ATR', () => {
    const noCtx: PatternContext = { trend: 'BULLISH', support: [], resistance: [] };
    const candles = makeWarmup(16);
    const i = candles.length;
    // BULLISH Pinbar: high=116.8
    candles.push(candle(i, 116.6, 116.8, 112, 116.9));
    const signals = detectPatterns(candles, noCtx);
    const pinbar = signals.find(s => s.type === 'PINBAR');
    expect(pinbar).toBeDefined();
    expect(pinbar!.strategy).toBe('BREAKOUT');
    // breakoutLevel should be > rangeHigh (116.8), because buffer is positive
    expect(pinbar!.breakoutLevel!).toBeGreaterThan(116.8);
  });

  it('看跌突破 → breakoutLevel = rangeLow - 0.25×ATR', () => {
    const noCtx: PatternContext = { trend: 'BEARISH', support: [], resistance: [] };
    const candles = makeWarmup(16);
    const i = candles.length;
    // BEARISH Pinbar: low=116.5
    candles.push(candle(i, 116.6, 121, 116.5, 116.9)); // 上影线长
    const signals = detectPatterns(candles, noCtx);
    const pinbar = signals.find(s => s.type === 'PINBAR' && s.direction === 'BEARISH');
    expect(pinbar).toBeDefined();
    expect(pinbar!.strategy).toBe('BREAKOUT');
    // breakoutLevel should be < rangeLow (116.5), because buffer is subtracted
    expect(pinbar!.breakoutLevel!).toBeLessThan(116.5);
  });

  it('关键位阻力位附近 → REVERSAL', () => {
    // 阻力位在 117 附近
    const rCtx: PatternContext = { trend: 'BEARISH', support: [], resistance: [117] };
    const candles = makeWarmup(16);
    const i = candles.length;
    candles.push(candle(i, 116.6, 121, 116.5, 116.9)); // BEARISH Pinbar at resistance
    const signals = detectPatterns(candles, rCtx);
    const pinbar = signals.find(s => s.type === 'PINBAR' && s.direction === 'BEARISH');
    expect(pinbar).toBeDefined();
    expect(pinbar!.strategy).toBe('REVERSAL');
    expect(pinbar!.breakoutLevel).toBeNull();
  });
});

/* ─── 50% 回调限价进场 ─── */

describe('50% 回调限价进场（retracementEntry）', () => {
  it('REVERSAL 策略的看涨 Pinbar → retracementEntry 有值', () => {
    // 支撑位在 117 附近，Pinbar close=116.9 距离 < 3%
    const sCtx: PatternContext = { trend: 'BULLISH', support: [117], resistance: [] };
    const candles = makeWarmup(16);
    const i = candles.length;
    candles.push(candle(i, 116.6, 116.8, 112, 116.9));
    const signals = detectPatterns(candles, sCtx);
    const pinbar = signals.find(s => s.type === 'PINBAR');
    expect(pinbar).toBeDefined();
    expect(pinbar!.strategy).toBe('REVERSAL');
    // rangeLow=112, rangeHigh=116.8, retracementEntry = 112 + (116.8-112)*0.5 = 114.4
    expect(pinbar!.retracementEntry).toBeCloseTo(114.4, 1);
    expect(pinbar!.retracementEntry!).toBeGreaterThan(112);
    expect(pinbar!.retracementEntry!).toBeLessThan(116.8);
  });

  it('REVERSAL 策略的看跌 Pinbar → retracementEntry 有值', () => {
    // 阻力位在 117 附近
    const rCtx: PatternContext = { trend: 'BEARISH', support: [], resistance: [117] };
    const candles = makeWarmup(16);
    const i = candles.length;
    candles.push(candle(i, 116.6, 121, 116.5, 116.9)); // BEARISH Pinbar at resistance
    const signals = detectPatterns(candles, rCtx);
    const pinbar = signals.find(s => s.type === 'PINBAR' && s.direction === 'BEARISH');
    expect(pinbar).toBeDefined();
    expect(pinbar!.strategy).toBe('REVERSAL');
    // rangeLow=116.5, rangeHigh=121, retracementEntry = 116.5 + (121-116.5)*0.5 = 118.75
    expect(pinbar!.retracementEntry).toBeCloseTo(118.75, 1);
    expect(pinbar!.retracementEntry!).toBeGreaterThan(116.5);
    expect(pinbar!.retracementEntry!).toBeLessThan(121);
  });

  it('BREAKOUT 策略的 Pinbar → retracementEntry 为 null', () => {
    const noCtx: PatternContext = { trend: 'BULLISH', support: [], resistance: [] };
    const candles = makeWarmup(16);
    const i = candles.length;
    candles.push(candle(i, 116.6, 116.8, 112, 116.9)); // BULLISH Pinbar
    const signals = detectPatterns(candles, noCtx);
    const pinbar = signals.find(s => s.type === 'PINBAR');
    expect(pinbar).toBeDefined();
    expect(pinbar!.strategy).toBe('BREAKOUT');
    expect(pinbar!.retracementEntry).toBeNull();
  });

  it('REVERSAL 策略的非 Pinbar 形态 → retracementEntry 为 null', () => {
    const sCtx: PatternContext = { trend: 'BULLISH', support: [117], resistance: [] };
    const candles = makeWarmup(15);
    const i = candles.length;
    candles.push(candle(i, 100, 120, 80, 115));   // 大母K线
    candles.push(candle(i + 1, 110, 115, 90, 112)); // 内包K线（close=112，距支撑 117 较远）
    const signals = detectPatterns(candles, sCtx);
    const inside = signals.find(s => s.type === 'INSIDE_BAR');
    expect(inside).toBeDefined();
    // InsideBar 不是 Pinbar，即使 REVERSAL 策略也不计算 retracementEntry
    expect(inside!.retracementEntry).toBeNull();
  });

  it('retracementEntry 值在 rangeLow 和 rangeHigh 之间', () => {
    const sCtx: PatternContext = { trend: 'BULLISH', support: [117], resistance: [] };
    const candles = makeWarmup(16);
    const i = candles.length;
    candles.push(candle(i, 116.6, 116.8, 112, 116.9));
    const signals = detectPatterns(candles, sCtx);
    const pinbar = signals.find(s => s.type === 'PINBAR');
    expect(pinbar).toBeDefined();
    const r = pinbar!.retracementEntry!;
    expect(r).toBeGreaterThan(112); // rangeLow
    expect(r).toBeLessThan(116.8);  // rangeHigh
  });
});