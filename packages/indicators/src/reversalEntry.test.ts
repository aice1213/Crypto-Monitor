import { describe, it, expect } from 'vitest';
import type { CandleDto, TrendStructureDto } from '@crypto-monitor/shared';
import { analyzeReversalEntry } from './reversalEntry.js';

/* ─── 测试工具 ─── */

function candle(index: number, open: number, high: number, low: number, close: number, volume = 1000): CandleDto {
  return { time: 1000 + index * 60, open, high, low, close, volume };
}

/** 默认 ATR 数组：全 2.0 */
function mockATR(n: number, val = 2.0): number[] {
  return Array.from({ length: n }, () => val);
}

/* ─── Mock TrendStructureDto ─── */

function mockTrendStruct(overrides: Partial<TrendStructureDto>): TrendStructureDto {
  return {
    direction: 'BULLISH',
    lastHigh: null,
    lastLow: null,
    highPattern: 'HH',
    lowPattern: 'HL',
    highCount: 2,
    lowCount: 2,
    structureBreak: 'INTACT',
    interpretation: 'mock',
    ...overrides,
  };
}

/* ─── 共享测试数据集（每个 ≥ 10 根 K 线） ─── */

/**
 * 上升趋势反转序列（10根）：
 *   i=0~5: 6 根大阳线（趋势走势，body=3）
 *   i=6:   小阴线（回调，body=0.5，小）
 *   i=7:   大阴线（强回调，body=2.5）
 *   i=8:   小阳线（趋势，body=0.3，极小 → 触发趋势转弱）
 *   i=9:   小阳线（趋势，body=0.2，极小）
 *
 * trendCandles = [3,3,3,3,3,3, 0.3, 0.2]  avgBody=2.31  lastTrend=0.2 < 1.39 → trendWeakening ✓
 * pullbackCandles = [0.5, 2.5]              2.5 >= 1.62 → strongPullback ✓
 */
function makeUPReversal(): CandleDto[] {
  const candles: CandleDto[] = [];
  // 6 根大阳线（body=3）
  for (let j = 0; j < 6; j++) {
    candles.push(candle(j, 100 + j * 3, 104 + j * 3, 99 + j * 3, 103 + j * 3));
  }
  // 小阴线（回调，body=0.5）
  candles.push(candle(6, 118.0, 118.5, 117.5, 117.5));
  // 大阴线（强回调，body=2.5）
  candles.push(candle(7, 117.0, 117.5, 114.5, 114.5));
  // 小阳线（趋势末尾，body=0.3）
  candles.push(candle(8, 114.5, 115.0, 114.3, 114.8));
  // 小阳线（趋势末尾，body=0.2）
  candles.push(candle(9, 114.8, 115.0, 114.5, 115.0));

  return candles;
}

/**
 * 下跌趋势反转序列（10根）：
 *   i=0~5: 6 根大阴线（趋势走势，body=3）
 *   i=6:   小阳线（回调，body=0.5，小）
 *   i=7:   大阳线（强回调，body=2.5）
 *   i=8:   小阴线（趋势，body=0.3，极小 → 趋势转弱）
 *   i=9:   小阴线（趋势，body=0.2，极小）
 */
function makeDOWNReversal(): CandleDto[] {
  const candles: CandleDto[] = [];
  // 6 根大阴线（body=3）
  for (let j = 0; j < 6; j++) {
    candles.push(candle(j, 200 - j * 3, 201 - j * 3, 196 - j * 3, 197 - j * 3));
  }
  // 小阳线（回调，body=0.5）
  candles.push(candle(6, 182.0, 182.5, 181.5, 182.5));
  // 大阳线（强回调，body=2.5）
  candles.push(candle(7, 181.0, 183.5, 180.5, 183.5));
  // 小阴线（趋势末尾，body=0.3）
  candles.push(candle(8, 183.5, 183.8, 183.2, 183.2));
  // 小阴线（趋势末尾，body=0.2）
  candles.push(candle(9, 183.2, 183.4, 182.8, 183.0));

  return candles;
}

/**
 * 健康上升趋势（10根）：
 *   i=0~5: 6 根大阳线（body=3）
 *   i=6~7: 2 根小阴线（回调，body=0.5）
 *   i=8:   大阳线（趋势延续，body=3）
 *   i=9:   小阴线（回调，body=0.3）
 *
 * trendCandles = [3,3,3,3,3,3, 3]   avgBody=3   lastTrend=3 不弱于 1.8 → trendWeakening ✗
 * pullbackCandles = [0.5, 0.5, 0.3]   无大于 2.1 → strongPullback ✗
 */
