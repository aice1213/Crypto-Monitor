import { describe, it, expect } from 'vitest';
import type { CandleDto, TradePlan } from '@crypto-monitor/shared';
import {
  buildEmaSeries,
  buildEntryBand,
  buildMacdPane,
  buildObvPane,
  buildPlanLevels,
  buildRsiSeries,
  emaPeriodsFor,
  EMA_PERIODS,
  macdWarmupBars,
} from './chartData';

function genCandles(n: number, start = 100, drift = 0.3): CandleDto[] {
  const out: CandleDto[] = [];
  let price = start;
  for (let i = 0; i < n; i++) {
    const open = price;
    const close = price + drift + Math.sin(i / 3) * 1.5;
    out.push({
      time: 1_700_000_000 + i * 900,
      open,
      high: Math.max(open, close) + 1,
      low: Math.min(open, close) - 1,
      close,
      volume: 1000 + (i % 13) * 90,
    });
    price = close;
  }
  return out;
}

const plan = (over: Partial<TradePlan> = {}): TradePlan => ({
  entryLow: 100,
  entryHigh: 101,
  tp1: 110,
  tp2: 111,
  sl: 98,
  rrRatio: 5,
  side: 'LONG',
  reason: 'test',
  ...over,
});

describe('序列与 K 线按时间对齐', () => {
  const candles = genCandles(200);

  it('所有点的时间戳都能在 candles 中找到（不得错位）', () => {
    const times = new Set(candles.map((c) => c.time));
    const ema7 = buildEmaSeries(candles, 7);
    const rsi = buildRsiSeries(candles);
    const macd = buildMacdPane(candles);
    const obv = buildObvPane(candles);
    const all = [...ema7, ...rsi, ...macd.hist, ...macd.dif, ...macd.dea, ...obv.obv, ...obv.ma20];
    expect(all.length).toBeGreaterThan(0);
    for (const p of all) {
      expect(times.has(p.time), `未知时间戳 ${p.time}`).toBe(true);
    }
  });

  it('所有点按时间严格递增', () => {
    for (const series of [
      buildEmaSeries(candles, 7),
      buildRsiSeries(candles),
      buildMacdPane(candles).hist,
      buildObvPane(candles).obv,
      buildObvPane(candles).ma20,
    ]) {
      expect(series.every((p, i) => i === 0 || series[i - 1]!.time < p.time)).toBe(true);
    }
  });

  it('噪声点（未收盘根等短序列）不产生 NaN 值', () => {
    for (const n of [1, 2, 5, 14, 15, 20, 34, 40]) {
      const c = genCandles(n);
      for (const series of [
        buildEmaSeries(c, 7),
        buildRsiSeries(c),
        buildMacdPane(c).hist,
        buildMacdPane(c).dif,
        buildObvPane(c).obv,
        buildObvPane(c).ma20,
      ]) {
        expect(series.every((p) => Number.isFinite(p.value))).toBe(true);
      }
    }
  });

  it('空输入返回空序列，不抛错', () => {
    expect(buildEmaSeries([], 7)).toEqual([]);
    expect(buildRsiSeries([])).toEqual([]);
    expect(buildMacdPane([])).toEqual({ hist: [], dif: [], dea: [] });
    expect(buildObvPane([])).toEqual({ obv: [], ma20: [] });
  });
});

describe('MACD 副图不画预热期', () => {
  it('预热根数 = (slow − 1) + (signal − 1) = 33', () => {
    expect(macdWarmupBars(26, 9)).toBe(33);
  });

  it('首个点从预热结束开始，不出现"贴着 0 的假柱"', () => {
    const candles = genCandles(60);
    const { hist, dif, dea } = buildMacdPane(candles);
    expect(hist).toHaveLength(60 - macdWarmupBars());
    expect(hist[0]!.time).toBe(candles[macdWarmupBars()]!.time);
    expect(dif[0]!.time).toBe(candles[macdWarmupBars()]!.time);
    expect(dea[0]!.time).toBe(candles[macdWarmupBars()]!.time);
  });

  it('柱颜色按正负区分', () => {
    const { hist } = buildMacdPane(genCandles(200));
    for (const h of hist) {
      expect(h.color).toBe(h.value >= 0 ? '#26a69a' : '#ef5350');
    }
  });

  it('hist = (dif − dea) × 2 与引擎口径一致', () => {
    const candles = genCandles(200);
    const { hist, dif, dea } = buildMacdPane(candles);
    for (let i = 0; i < hist.length; i++) {
      expect(hist[i]!.value).toBeCloseTo((dif[i]!.value - dea[i]!.value) * 2, 10);
    }
  });
});

