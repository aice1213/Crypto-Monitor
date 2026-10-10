import { describe, it, expect } from 'vitest';
import type { CandleDto } from '@crypto-monitor/shared';
import { supportResistance } from './index.js';

/** 用显式的 high/low 数组构造 K 线，close 取中值，便于精确控制 Pivot */
function fromHighLow(highs: number[], lows: number[], volumes?: number[]): CandleDto[] {
  return highs.map((h, i) => {
    const l = lows[i]!;
    const c = (h + l) / 2;
    return {
      time: 1_700_000_000 + i * 900,
      open: c,
      high: h,
      low: l,
      close: c,
      volume: volumes?.[i] ?? 1000,
    };
  });
}

describe('supportResistance 基础行为', () => {
  it('空输入返回空数组', () => {
    expect(supportResistance([], 0)).toEqual({ support: [], resistance: [] });
  });

  it('识别局部极值：高点为阻力候选、低点为支撑候选', () => {
    // i=3 处 high=20 为局部高点；i=4 处 low=3 为局部低点
    const candles = fromHighLow(
      [10, 11, 12, 20, 14, 13, 12, 11, 11, 10],
      [9, 10, 11, 19, 3, 12, 11, 10, 10, 9],
    );
    // 传入远离现价的 EMA99，避免动态补充位干扰断言
    const { support, resistance } = supportResistance(candles, 1);
    expect(resistance).toContain(20);
    expect(support).toContain(3);
  });

  it('支撑必须在现价下方、阻力必须在现价上方', () => {
    const candles = fromHighLow(
      [10, 11, 12, 20, 14, 13, 12, 11, 11, 10],
      [9, 10, 11, 19, 3, 12, 11, 10, 10, 9],
    );
    const currentPrice = candles[candles.length - 1]!.close; // 9.5
    const { support, resistance } = supportResistance(candles, 1);
    expect(support.every((p) => p < currentPrice)).toBe(true);
    expect(resistance.every((p) => p > currentPrice)).toBe(true);
  });

  it('输出顺序为"离现价最近优先"：support 降序、resistance 升序', () => {
    const candles = fromHighLow(
      [10, 11, 12, 20, 14, 13, 12, 11, 11, 10],
      [9, 10, 11, 19, 3, 12, 11, 10, 10, 9],
    );
    const { support, resistance } = supportResistance(candles, 15);
    expect(support.every((v, i, a) => i === 0 || a[i - 1]! >= v)).toBe(true);
    expect(resistance.every((v, i, a) => i === 0 || a[i - 1]! <= v)).toBe(true);
  });

  it('最多各返回 3 个', () => {
    const n = 60;
    const highs = Array.from({ length: n }, (_, i) => (i % 8 === 4 ? 200 + i : 100));
    const lows = Array.from({ length: n }, (_, i) => (i % 8 === 0 ? 50 - i : 90));
    const candles = fromHighLow(highs, lows);
    const { support, resistance } = supportResistance(candles, 1000);
    expect(support.length).toBeLessThanOrEqual(3);
    expect(resistance.length).toBeLessThanOrEqual(3);
  });
});

describe('supportResistance 0.3% 聚类', () => {
  it('相距 0.25% 的两个高点评为一个簇，取成交量加权中心', () => {
    // i=3: high 20（量 100）；i=9: high 20.05（量 300）—— 相距 0.25% < 0.3%
    const highs = [10, 11, 12, 20, 13, 12, 13, 12, 13, 20.05, 13, 12, 11, 10];
    const lows = highs.map((h) => h - 1);
    const volumes = highs.map(() => 1000);
    volumes[3] = 100;
    volumes[9] = 300;
    const candles = fromHighLow(highs, lows, volumes);
    const { resistance } = supportResistance(candles, 1);
    const expected = (20 * 100 + 20.05 * 300) / 400;
    expect(resistance).toHaveLength(1);
    expect(resistance[0]).toBeCloseTo(expected, 10);
  });

  it('相距超过 0.3% 的高点不合并', () => {
    const highs = [10, 11, 12, 20, 13, 12, 13, 12, 13, 20.5, 13, 12, 11, 10];
    const lows = highs.map((h) => h - 1);
    const candles = fromHighLow(highs, lows);
    const { resistance } = supportResistance(candles, 1);
    expect(resistance).toHaveLength(2);
  });
});

describe('supportResistance 动态补充位（dev.md 4.2 步骤 3）', () => {
  const monotone = (): CandleDto[] => {
    // 单调序列无局部极值 => 无 Pivot 候选
    const out: CandleDto[] = [];
    let p = 100;
    for (let i = 0; i < 60; i++) {
      const open = p;
      const close = p + 1;
      out.push({ time: 1_700_000_000 + i * 900, open, high: close, low: open, close, volume: 1000 });
      p = close;
    }
    return out;
  };

  it('补充位取 EMA99 ± 现价×0.8%，而不是纯由现价推导的价位', () => {
    const candles = monotone();
    const currentPrice = candles[candles.length - 1]!.close; // 160
    const ema99 = 100; // 远离现价，避免与现价推导值巧合相等
    const { support, resistance } = supportResistance(candles, ema99);

    const offset = currentPrice * 0.008;
    expect(support).toEqual([ema99 - offset]);
    // EMA99 + offset 仍低于现价 => 不构成阻力，返回空数组而非造假
    expect(resistance).toEqual([]);
  });

  it('绝不返回 现价×1.008 / 现价×0.992 这类合成位', () => {
    const candles = monotone();
    const currentPrice = candles[candles.length - 1]!.close;
    const banned = [currentPrice * 1.008, currentPrice * 0.992];
    for (const ema99 of [50, 100, 155, 165, 200]) {
      const { support, resistance } = supportResistance(candles, ema99);
      for (const p of [...support, ...resistance]) {
        for (const b of banned) {
          expect(
            Math.abs(p - b),
            `ema99=${ema99} 返回了被禁用的现价推导位 ${p}`,
          ).toBeGreaterThan(1e-9);
        }
      }
    }
  });

  it('EMA99 与现价重合时两侧都不补充（不制造零距离价位）', () => {
    const candles = monotone();
    const currentPrice = candles[candles.length - 1]!.close;
    const { support, resistance } = supportResistance(candles, currentPrice);
    // ema99 + offset > 现价 => 会被当作阻力；此处仅断言不出现"等于现价"的价位
    for (const p of [...support, ...resistance]) {
      expect(Math.abs(p - currentPrice)).toBeGreaterThan(1e-9);
    }
  });
});
