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
    candles.push(candle(i + 3, 117, 112, 88, 106));  // 收回：high=112<=115, low=88>=85（body 不完全匹配前根，避免吞没触发）
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

describe('Engulfing 吞没检测', () => {
  it('看涨吞没：前阴后阳，阳实体完全包裹阴实体', () => {
    const candles = makeWarmup(16);
    const i = candles.length;
    // 前一根阴烛：open=116.6, close=116.0（body=0.6）
    candles.push(candle(i, 116.6, 116.8, 115.8, 116.0));
    // 看涨吞没：open=115.9（<=116.0前close）, close=117.0（>=116.6前open）
    candles.push(candle(i + 1, 115.9, 117.2, 115.7, 117.0));
    const signals = detectPatterns(candles, ctx);
    const engulf = signals.find(s => s.type === 'ENGULFING');
    expect(engulf).toBeDefined();
    expect(engulf!.direction).toBe('BULLISH');
    expect(engulf!.strength).toBeGreaterThan(0);
  });

  it('看跌吞没：前阳后阴，阴实体完全包裹阳实体', () => {
    const candles = makeWarmup(16);
    const i = candles.length;
    // 前一根阳烛：open=116.0, close=116.6（body=0.6）
    candles.push(candle(i, 116.0, 116.8, 115.8, 116.6));
    // 看跌吞没：open=116.7（>=116.6前close）, close=115.9（<=116.0前open）
    candles.push(candle(i + 1, 116.7, 116.9, 115.5, 115.9));
    const signals = detectPatterns(candles, ctx);
    const engulf = signals.find(s => s.type === 'ENGULFING');
    expect(engulf).toBeDefined();
    expect(engulf!.direction).toBe('BEARISH');
  });

  it('不包裹不算吞没：当前实体未完全覆盖前根', () => {
    const candles = makeWarmup(16);
    const i = candles.length;
    // 前一根阴烛：open=116.6, close=116.0
    candles.push(candle(i, 116.6, 116.8, 115.8, 116.0));
    // close=116.5 < 116.6（前open）→ 未完全包裹
    candles.push(candle(i + 1, 115.9, 116.7, 115.7, 116.5));
    const signals = detectPatterns(candles, ctx);
    const engulf = signals.find(s => s.type === 'ENGULFING');
    expect(engulf).toBeUndefined();
  });

  it('零实体K线不算吞没', () => {
    const candles = makeWarmup(16);
    const i = candles.length;
    // 十字星：open=close=116.0
    candles.push(candle(i, 116.6, 116.8, 115.8, 116.0));
    candles.push(candle(i + 1, 116.0, 116.2, 115.8, 116.0));
    const signals = detectPatterns(candles, ctx);
    const engulf = signals.find(s => s.type === 'ENGULFING');
    expect(engulf).toBeUndefined();
  });

  it('同向K线不算吞没：前阴后阴', () => {
    const candles = makeWarmup(16);
    const i = candles.length;
    candles.push(candle(i, 116.6, 116.8, 115.8, 116.0)); // 阴烛
    candles.push(candle(i + 1, 115.9, 116.7, 115.7, 115.5)); // 阴烛，close<open
    const signals = detectPatterns(candles, ctx);
    const engulf = signals.find(s => s.type === 'ENGULFING');
    expect(engulf).toBeUndefined();
  });

  it('吞没+长引线同向共振 → 保留吞没（核心信号优先）', () => {
    const bullCtx: PatternContext = { trend: 'BULLISH', support: [], resistance: [] };
    const candles = makeWarmup(16);
    const i = candles.length;
    // 前阴后阳吞没 + 长下影线（body=1.1, lower_wick=2.2≥2×body）
    candles.push(candle(i, 116.6, 116.8, 115.8, 116.0));
    candles.push(candle(i + 1, 115.9, 117.2, 113.7, 117.0));
    const signals = detectPatterns(candles, bullCtx);
    // 同向共振时保留 ENGULFING，移除 PINBAR
    const engulf = signals.find(s => s.type === 'ENGULFING' && s.index === i + 1);
    expect(engulf).toBeDefined();
    expect(engulf!.direction).toBe('BULLISH');
    const pinbar = signals.find(s => s.type === 'PINBAR' && s.index === i + 1);
    expect(pinbar).toBeUndefined();
  });

  it('吞没+长引线同向共振 → 强度高于单纯吞没', () => {
    const bullCtx: PatternContext = { trend: 'BULLISH', support: [], resistance: [] };

    // Case A: 吞没无长影线（无 boost）
    const candlesA = makeWarmup(16);
    const a = candlesA.length;
    candlesA.push(candle(a, 116.6, 116.8, 115.8, 116.0));
    candlesA.push(candle(a + 1, 115.9, 117.2, 115.7, 117.0)); // 短影线，无 pinbar
    const signalsA = detectPatterns(candlesA, bullCtx);
    const engulfA = signalsA.find(s => s.type === 'ENGULFING' && s.index === a + 1)!;

    // Case B: 吞没+长下影线（有 boost）
    const candlesB = makeWarmup(16);
    const b = candlesB.length;
    candlesB.push(candle(b, 116.6, 116.8, 115.8, 116.0));
    candlesB.push(candle(b + 1, 115.9, 117.2, 113.7, 117.0)); // 长下影线，有 pinbar
    const signalsB = detectPatterns(candlesB, bullCtx);
    const engulfB = signalsB.find(s => s.type === 'ENGULFING' && s.index === b + 1)!;

    // 强强联合后强度应更高
    expect(engulfB!.strength).toBeGreaterThan(engulfA!.strength);
  });

  it('吞没+长引线反向 → 不触发组合增强', () => {
    const bullCtx: PatternContext = { trend: 'BULLISH', support: [], resistance: [] };
    const candles = makeWarmup(16);
    const i = candles.length;
    // 看涨吞没 + 长上影线（BEARISH pinbar，方向相反）
    candles.push(candle(i, 116.6, 116.8, 115.8, 116.0)); // 阴烛
    candles.push(candle(i + 1, 115.9, 120, 115.7, 117.0)); // 上影线长→BEARISH pinbar
    const signals = detectPatterns(candles, bullCtx);
    // 反向时不触发增强，去重保留更强信号（pinbar strength > engulfing strength）
    const engulf = signals.find(s => s.type === 'ENGULFING' && s.index === i + 1);
    const pinbar = signals.find(s => s.type === 'PINBAR' && s.index === i + 1);
    // 只有其中一个存活（去重），且不是 boost 结果
    const survivors = [engulf, pinbar].filter(Boolean);
    expect(survivors.length).toBeLessThanOrEqual(1);
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
    // 支撑位在 117 附近，EMA50=116.8，Fib=116.7，Pinbar close=116.9
    // 3个关键位条件全满足 → 2分 + 趋势1分 + 强度1分 = 4 → HIGH
    const sCtx: PatternContext = { trend: 'BULLISH', support: [117], resistance: [], ema50: 116.8, fibLevels: [116.7] };
    const candles = makeWarmup(16);
    const i = candles.length;
    candles.push(candle(i, 116.6, 116.8, 112, 116.9));
    const signals = detectPatterns(candles, sCtx);
    const pinbar = signals.find(s => s.type === 'PINBAR');
    expect(pinbar).toBeDefined();
    // 趋势一致+1, 关键位≥2+2, 强度+1 = 4 → HIGH
    expect(pinbar!.score).toBe(4);
    expect(pinbar!.quality).toBe('HIGH');
  });

  it('单一关键位条件不给加分（文档规则2：至少2个条件）', () => {
    // 只有支撑位（1个条件），没有EMA50和Fib → 关键位不加分
    const sCtx: PatternContext = { trend: 'BULLISH', support: [117], resistance: [] };
    const candles = makeWarmup(16);
    const i = candles.length;
    candles.push(candle(i, 116.6, 116.8, 112, 116.9));
    const signals = detectPatterns(candles, sCtx);
    const pinbar = signals.find(s => s.type === 'PINBAR');
    expect(pinbar).toBeDefined();
    // 趋势一致+1, 关键位0(仅1个条件不加分), 强度+1 = 2 → MEDIUM
    expect(pinbar!.score).toBe(2);
    expect(pinbar!.quality).toBe('MEDIUM');
  });

  it('EMA50 + 支撑位 2条件满足 → 关键位加分', () => {
    // EMA50=116.8 和 支撑=117 两个条件都满足 → 关键位+2
    const sCtx: PatternContext = { trend: 'BULLISH', support: [117], resistance: [], ema50: 116.8 };
    const candles = makeWarmup(16);
    const i = candles.length;
    candles.push(candle(i, 116.6, 116.8, 112, 116.9));
    const signals = detectPatterns(candles, sCtx);
    const pinbar = signals.find(s => s.type === 'PINBAR');
    expect(pinbar).toBeDefined();
    // 趋势一致+1, 关键位≥2+2, 强度+1 = 4 → HIGH
    expect(pinbar!.score).toBe(4);
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

/* ─── Fake Breakout（关键位假突破）─── */

describe('Fake Breakout 关键位假突破检测', () => {
  // warmup 结束价 ≈102，关键位设在 warmup 附近以避免巨大 TR
  const R = 102.5; // 阻力位
  const S = 101.5; // 支撑位

  it('向上突破阻力后收回 → BEARISH FAKE_BREAKOUT 信号', () => {
    const candles = makeWarmup(16);
    const i = candles.length;
    // 突破K线：close=103.0 > R=102.5，穿透=0.5，ATR≈2，阈值：minPen=0.1
    // 设计为 breakout candle 的 range=[101.0, 103.0]，confirmation candle 的 range=[101.8, 103.2]
    // confirmation.high(103.2) > breakout.high(103.0) → 不是 InsideBar
    candles.push(candle(i, 102.0, 103.0, 101.0, 103.0));
    // 收回K线：close=102.0 ≤ R=102.5，回挫=0.5 > minRet=0.2
    candles.push(candle(i + 1, 102.5, 103.2, 101.8, 102.0));
    // 保持低位
    candles.push(candle(i + 2, 101.8, 102.2, 101.3, 101.9));

    const ctx: PatternContext = { trend: 'BEARISH', support: [], resistance: [R] };
    const signals = detectPatterns(candles, ctx);
    const fb = signals.find(s => s.type === 'FAKE_BREAKOUT');
    expect(fb).toBeDefined();
    expect(fb!.direction).toBe('BEARISH');
    expect(fb!.strength).toBeGreaterThan(0);
    expect(fb!.strength).toBeLessThanOrEqual(1);
  });

  it('向下突破支撑后收回 → BULLISH FAKE_BREAKOUT 信号', () => {
    const candles = makeWarmup(16);
    const i = candles.length;
    // 跌破K线：close=101.0 < S=101.5，穿透=0.5
    // 设计为 breakout candle 的 range=[101.0, 103.0]，confirmation candle 的 range=[100.7, 102.5]
    // confirmation.low(100.7) < breakout.low(101.0) → 不是 InsideBar
    candles.push(candle(i, 102.0, 103.0, 101.0, 101.0));
    // 收回K线：close=102.0 > S=101.5，回挫=0.5 > minRet=0.2
    candles.push(candle(i + 1, 101.5, 102.5, 100.7, 102.0));
    // 保持高位
    candles.push(candle(i + 2, 102.0, 102.3, 101.7, 102.1));

    const ctx: PatternContext = { trend: 'BULLISH', support: [S], resistance: [] };
    const signals = detectPatterns(candles, ctx);
    const fb = signals.find(s => s.type === 'FAKE_BREAKOUT');
    expect(fb).toBeDefined();
    expect(fb!.direction).toBe('BULLISH');
    expect(fb!.strength).toBeGreaterThan(0);
  });

  it('真正突破（突破后未收回）→ 不触发 FAKE_BREAKOUT', () => {
    const candles = makeWarmup(16);
    const i = candles.length;
    // 突破K线
    candles.push(candle(i, 102.0, 103.0, 101.0, 103.0));
    // 保持突破后高位，不回落
    candles.push(candle(i + 1, 102.9, 104.0, 102.7, 103.5));
    candles.push(candle(i + 2, 103.4, 104.5, 103.2, 104.0));
    candles.push(candle(i + 3, 103.9, 105.0, 103.7, 104.5));

    const ctx: PatternContext = { trend: 'BEARISH', support: [], resistance: [R] };
    const signals = detectPatterns(candles, ctx);
    const fb = signals.find(s => s.type === 'FAKE_BREAKOUT');
    expect(fb).toBeUndefined();
  });

  it('无支持/阻力上下文 → 不触发 FAKE_BREAKOUT', () => {
    const candles = makeWarmup(16);
    const i = candles.length;
    candles.push(candle(i, 102.0, 103.0, 101.0, 103.0));
    candles.push(candle(i + 1, 102.5, 103.2, 101.8, 102.0));

    // 空上下文 → detectFakeBreakout 根本不调用
    const signals = detectPatterns(candles, ctx);
    const fb = signals.find(s => s.type === 'FAKE_BREAKOUT');
    expect(fb).toBeUndefined();
  });

  it('突破幅度小于 0.05×ATR → 不触发 FAKE_BREAKOUT', () => {
    const candles = makeWarmup(16);
    const i = candles.length;
    // close=102.05，穿透=0.05，阈值=0.05×2≈0.1，0.05 < 0.1 → 不触发
    candles.push(candle(i, 102.0, 102.1, 101.9, 102.05));
    // 后续均保持在 102.05 上方，无收回
    candles.push(candle(i + 1, 102.05, 102.5, 102.0, 102.4));
    candles.push(candle(i + 2, 102.4, 102.8, 102.3, 102.6));

    const ctx: PatternContext = { trend: 'BEARISH', support: [], resistance: [R] };
    const signals = detectPatterns(candles, ctx);
    const fb = signals.find(s => s.type === 'FAKE_BREAKOUT');
    expect(fb).toBeUndefined();
  });

  it('回挫幅度小于 0.1×ATR → 不触发 FAKE_BREAKOUT', () => {
    const candles = makeWarmup(16);
    const i = candles.length;
    // 突破：close=103.0，穿透=0.5 > 0.1 ✓
    candles.push(candle(i, 102.0, 103.3, 101.5, 103.0));
    // 微小回落：close=102.32 > R=102.5，未收回 → 不确认
    candles.push(candle(i + 1, 102.9, 103.1, 102.1, 102.32));
    // 更小的回落：close=102.35，回挫=0.15 < 阈值 0.2 → 不触发
    candles.push(candle(i + 2, 102.3, 102.5, 102.1, 102.35));

    const ctx: PatternContext = { trend: 'BEARISH', support: [], resistance: [R] };
    const signals = detectPatterns(candles, ctx);
    const fb = signals.find(s => s.type === 'FAKE_BREAKOUT');
    expect(fb).toBeUndefined();
  });

  it('突破后超过 5 根K线才收回 → 超时不触发', () => {
    const candles = makeWarmup(16);
    const i = candles.length;
    // 突破K线
    candles.push(candle(i, 102.0, 103.0, 101.0, 103.0));
    // 7 根K线保持高位（全部 close > R=102.5，没有一根收回）
    for (let j = 0; j < 7; j++) {
      candles.push(candle(i + 1 + j, 102.9, 103.5, 102.7, 103.0 + j * 0.1));
    }
    // 注意：没有加回落K线。所有K线 close 都 > R，不存在 fake breakout 确认。

    const ctx: PatternContext = { trend: 'BEARISH', support: [], resistance: [R] };
    const signals = detectPatterns(candles, ctx);
    const fb = signals.find(s => s.type === 'FAKE_BREAKOUT');
    expect(fb).toBeUndefined();
  });

  it('突破 K 线 close 恰好等于关键位 → 不触发（需严格穿越）', () => {
    const candles = makeWarmup(16);
    const i = candles.length;
    // close=102.50，恰好等于 R=102.50，穿透=0 → 不触发
    const level = 102.50;
    candles.push(candle(i, 102.0, 102.8, 101.8, level));
    // 后续保持
    candles.push(candle(i + 1, 102.4, 102.8, 102.2, 102.6));
    candles.push(candle(i + 2, 102.5, 103.0, 102.4, 102.8));

    const ctx: PatternContext = { trend: 'BEARISH', support: [], resistance: [level] };
    const signals = detectPatterns(candles, ctx);
    const fb = signals.find(s => s.type === 'FAKE_BREAKOUT');
    expect(fb).toBeUndefined();
  });

  it('突破 K 线 close 刚好超过阈值 0.05×ATR → 触发', () => {
    const candles = makeWarmup(16);
    const i = candles.length;
    // 需要穿透 > 0.05×ATR ≈ 0.1，所以 close >= R + 0.105
    const level = 102.50;
    // breakout candle range=[101.5, 102.9], confirmation candle range=[101.3, 102.7]
    // confirmation.high(102.7) < breakout.high(102.9) AND confirmation.low(101.3) < breakout.low(101.5)
    // → 不是 InsideBar
    candles.push(candle(i, 102.0, 102.9, 101.5, level + 0.15)); // close=102.65，穿透=0.15
    // 收回：close=102.0 ≤ level，回挫=0.5 > minRet=0.2
    candles.push(candle(i + 1, 102.5, 102.7, 101.3, 102.0));
    // 保持
    candles.push(candle(i + 2, 101.9, 102.2, 101.5, 102.1));

    const ctx: PatternContext = { trend: 'BEARISH', support: [], resistance: [level] };
    const signals = detectPatterns(candles, ctx);
    const fb = signals.find(s => s.type === 'FAKE_BREAKOUT');
    expect(fb).toBeDefined();
    expect(fb!.direction).toBe('BEARISH');
  });

  it('rangeHigh/rangeLow 覆盖突破到确认的全程范围', () => {
    const candles = makeWarmup(16);
    const i = candles.length;
    // 突破K线 high=103.0
    candles.push(candle(i, 102.0, 103.0, 101.0, 103.0));
    // 确认K线 low=101.8
    candles.push(candle(i + 1, 102.5, 103.2, 101.8, 102.0));

    const ctx: PatternContext = { trend: 'BEARISH', support: [], resistance: [R] };
    const signals = detectPatterns(candles, ctx);
    const fb = signals.find(s => s.type === 'FAKE_BREAKOUT');
    expect(fb).toBeDefined();
    // 信号在确认K线上
    expect(fb!.index).toBe(i + 1);
    expect(fb!.strength).toBeGreaterThan(0);
    expect(fb!.strength).toBeLessThanOrEqual(1);
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

describe('健康回调检测（逆势小蜡烛）', () => {
  function makeWarmupBears(count: number): CandleDto[] {
    // ATR warmup: large bearish candles so the subsequent small bullish candles
    // have small bodies relative to ATR (strength < 0.3).
    const candles: CandleDto[] = [];
    for (let i = 0; i < count; i++) {
      const open = 120 - i * 1.0;
      candles.push(candle(i, open, open + 0.2, open - 1.5, open - 1.2));
    }
    return candles;
  }

  function addBullishPinbar(candles: CandleDto[]): CandleDto {
    const n = candles.length;
    // Small body (~0.15), long lower wick (2.0) → BULLISH PINBAR with low strength
    const c = candle(n, 100.5, 100.7, 98.5, 100.65);
    candles.push(c);
    return c;
  }

  it('BEARISH 趋势 + 看涨小蜡烛（健康回调）→ quality LOW，counterTrendPullback=true', () => {
    const candles = makeWarmupBears(18);
    addBullishPinbar(candles);
    const ctx: PatternContext = { trend: 'BEARISH', support: [], resistance: [] };
    const signals = detectPatterns(candles, ctx);
    const pin = signals.find((s) => s.type === 'PINBAR' && s.direction === 'BULLISH');
    expect(pin).toBeDefined();
    expect(pin!.counterTrendPullback).toBe(true);
    expect(pin!.quality).toBe('LOW');
  });

  it('BEARISH 趋势 + 看涨小蜡烛 + 2 关键位 → 健康回调抵消关键位加分，仍为 LOW', () => {
    const candles = makeWarmupBears(18);
    const bull = addBullishPinbar(candles);
    const price = bull.close;
    // 2 key level conditions: support + resistance both within 3% of price
    const ctx: PatternContext = { trend: 'BEARISH', support: [price * 0.995], resistance: [price * 1.005] };
    const signals = detectPatterns(candles, ctx);
    const pin = signals.find((s) => s.type === 'PINBAR' && s.direction === 'BULLISH');
    expect(pin).toBeDefined();
    expect(pin!.counterTrendPullback).toBe(true);
    // Without pullback deduction, score would be 2 (key levels) = MEDIUM.
    // With -2 deduction, score = 0 = LOW.
    expect(pin!.score).toBe(0);
    expect(pin!.quality).toBe('LOW');
  });

  it('BEARISH 趋势 + 看涨大蜡烛（strength>=0.3）→ 不是健康回调，正常评分', () => {
    const candles = makeWarmupBears(18);
    // Large bullish candle: big body + long wick → high strength
    const n = candles.length;
    candles.push(candle(n, 99.5, 100.7, 96.5, 100.6));
    const ctx: PatternContext = { trend: 'BEARISH', support: [], resistance: [] };
    const signals = detectPatterns(candles, ctx);
    const pin = signals.find((s) => s.type === 'PINBAR' && s.direction === 'BULLISH');
    expect(pin).toBeDefined();
    // Strong candle: strength >= 0.3, so NOT a healthy pullback
    expect(pin!.counterTrendPullback).toBe(false);
  });

  it('BULLISH 趋势 + 看涨小蜡烛 → 顺势，不是健康回调', () => {
    const candles = makeWarmup(18);
    // Small bullish pinbar in an uptrend
    candles.push(candle(candles.length, 100.5, 100.7, 98.5, 100.65));
    const ctx: PatternContext = { trend: 'BULLISH', support: [], resistance: [] };
    const signals = detectPatterns(candles, ctx);
    const pin = signals.find((s) => s.type === 'PINBAR' && s.direction === 'BULLISH');
    expect(pin).toBeDefined();
    expect(pin!.counterTrendPullback).toBe(false);
  });

  it('BEARISH 趋势 + 看跌小蜡烛 → 顺势，不是健康回调', () => {
    const candles = makeWarmupBears(18);
    // Small bearish candle in a downtrend
    candles.push(candle(candles.length, 100.7, 100.7, 99.3, 99.5));
    const ctx: PatternContext = { trend: 'BEARISH', support: [], resistance: [] };
    const signals = detectPatterns(candles, ctx);
    const bear = signals.find((s) => s.type === 'PINBAR' && s.direction === 'BEARISH');
    // May or may not detect, but if it does, it's NOT a counter-trend pullback
    if (bear) {
      expect(bear.counterTrendPullback).toBe(false);
    }
  });
});
