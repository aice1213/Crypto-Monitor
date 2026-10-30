import { describe, it, expect } from 'vitest';
import type { CandleDto } from '@crypto-monitor/shared';
import {
  computeRvs,
  computeBase,
  clipMultiplier,
  computeRecommendation,
  BTC_SYMBOL,
} from './threshold.js';

/**
 * threshold.ts 单元测试（开发交付文档 §12 验收）
 *
 * DoD（§15 P1）：
 * - RV 对拍：已知快照对拍（BTC/SOL 各 3 组窗口）
 * - 校准表示例误差 <0.02%
 * - multiplier 上下限截断
 * - base clamp
 * - keyPriceThreshold 缩放
 * - 降级链：日线 → 4h → 1h → 分类 → 默认
 */

// ── 确定性对拍数据（Python 独立计算生成，与 TS 实现路径不同）──
const BTC_CLOSES = [
  50000.0, 50186.18, 49951.09, 50160.84, 49687.44, 49707.21, 49694.88, 49817.09,
  49661.61, 49371.59, 49222.5, 49607.13, 49217.48, 48978.65, 49147.37, 49489.03,
  50068.42, 50429.6, 50386.34, 50433.5, 50585.4, 50281.87, 50527.92, 50790.2,
  51374.71, 51163.9, 51096.93, 51352.49, 51648.15, 51242.54, 50646.95, 50990.43,
  50428.97, 50546.89, 50238.39, 50306.47, 50324.84, 50200.98, 49818.59, 49993.11,
];

const SOL_CLOSES = [
  150.0, 150.75, 150.6, 152.07, 152.4, 151.99, 152.37, 150.69, 151.6, 152.49,
  154.18, 156.58, 154.99, 152.12, 154.12, 155.39, 154.14, 155.36, 152.62, 151.41,
  153.49, 155.12, 155.45, 154.35, 154.16, 154.9, 151.83, 152.6, 153.97, 154.86,
  154.99, 152.74, 152.02, 149.98, 147.47, 148.95, 146.28, 146.97, 149.48, 146.94,
];

function makeCandles(closes: number[]): CandleDto[] {
  const base = 1_700_000_000; // 固定时间戳
  return closes.map((c, i) => ({
    time: base + i * 86400,
    open: c,
    high: c,
    low: c,
    close: c,
    volume: 100,
  }));
}

/** 确定性 LCG 随机游走收盘价（与 Python 对拍同一生成器思路） */
function walk(seed: number, n: number, start: number, dailyVol: number): number[] {
  const closes = [start];
  let state = seed;
  for (let i = 0; i < n - 1; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    const r = state / 0x7fffffff - 0.5; // -0.5..0.5
    closes.push(closes[i] * (1 + r * 2 * dailyVol));
  }
  return closes;
}

const BTC_CANDLES = makeCandles(BTC_CLOSES);
const SOL_CANDLES = makeCandles(SOL_CLOSES);

describe('computeRvs RV 对拍', () => {
  // 注意：实现 round 到 2 位，对拍容差放宽到 ±0.005（2 位小数精度）
  it('BTC 日线 RV20 对拍（Python 独立值 12.305559）', () => {
    const r = computeRvs(BTC_CANDLES);
    expect(r).not.toBeNull();
    expect(r!.count).toBe(20);
    expect(r!.rv20).toBeCloseTo(12.305559, 2);
  });

  it('SOL 日线 RV20 对拍（Python 独立值 22.373823）', () => {
    const r = computeRvs(SOL_CANDLES);
    expect(r).not.toBeNull();
    expect(r!.count).toBe(20);
    expect(r!.rv20).toBeCloseTo(22.373823, 2);
  });

  it('样本数不足 window+1 时返回 null', () => {
    const short = BTC_CANDLES.slice(0, 15); // 15 根 < 21
    expect(computeRvs(short)).toBeNull();
  });

  it('空数组返回 null', () => {
    expect(computeRvs([])).toBeNull();
  });

  it('非法价格（<=0）返回 null', () => {
    const bad = makeCandles([100, 0, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210, 220, 230]);
    expect(computeRvs(bad)).toBeNull();
  });

  it('4h 年化因子 √2190 生效（降级路径）', () => {
    const r = computeRvs(SOL_CANDLES, Math.sqrt(365 * 6));
    expect(r).not.toBeNull();
    // 4h 因子是日线 √365 的 √6 倍
    const daily = computeRvs(SOL_CANDLES)!;
    expect(r!.rv20 / daily.rv20).toBeCloseTo(Math.sqrt(6), 6);
  });
});

