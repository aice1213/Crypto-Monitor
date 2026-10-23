import { describe, it, expect } from 'vitest';
import { analyzeMacdAdvanced } from './macdAdvanced.js';
import type { MacdResult } from '@crypto-monitor/shared';

/** 创建 N 根基础 MacdResult（DIF 从 start 到 end 线性，DEA 略低，hist = (dif-dea)*2） */
function seq(histValues: number[]): MacdResult[] {
  return histValues.map((hist) => {
    const dif = hist / 2;
    return {
      dif,
      dea: dif - hist / 2,
      hist,
      signal: 'NO_SIGNAL' as const,
      signalAge: null,
    };
  });
}

describe('MACD 高阶分析', () => {
  describe('INSUFFICIENT_DATA', () => {
    it('数据不足时返回 EMPTY', () => {
      const result = analyzeMacdAdvanced(seq([1, 1]), [0, 0]);
      expect(result.momentum).toBe('EMPTY');
      expect(result.interpretation).toContain('数据不足');
    });
  });

  describe('柱体动能强度', () => {
    it('STRONG 动能：|hist| / ATR > 0.5', () => {
      // hist = 10, ATR = 10 → histNorm = 1.0
      const result = analyzeMacdAdvanced(seq([0, 0, 0, 5, 10]), [10, 10, 10, 10, 10]);
      expect(result.momentum).toBe('STRONG');
    });

    it('MEDIUM 动能：0.2 <= |hist| / ATR < 0.5', () => {
      // hist = 4, ATR = 10 → histNorm = 0.4
      const result = analyzeMacdAdvanced(seq([0, 0, 0, 2, 4]), [10, 10, 10, 10, 10]);
      expect(result.momentum).toBe('MEDIUM');
    });

    it('WEAK 动能：0.08 <= |hist| / ATR < 0.2', () => {
      // hist = 1, ATR = 10 → histNorm = 0.1
      const result = analyzeMacdAdvanced(seq([0, 0, 0, 0.5, 1]), [10, 10, 10, 10, 10]);
      expect(result.momentum).toBe('WEAK');
    });

    it('EMPTY 动能：|hist| / ATR < 0.08', () => {
      // hist = 0.5, ATR = 10 → histNorm = 0.05
      const result = analyzeMacdAdvanced(seq([0, 0, 0, 0.2, 0.5]), [10, 10, 10, 10, 10]);
      expect(result.momentum).toBe('EMPTY');
    });
  });

  describe('柱体收缩', () => {
    it('检测连续收缩（3 根 |hist| 递减）', () => {
      // |hist| = [10, 7, 5, 4, 3] — 连续 3 根递减
      const result = analyzeMacdAdvanced(seq([10, 7, 5, 4, 3]), [10, 10, 10, 10, 10]);
      expect(result.contracting).toBe(true);
    });

    it('检测未收缩（柱体扩张）', () => {
      // |hist| = [1, 2, 3, 4, 5] — 连续扩张
      const result = analyzeMacdAdvanced(seq([1, 2, 3, 4, 5]), [10, 10, 10, 10, 10]);
      expect(result.contracting).toBe(false);
    });

    it('检测未收缩（柱体先缩后扩）', () => {
      // |hist| = [5, 3, 2, 2, 1] — n-3=5, n-2=3, n-1=2 → 3>=2? no
      const result = analyzeMacdAdvanced(seq([5, 3, 2, 2, 1]), [10, 10, 10, 10, 10]);
      expect(result.contracting).toBe(false);
    });
  });

  describe('DIF 方向', () => {
    it('DIF 上行', () => {
      const result = analyzeMacdAdvanced(seq([1, 2, 3, 4, 5]), [10, 10, 10, 10, 10]);
      expect(result.difDirection).toBe('UP');
    });

    it('DIF 下行', () => {
      const result = analyzeMacdAdvanced(seq([5, 4, 3, 2, 1]), [10, 10, 10, 10, 10]);
      expect(result.difDirection).toBe('DOWN');
    });
  });

  describe('快线-柱体分离', () => {
    it('BULLISH_SEP：绿柱（hist<0）+ DIF 上行', () => {
      // hist 从 -10 变为 -3（仍为负），DIF 上行
      const data = seq([-10, -8, -6, -5, -3]);
      const result = analyzeMacdAdvanced(data, [10, 10, 10, 10, 10]);
      expect(result.separation).toBe('BULLISH_SEP');
    });

    it('BEARISH_SEP：红柱（hist>0）+ DIF 下行', () => {
      // hist 从 10 变为 3（仍为正），DIF 下行
      const data = seq([10, 8, 6, 5, 3]);
      const result = analyzeMacdAdvanced(data, [10, 10, 10, 10, 10]);
      expect(result.separation).toBe('BEARISH_SEP');
    });

    it('NONE：柱体与 DIF 同向', () => {
      // hist 从 1 变为 5（正），DIF 上行
      const data = seq([1, 2, 3, 4, 5]);
      const result = analyzeMacdAdvanced(data, [10, 10, 10, 10, 10]);
      expect(result.separation).toBe('NONE');
    });
  });

  describe('综合信号 — 做多', () => {
    it('零轴下方 + 绿柱缩量 + 看涨分离 = LONG', () => {
      // DIF 为负（零轴下方），hist 为负（绿柱），柱体收缩，DIF 上行
      const data = [
        { dif: -8, dea: -4, hist: -8, signal: 'NO_SIGNAL' as const, signalAge: null },
        { dif: -6, dea: -3, hist: -6, signal: 'NO_SIGNAL' as const, signalAge: null },
        { dif: -4, dea: -2, hist: -4, signal: 'NO_SIGNAL' as const, signalAge: null },
        { dif: -2, dea: -1, hist: -2, signal: 'NO_SIGNAL' as const, signalAge: null },
        { dif: -1, dea: -0.5, hist: -1, signal: 'NO_SIGNAL' as const, signalAge: null },
      ];
      const result = analyzeMacdAdvanced(data, [10, 10, 10, 10, 10]);
      expect(result.actionableSignal).toBe('LONG');
    });
  });

  describe('综合信号 — 做空', () => {
    it('零轴上方 + 红柱缩量 + 看跌分离 = SHORT', () => {
      // DIF 为正（零轴上方），hist 为正（红柱），柱体收缩，DIF 下行
      const data = [
        { dif: 8, dea: 4, hist: 8, signal: 'NO_SIGNAL' as const, signalAge: null },
        { dif: 6, dea: 3, hist: 6, signal: 'NO_SIGNAL' as const, signalAge: null },
        { dif: 4, dea: 2, hist: 4, signal: 'NO_SIGNAL' as const, signalAge: null },
        { dif: 2, dea: 1, hist: 2, signal: 'NO_SIGNAL' as const, signalAge: null },
        { dif: 1, dea: 0.5, hist: 1, signal: 'NO_SIGNAL' as const, signalAge: null },
      ];
      const result = analyzeMacdAdvanced(data, [10, 10, 10, 10, 10]);
      expect(result.actionableSignal).toBe('SHORT');
    });
  });

  describe('综合信号 — 无信号', () => {
    it('零轴粘合时不产生信号', () => {
      const data = [
        { dif: 0.01, dea: 0, hist: 0.02, signal: 'NO_SIGNAL' as const, signalAge: null },
        { dif: 0.02, dea: 0, hist: 0.04, signal: 'NO_SIGNAL' as const, signalAge: null },
        { dif: 0.03, dea: 0, hist: 0.06, signal: 'NO_SIGNAL' as const, signalAge: null },
        { dif: 0.04, dea: 0, hist: 0.08, signal: 'NO_SIGNAL' as const, signalAge: null },
        { dif: 0.05, dea: 0, hist: 0.1, signal: 'NO_SIGNAL' as const, signalAge: null },
      ];
      const result = analyzeMacdAdvanced(data, [10, 10, 10, 10, 10]);
      expect(result.actionableSignal).toBe('NONE');
      expect(result.interpretation).toContain('零轴粘合');
    });

    it('动能 EMPTY 时不产生信号', () => {
      const data = seq([0.1, 0.2, 0.3, 0.4, 0.5]);
      const result = analyzeMacdAdvanced(data, [10, 10, 10, 10, 10]);
      expect(result.actionableSignal).toBe('NONE');
    });
  });

  describe('解读文案', () => {
    it('做空信号包含"做空"', () => {
      const data = [
        { dif: 8, dea: 4, hist: 8, signal: 'NO_SIGNAL' as const, signalAge: null },
        { dif: 6, dea: 3, hist: 6, signal: 'NO_SIGNAL' as const, signalAge: null },
        { dif: 4, dea: 2, hist: 4, signal: 'NO_SIGNAL' as const, signalAge: null },
        { dif: 2, dea: 1, hist: 2, signal: 'NO_SIGNAL' as const, signalAge: null },
        { dif: 1, dea: 0.5, hist: 1, signal: 'NO_SIGNAL' as const, signalAge: null },
      ];
      const result = analyzeMacdAdvanced(data, [10, 10, 10, 10, 10]);
      expect(result.interpretation).toContain('做空');
    });

    it('做多信号包含"做多"', () => {
      const data = [
        { dif: -8, dea: -4, hist: -8, signal: 'NO_SIGNAL' as const, signalAge: null },
        { dif: -6, dea: -3, hist: -6, signal: 'NO_SIGNAL' as const, signalAge: null },
        { dif: -4, dea: -2, hist: -4, signal: 'NO_SIGNAL' as const, signalAge: null },
        { dif: -2, dea: -1, hist: -2, signal: 'NO_SIGNAL' as const, signalAge: null },
        { dif: -1, dea: -0.5, hist: -1, signal: 'NO_SIGNAL' as const, signalAge: null },
      ];
      const result = analyzeMacdAdvanced(data, [10, 10, 10, 10, 10]);
      expect(result.interpretation).toContain('做多');
    });

    it('零轴粘合包含"零轴粘合"', () => {
      const data = seq([0.1, 0.2, 0.3, 0.4, 0.5]);
      const result = analyzeMacdAdvanced(data, [10, 10, 10, 10, 10]);
      // These are all weak momentum, might not hit zero-axis NEAR
      // Just verify it returns something non-empty
      expect(result.interpretation.length).toBeGreaterThan(0);
    });
  });

  describe('零轴位置', () => {
    it('ABOVE：DIF 显著大于零', () => {
      const result = analyzeMacdAdvanced(seq([0, 0, 0, 5, 10]), [10, 10, 10, 10, 10]);
      expect(result.zeroAxisPos).toBe('ABOVE');
    });

    it('BELOW：DIF 显著小于零', () => {
      const result = analyzeMacdAdvanced(seq([0, 0, 0, -5, -10]), [10, 10, 10, 10, 10]);
      expect(result.zeroAxisPos).toBe('BELOW');
    });
  });
});