describe('RSI 副图', () => {
  it('值域落在 0~100 且预热期被丢弃', () => {
    const candles = genCandles(200);
    const rsi = buildRsiSeries(candles);
    expect(rsi).toHaveLength(200 - 14);
    expect(rsi[0]!.time).toBe(candles[14]!.time);
    for (const p of rsi) {
      expect(p.value).toBeGreaterThanOrEqual(0);
      expect(p.value).toBeLessThanOrEqual(100);
    }
  });
});

describe('OBV 副图', () => {
  it('OBV 从第 0 根就有值，MA20 从第 19 根开始', () => {
    const candles = genCandles(60);
    const { obv, ma20 } = buildObvPane(candles);
    expect(obv).toHaveLength(60);
    expect(obv[0]!.time).toBe(candles[0]!.time);
    expect(ma20).toHaveLength(60 - 19);
    expect(ma20[0]!.time).toBe(candles[19]!.time);
  });

  it('MA20 不会在预热期退化为与 OBV 重合', () => {
    const candles = genCandles(60);
    const { obv, ma20 } = buildObvPane(candles);
    const ma20Times = new Set(ma20.map((p) => p.time));
    // 前 19 根不应出现在 MA20 里
    for (let i = 0; i < 19; i++) {
      expect(ma20Times.has(obv[i]!.time)).toBe(false);
    }
  });
});

describe('进场区', () => {
  it('plan 为 null 时返回 null（绝不凭空画阴影）', () => {
    expect(buildEntryBand(null)).toBeNull();
  });

  it('做多绿、做空红，且 low/high 归一化', () => {
    const long = buildEntryBand(plan({ side: 'LONG', entryLow: 101, entryHigh: 100 }));
    expect(long).not.toBeNull();
    expect(long!.low).toBe(100);
    expect(long!.high).toBe(101);
    expect(long!.color).toContain('38, 166, 154');

    const short = buildEntryBand(plan({ side: 'SHORT' }));
    expect(short!.color).toContain('239, 83, 80');
  });

  it('退化输入（上下相等 / 非有限值）返回 null', () => {
    expect(buildEntryBand(plan({ entryLow: 100, entryHigh: 100 }))).toBeNull();
    expect(buildEntryBand(plan({ entryLow: NaN }))).toBeNull();
    expect(buildEntryBand(plan({ entryHigh: Infinity }))).toBeNull();
  });
});

describe('计划价位线', () => {
  it('plan 为 null 时不画任何线', () => {
    expect(buildPlanLevels(null)).toEqual([]);
  });

  it('包含 TP1 / TP2 / SL', () => {
    const levels = buildPlanLevels(plan());
    expect(levels.map((l) => l.title)).toEqual(['TP1 +', 'TP2', 'SL']);
    expect(levels.map((l) => l.price)).toEqual([110, 111, 98]);
  });

  it('做空时 TP1 标题方向相反', () => {
    expect(buildPlanLevels(plan({ side: 'SHORT' }))[0]!.title).toBe('TP1 -');
  });

  it('过滤掉非有限价位，避免画到无穷远', () => {
    const levels = buildPlanLevels(plan({ tp2: NaN }));
    expect(levels.some((l) => l.title === 'TP2')).toBe(false);
    expect(levels).toHaveLength(2);
  });
});

describe('EMA 双线周期配置', () => {
  it('各周期均配置了快线/慢线两条，且快线 < 慢线', () => {
    expect(Object.keys(EMA_PERIODS).sort()).toEqual(['15m', '1m', '5m']);
    for (const [fast, slow] of Object.values(EMA_PERIODS)) {
      expect(fast).toBeGreaterThan(0);
      expect(slow).toBeGreaterThan(fast);
    }
  });

  it('1m=9/21, 5m=9/20, 15m=20/50（Aice 配置）', () => {
    expect(EMA_PERIODS['1m']).toEqual([9, 21]);
    expect(EMA_PERIODS['5m']).toEqual([9, 20]);
    expect(EMA_PERIODS['15m']).toEqual([20, 50]);
  });

  it('未登记周期回退到 15m 的 20/50', () => {
    expect(emaPeriodsFor('30m')).toEqual([20, 50]);
    expect(emaPeriodsFor('1h')).toEqual([20, 50]);
    expect(emaPeriodsFor('1m')).toEqual([9, 21]);
  });
});