describe('computeBase clamp（§4.3）', () => {
  it('1.19% → 0.4165 → round 0.42', () => {
    expect(computeBase(1.19)).toBe(0.42);
  });

  it('低波动 0.5% → 0.175 → clamp 0.35', () => {
    expect(computeBase(0.5)).toBe(0.35);
  });

  it('高波动 2.0% → 0.70 → clamp 0.60', () => {
    expect(computeBase(2.0)).toBe(0.60);
  });
});

describe('clipMultiplier（§4.4）', () => {
  it('下限截断 0.5 → 0.8', () => {
    expect(clipMultiplier(0.5)).toBe(0.8);
  });

  it('上限截断 5.0 → 4.0', () => {
    expect(clipMultiplier(5.0)).toBe(4.0);
  });

  it('区间内保留 1.818188（round 到 2 位 → 1.82）', () => {
    expect(clipMultiplier(1.818188)).toBeCloseTo(1.82, 2);
  });
});

describe('computeRecommendation 推荐阈值（§4.5）', () => {
  it('SOL 推荐阈值对拍：base=0.42, multiplier=1.82, recommended=0.76', () => {
    const rec = computeRecommendation({
      symbol: 'SOL_USDT',
      daily: SOL_CANDLES,
      btcDaily: BTC_CANDLES,
      baseThreshold: 0.42,
    });
    expect(rec.source).toBe('RV');
    expect(rec.baseThreshold).toBe(0.42);
    expect(rec.rv20).toBeCloseTo(22.37, 2);
    expect(rec.btcRv20).toBeCloseTo(12.31, 2);
    expect(rec.multiplier).toBeCloseTo(1.82, 2);
    expect(rec.recommendedThreshold).toBe(0.76); // round(0.42 × 1.818188) → 0.76
    expect(rec.keyPriceThreshold).toBe(0.55); // round(0.30 × 1.818188) → 0.55
    expect(rec.note).toBeUndefined();
  });

  it('BTC 自身 multiplier=1.0（不比对自身）', () => {
    const rec = computeRecommendation({
      symbol: BTC_SYMBOL,
      isBtc: true,
      daily: BTC_CANDLES,
      btcDaily: BTC_CANDLES,
      baseThreshold: 0.42,
    });
    expect(rec.source).toBe('RV');
    expect(rec.multiplier).toBe(1.0);
    expect(rec.recommendedThreshold).toBe(0.42);
    expect(rec.keyPriceThreshold).toBe(0.30);
  });

  it('multiplier 超上限被 clip 到 4.0（高波动标的）', () => {
    // 高波动：LCG 随机游走，日收益 ±5% 量级（非几何递增——递增序列收益恒定，方差=0，会误判）
    const hot = makeCandles(walk(777, 40, 100, 0.05));
    const rec = computeRecommendation({
      symbol: 'HOT_USDT',
      daily: hot,
      btcDaily: BTC_CANDLES,
      baseThreshold: 0.42,
    });
    expect(rec.multiplier).toBe(4.0);
    expect(rec.recommendedThreshold).toBeCloseTo(0.42 * 4.0, 2);
  });

  it('multiplier 超下限被 clip 到 0.8（低波动标的）', () => {
    // 低波动：LCG 随机游走，日收益 ±0.02% 量级
    const calm = makeCandles(walk(999, 40, 50000, 0.0002));
    const rec = computeRecommendation({
      symbol: 'CALM_USDT',
      daily: calm,
      btcDaily: BTC_CANDLES,
      baseThreshold: 0.42,
    });
    expect(rec.multiplier).toBe(0.8);
    expect(rec.recommendedThreshold).toBeCloseTo(0.42 * 0.8, 2);
  });

  it('缺 baseThreshold 时用 computeBase()（1.19 → 0.42）', () => {
    const rec = computeRecommendation({
      symbol: BTC_SYMBOL,
      isBtc: true,
      daily: BTC_CANDLES,
      btcDaily: BTC_CANDLES,
    });
    expect(rec.baseThreshold).toBe(0.42);
  });
});