function makeHealthyUP(): CandleDto[] {
  const candles: CandleDto[] = [];
  for (let j = 0; j < 6; j++) {
    candles.push(candle(j, 100 + j * 3, 104 + j * 3, 99 + j * 3, 103 + j * 3));
  }
  // 小阴线（回调）
  candles.push(candle(6, 118.0, 118.5, 117.5, 117.5));
  candles.push(candle(7, 117.0, 117.5, 116.5, 116.5));
  // 大阳线（趋势延续）
  candles.push(candle(8, 116.5, 120.0, 116.3, 119.5));
  // 小阴线（回调）
  candles.push(candle(9, 119.5, 119.8, 119.2, 119.2));

  return candles;
}

/* ─── 测试 ─── */

describe('Reversal Entry 反转精准入场', () => {
  describe('信号①：趋势走势转弱', () => {
    it('最后趋势K线实体 < 前序均值×0.6 → trendWeakening=true', () => {
      // 6 大阳(body=3) + 4 小阳(body=0.5)，last=0.5 < avg≈2.2×0.6=1.3 → true
      const candles: CandleDto[] = [];
      for (let j = 0; j < 6; j++) {
        candles.push(candle(j, 100 + j * 3, 104 + j * 3, 99 + j * 3, 103 + j * 3));
      }
      for (let j = 6; j < 10; j++) {
        candles.push(candle(j, 118 + (j - 6) * 0.5, 118.8 + (j - 6) * 0.5, 117.5 + (j - 6) * 0.5, 118.5 + (j - 6) * 0.5));
      }
      const r = analyzeReversalEntry(candles, mockATR(candles.length, 2), mockTrendStruct({ direction: 'BULLISH' }), [], []);
      expect(r.trendWeakening).toBe(true);
      expect(r.originalTrend).toBe('UP');
    });

    it('最后趋势K线实体 >= 前序均值×0.6 → trendWeakening=false', () => {
      // 6 大阳(body=3) + 3 小阳(body=0.5) + 1 大阳(body=3)，last=3 不弱于 1.3 → false
      const candles: CandleDto[] = [];
      for (let j = 0; j < 6; j++) {
        candles.push(candle(j, 100 + j * 3, 104 + j * 3, 99 + j * 3, 103 + j * 3));
      }
      // 3 小阳
      for (let j = 6; j < 9; j++) {
        candles.push(candle(j, 118 + (j - 6) * 0.5, 118.8 + (j - 6) * 0.5, 117.5 + (j - 6) * 0.5, 118.5 + (j - 6) * 0.5));
      }
      // 1 大阳
      candles.push(candle(9, 119.5, 122.5, 119.3, 122.5));

      const r = analyzeReversalEntry(candles, mockATR(candles.length, 2), mockTrendStruct({ direction: 'BULLISH' }), [], []);
      expect(r.trendWeakening).toBe(false);
    });
  });

  describe('信号②：回调走势变强', () => {
    it('回调K线实体 >= 趋势均值×0.7 → strongPullback=true', () => {
      const candles = makeUPReversal();
      const r = analyzeReversalEntry(candles, mockATR(candles.length, 2), mockTrendStruct({ direction: 'BULLISH' }), [], []);
      expect(r.strongPullback).toBe(true);
    });

    it('回调K线实体 < 趋势均值×0.7 → strongPullback=false', () => {
      const candles = makeHealthyUP();
      const r = analyzeReversalEntry(candles, mockATR(candles.length, 2), mockTrendStruct({ direction: 'BULLISH' }), [], []);
      expect(r.strongPullback).toBe(false);
    });
  });

  describe('信号③：趋势架构破坏', () => {
    it('BULL_BROKEN → structureBroken=true（上升出LL）', () => {
      const candles = makeUPReversal();
      const r = analyzeReversalEntry(
        candles, mockATR(candles.length, 2),
        mockTrendStruct({ direction: 'BULLISH', structureBreak: 'BULL_BROKEN' }),
        [], [],
      );
      expect(r.structureBroken).toBe(true);
    });

    it('BEAR_BROKEN → structureBroken=true（下跌出HH）', () => {
      const candles = makeDOWNReversal();
      const r = analyzeReversalEntry(
        candles, mockATR(candles.length, 2),
        mockTrendStruct({ direction: 'BEARISH', structureBreak: 'BEAR_BROKEN' }),
        [], [],
      );
      expect(r.structureBroken).toBe(true);
    });

    it('INTACT → structureBroken=false', () => {
      const candles = makeUPReversal();
      const r = analyzeReversalEntry(
        candles, mockATR(candles.length, 2),
        mockTrendStruct({ direction: 'BULLISH', structureBreak: 'INTACT' }),
        [], [],
      );
      expect(r.structureBroken).toBe(false);
    });
  });

  describe('信号④：关键位确认', () => {
    it('价格在支撑位 ±3% 内 → nearKeyLevel=true', () => {
      // last close = 115.0, support = 113.5 → diff=1.5/115≈1.3% < 3%
      const candles = makeUPReversal();
      const r = analyzeReversalEntry(
        candles, mockATR(candles.length, 2),
        mockTrendStruct({ direction: 'BULLISH', structureBreak: 'BULL_BROKEN' }),
        [113.5], [],
      );
      expect(r.nearKeyLevel).toBe(true);
    });

    it('价格在阻力位 ±3% 内 → nearKeyLevel=true', () => {
      const candles = makeUPReversal();
      const r = analyzeReversalEntry(
        candles, mockATR(candles.length, 2),
        mockTrendStruct({ direction: 'BULLISH', structureBreak: 'BULL_BROKEN' }),
        [], [116.0], // close=115.0, diff=1.0/115≈0.9% < 3%
      );
      expect(r.nearKeyLevel).toBe(true);
    });

    it('价格远离所有关键位 → nearKeyLevel=false', () => {
      const candles = makeUPReversal();
      const r = analyzeReversalEntry(
        candles, mockATR(candles.length, 2),
        mockTrendStruct({ direction: 'BULLISH', structureBreak: 'BULL_BROKEN' }),
        [100.0], [200.0],
      );
      expect(r.nearKeyLevel).toBe(false);
    });
  });

  describe('综合共振判定', () => {
    it('三大核心信号 + 关键位 → STRONG_REVERSAL', () => {
      const candles = makeUPReversal();
      const r = analyzeReversalEntry(
        candles, mockATR(candles.length, 2),
        mockTrendStruct({ direction: 'BULLISH', structureBreak: 'BULL_BROKEN' }),
        [113.5], [],
      );
      expect(r.direction).toBe('BEARISH');
      expect(r.originalTrend).toBe('UP');
      expect(r.trendWeakening).toBe(true);
      expect(r.strongPullback).toBe(true);
      expect(r.structureBroken).toBe(true);
      expect(r.nearKeyLevel).toBe(true);
      expect(r.resonanceCount).toBe(4);
      expect(r.verdict).toBe('STRONG_REVERSAL');
      expect(r.strength).toBe(1.0);
      expect(r.entryPrice).not.toBeNull();
      expect(r.stopLoss).not.toBeNull();
      expect(r.takeProfit).not.toBeNull();
    });

    it('两个核心信号 → REVERSAL_WATCH', () => {
      // 无结构破坏，有关键位：trendWeakening ✓ + strongPullback ✓ + nearKeyLevel ✓ = 3
      // 改用无关键位：trendWeakening ✓ + strongPullback ✓ = 2
      const candles = makeUPReversal();
      const r = analyzeReversalEntry(
        candles, mockATR(candles.length, 2),
        mockTrendStruct({ direction: 'BULLISH', structureBreak: 'INTACT' }),
        [], [],
      );
      expect(r.resonanceCount).toBeGreaterThanOrEqual(2);
      expect(r.verdict).toBe('REVERSAL_WATCH');
    });

    it('趋势健康无信号 → NO_REVERSAL', () => {
      const candles = makeHealthyUP();
      const r = analyzeReversalEntry(
        candles, mockATR(candles.length, 2),
        mockTrendStruct({ direction: 'BULLISH', structureBreak: 'INTACT' }),
        [], [],
      );
      expect(r.verdict).toBe('NO_REVERSAL');
      expect(r.resonanceCount).toBeLessThanOrEqual(1);
      expect(r.entryPrice).toBeNull();
    });

    it('上涨趋势破坏 → direction=BEARISH，做空', () => {
      const candles = makeUPReversal();
      const r = analyzeReversalEntry(
        candles, mockATR(candles.length, 2),
        mockTrendStruct({ direction: 'BULLISH', structureBreak: 'BULL_BROKEN' }),
        [], [],
      );
      expect(r.direction).toBe('BEARISH');
      expect(r.originalTrend).toBe('UP');
      if (r.stopLoss && r.entryPrice) {
        expect(r.stopLoss).toBeGreaterThan(r.entryPrice);
      }
      if (r.takeProfit && r.entryPrice) {
        expect(r.takeProfit).toBeLessThan(r.entryPrice);
      }
    });

    it('下跌趋势破坏 → direction=BULLISH，做多', () => {
      const candles = makeDOWNReversal();
      const r = analyzeReversalEntry(
        candles, mockATR(candles.length, 2),
        mockTrendStruct({ direction: 'BEARISH', structureBreak: 'BEAR_BROKEN' }),
        [], [],
      );
      expect(r.direction).toBe('BULLISH');
      expect(r.originalTrend).toBe('DOWN');
      if (r.stopLoss && r.entryPrice) {
        expect(r.stopLoss).toBeLessThan(r.entryPrice);
      }
      if (r.takeProfit && r.entryPrice) {
        expect(r.takeProfit).toBeGreaterThan(r.entryPrice);
      }
    });
  });

  describe('边界情况', () => {
    it('数据不足（<10根）→ NO_REVERSAL', () => {
      const candles = Array.from({ length: 7 }, (_, i) =>
        candle(i, 100 + i, 102 + i, 98 + i, 101 + i),
      );
      const r = analyzeReversalEntry(candles, mockATR(candles.length), mockTrendStruct({ direction: 'BULLISH' }), [], []);
      expect(r.verdict).toBe('NO_REVERSAL');
      expect(r.interpretation).toContain('数据不足');
    });

    it('无趋势（RANGING）→ NO_REVERSAL', () => {
      const candles = makeUPReversal();
      const r = analyzeReversalEntry(
        candles, mockATR(candles.length, 2),
        mockTrendStruct({ direction: 'RANGING' }),
        [], [],
      );
      expect(r.verdict).toBe('NO_REVERSAL');
      expect(r.interpretation).toContain('无明确趋势');
    });

    it('ATR 为 0 → NO_REVERSAL', () => {
      const candles = makeUPReversal();
      const r = analyzeReversalEntry(
        candles, mockATR(candles.length, 0),
        mockTrendStruct({ direction: 'BULLISH' }),
        [], [],
      );
      expect(r.verdict).toBe('NO_REVERSAL');
      expect(r.interpretation).toContain('ATR 无效');
    });

    it('有支撑位时止盈对齐支撑位', () => {
      const candles = makeUPReversal();
      const r = analyzeReversalEntry(
        candles, mockATR(candles.length, 2),
        mockTrendStruct({ direction: 'BULLISH', structureBreak: 'BULL_BROKEN' }),
        [110.0], [],
      );
      expect(r.takeProfit).toBe(110.0);
    });

    it('无关键位时止盈用 ATR 回退距离', () => {
      const candles = makeUPReversal();
      const r = analyzeReversalEntry(
        candles, mockATR(candles.length, 2),
        mockTrendStruct({ direction: 'BULLISH', structureBreak: 'BULL_BROKEN' }),
        [], [],
      );
      // 止盈 = close - 2×ATR = 115.0 - 4 = 111.0
      expect(r.takeProfit!).toBeCloseTo(111.0, 0);
    });
  });

  describe('强度计算', () => {
    it('全部 4 信号满足 → strength=1.0', () => {
      const candles = makeUPReversal();
      const r = analyzeReversalEntry(
        candles, mockATR(candles.length, 2),
        mockTrendStruct({ direction: 'BULLISH', structureBreak: 'BULL_BROKEN' }),
        [113.5], [],
      );
      expect(r.strength).toBe(1.0);
    });

    it('2 信号满足 → strength 在 0.35~0.55 之间', () => {
      const candles = makeUPReversal();
      const r = analyzeReversalEntry(
        candles, mockATR(candles.length, 2),
        mockTrendStruct({ direction: 'BULLISH', structureBreak: 'INTACT' }),
        [], [],
      );
      expect(r.resonanceCount).toBe(2);
      expect(r.strength).toBeGreaterThanOrEqual(0.35);
      expect(r.strength).toBeLessThanOrEqual(0.55);
    });
  });
});