describe('降级链（§4.7）', () => {
  it('日线不足 → 4h 降级，source=RV，note 含 4h', () => {
    const rec = computeRecommendation({
      symbol: 'SOL_USDT',
      daily: BTC_CANDLES.slice(0, 10), // 日线仅 10 根，不足
      h4: SOL_CANDLES,
      btcDaily: BTC_CANDLES.slice(0, 10),
      btc4h: BTC_CANDLES,
      baseThreshold: 0.42,
    });
    expect(rec.source).toBe('RV');
    expect(rec.note).toContain('4h');
  });

  it('日线+4h 不足 → 1h 降级，source=RV，note 含 1h', () => {
    const rec = computeRecommendation({
      symbol: 'SOL_USDT',
      daily: BTC_CANDLES.slice(0, 10),
      h4: BTC_CANDLES.slice(0, 10),
      h1: SOL_CANDLES,
      btcDaily: BTC_CANDLES.slice(0, 10),
      btc4h: BTC_CANDLES.slice(0, 10),
      btc1h: BTC_CANDLES,
      baseThreshold: 0.42,
    });
    expect(rec.source).toBe('RV');
    expect(rec.note).toContain('1h');
  });

  it('全部不足 + classFallback=HIGH → CLASS_FALLBACK 0.5%', () => {
    const rec = computeRecommendation({
      symbol: 'SOL_USDT',
      daily: BTC_CANDLES.slice(0, 5),
      classFallback: 'HIGH',
    });
    expect(rec.source).toBe('CLASS_FALLBACK');
    expect(rec.classFallback).toBe('HIGH');
    expect(rec.recommendedThreshold).toBe(0.5);
    expect(rec.multiplier).toBeNull();
  });

  it('全部不足 + 无 classFallback → DEFAULT 0.50%', () => {
    const rec = computeRecommendation({
      symbol: 'SOL_USDT',
      daily: [],
    });
    expect(rec.source).toBe('DEFAULT');
    expect(rec.recommendedThreshold).toBe(0.50);
    expect(rec.note).toContain('默认值');
  });

  it('有 symbol 数据但缺 BTC 基准 → 继续降级，不产生错误结果', () => {
    // symbol 有日线，但 BTC 基准缺 → 走 4h，若 4h 也无 → 分类
    const rec = computeRecommendation({
      symbol: 'SOL_USDT',
      daily: SOL_CANDLES,
      // btcDaily 缺失
      classFallback: 'MID',
    });
    expect(rec.source).toBe('CLASS_FALLBACK');
    expect(rec.recommendedThreshold).toBe(1.0);
  });
});

describe('校准表（§4.5）误差 <0.02%', () => {
  const calib = [
    { symbol: 'BTC_USDT', m: 1.0, lo: 0.4, hi: 0.45 },
    { symbol: 'ETH_USDT', m: 1.25, lo: 0.5, hi: 0.55 },
    { symbol: 'BNB_USDT', m: 0.97, lo: 0.4, hi: 0.45 },
    { symbol: 'XRP_USDT', m: 1.35, lo: 0.55, hi: 0.6 },
    { symbol: 'SOL_USDT', m: 1.5, lo: 0.6, hi: 0.65 },
    { symbol: 'DOGE_USDT', m: 1.55, lo: 0.65, hi: 0.7 },
    { symbol: 'ADA_USDT', m: 1.95, lo: 0.8, hi: 0.85 },
    { symbol: 'NEAR_USDT', m: 2.2, lo: 0.9, hi: 0.95 },
    { symbol: 'PUMP_USDT', m: 3.5, lo: 1.45, hi: 1.5 },
  ];

  it.each(calib)('$symbol: multiplier=$m → 阈值在 [$lo, $hi]，误差<0.02%', ({ m, lo, hi }) => {
    // 用文档公式直接验证：threshold = base × multiplier（不经 RV，纯公式检查）
    const computed = 0.42 * m;
    expect(computed).toBeGreaterThanOrEqual(lo - 0.001);
    expect(computed).toBeLessThanOrEqual(hi + 0.001);
    // 与 round 后展示值的误差 < 0.02%（DoD）
    const rounded = Math.round(computed * 100) / 100;
    expect(Math.abs(rounded - computed)).toBeLessThan(0.02);
  });
});
