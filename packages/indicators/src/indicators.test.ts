import { describe, it, expect } from 'vitest';
import { ema, rsi, computeSnapshot, buildTradePlan, compositeScore, dropUnclosedCandle, stopLoss, supportResistance, rsiZone, intervalSeconds } from './index.js';
import type { CandleDto } from '@crypto-monitor/shared';
import { BASE_SL_PCT, MAX_SL_PCT, RSI_OVERBOUGHT, RSI_OVERSOLD, SCORE_MACD_RECENT_WEIGHT, SCORE_MACD_WEIGHT, SCORE_RSI_WEIGHT, SUPPORTED_INTERVALS } from '@crypto-monitor/shared';

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

  it('完全横盘（无涨无跌）返回 50 而非 100', () => {
    // 修复前 avgLoss === 0 直接返回 100 => 被判"超买"并扣分
    const flat = Array.from({ length: 40 }, () => 100);
    const r = rsi(flat, 14);
    expect(r[39]).toBe(50);
  });

  it('横盘序列的 computeSnapshot 判为中性而非超买', () => {
    const flat: CandleDto[] = Array.from({ length: 40 }, (_, i) => ({
      time: 1_700_000_000 + i * 900,
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      volume: 100,
    }));
    // 用 now 早于末根收盘，避免末根被当作未收盘剔除
    const snap = computeSnapshot(flat, '15m');
    expect(snap.rsi14).toBe(50);
    expect(snap.rsiZone).toBe('NEUTRAL');
  });
});

describe('rsiZone 边界', () => {
  it('闭区间：恰好 70 判超买、恰好 30 判超卖（与卡片文案同源）', () => {
    expect(rsiZone(RSI_OVERBOUGHT)).toBe('OVERBOUGHT');
    expect(rsiZone(RSI_OVERSOLD)).toBe('OVERSOLD');
    expect(rsiZone(RSI_OVERBOUGHT - 0.1)).toBe('NEUTRAL');
    expect(rsiZone(RSI_OVERSOLD + 0.1)).toBe('NEUTRAL');
  });
});

describe('intervalSeconds', () => {
  it('1h 必须映射为 3600（否则 1h K 线全部被判为缺口）', () => {
    expect(intervalSeconds('1h')).toBe(3600);
    expect(intervalSeconds('15m')).toBe(900);
    expect(intervalSeconds('1d')).toBe(86400);
  });

  it('shared 的 SUPPORTED_INTERVALS 与 INTERVAL_SEC 登记表不得漂移', () => {
    // 两张表若不一致，白名单放行的周期会在引擎里退化为 900 秒，
    // 使该周期每根 K 线都被判为"缺口"（F17 的成因）。
    for (const iv of SUPPORTED_INTERVALS) {
      if (iv === '15m') continue; // 900 是缺省兜底值，与 15m 同值无法区分
      expect(intervalSeconds(iv), `周期 ${iv} 未在 INTERVAL_SEC 中登记`).not.toBe(900);
    }
  });

  it('未登记的周期回退为 15m 秒数', () => {
    expect(intervalSeconds('3m')).toBe(900);
    expect(intervalSeconds('')).toBe(900);
    expect(intervalSeconds('7d')).toBe(900);
  });

  it('1h K 线的快照数据质量不应恒为 INSUFFICIENT', () => {
    // 50 根连续 1h K 线，无缺口
    const candles: CandleDto[] = [];
    let price = 100;
    for (let i = 0; i < 50; i++) {
      const open = price;
      const close = price + Math.sin(i / 3) * 2;
      candles.push({
        time: 1_700_000_000 + i * 3600,
        open,
        high: Math.max(open, close) + 1,
        low: Math.min(open, close) - 1,
        close,
        volume: 1000,
      });
      price = close;
    }
    // 以远晚于末根开盘的时间调用，确保末根被视为已收盘
    const snap = computeSnapshot(candles, '1h');
    expect(snap.dataQuality).not.toBe('INSUFFICIENT');
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
    expect(snap.rsi14).toBeLessThan(100);
    expect(snap.trend.score).toBeGreaterThanOrEqual(-100);
    expect(snap.trend.score).toBeLessThanOrEqual(100);
    expect(snap.support.length).toBeLessThanOrEqual(3);
    expect(snap.resistance.length).toBeLessThanOrEqual(3);
  });

  it('支撑与阻力不返回重复价位', () => {
    const candles = genCandles(160, 100, 0.05);
    const snap = computeSnapshot(candles, '15m');
    expect(new Set(snap.support).size).toBe(snap.support.length);
    expect(new Set(snap.resistance).size).toBe(snap.resistance.length);
  });
});

describe('compositeScore', () => {
  it('全部看涨信号（当根金叉）得分 >= 40', () => {
    const t = compositeScore({
      emaStructure: 'BULLISH',
      macd: { dif: 1, dea: 0, hist: 2, signal: 'GOLDEN_CROSS', signalAge: 0 },
      rsiZone: 'OVERSOLD',
      obvFlow: 'INFLOW',
    });
    expect(t.direction).toBe('BULLISH');
    expect(t.score).toBeGreaterThanOrEqual(40);
  });

  it('全部看跌信号（当根死叉）得分 <= -40', () => {
    const t = compositeScore({
      emaStructure: 'BEARISH',
      macd: { dif: -1, dea: 0, hist: -2, signal: 'DEATH_CROSS', signalAge: 0 },
      rsiZone: 'OVERBOUGHT',
      obvFlow: 'OUTFLOW',
    });
    expect(t.direction).toBe('BEARISH');
    expect(t.score).toBeLessThanOrEqual(-40);
  });

  it('保留期内的交叉按弱权重计（审查项 F19）', () => {
    const base = {
      emaStructure: 'BULLISH' as const,
      rsiZone: 'NEUTRAL' as const,
      obvFlow: 'BALANCED' as const,
    };
    const fresh = compositeScore({
      ...base,
      macd: { dif: 1, dea: 0, hist: 2, signal: 'GOLDEN_CROSS', signalAge: 0 },
    });
    const recent = compositeScore({
      ...base,
      macd: { dif: 1, dea: 0, hist: 2, signal: 'GOLDEN_CROSS', signalAge: 2 },
    });
    expect(fresh.score).toBe(30 + SCORE_MACD_WEIGHT);
    expect(recent.score).toBe(30 + SCORE_MACD_RECENT_WEIGHT);
    expect(recent.score).toBeLessThan(fresh.score);
  });

  it('signalAge 为 null 的交叉退化按弱权重处理', () => {
    const t = compositeScore({
      emaStructure: 'BULLISH',
      macd: { dif: 1, dea: 0, hist: 2, signal: 'GOLDEN_CROSS', signalAge: null },
      rsiZone: 'NEUTRAL',
      obvFlow: 'BALANCED',
    });
    expect(t.score).toBe(30 + SCORE_MACD_RECENT_WEIGHT);
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

  it('止损不被次近支撑无限外推（上限 3%）', () => {
    // 次近支撑 90 距进场区远端 94.715 约 5%，若无上限止损会被推到 89.91（5.07%）
    const plan = buildTradePlan({
      direction: 'BULLISH',
      score: 60,
      ema25: 100,
      support: [95, 90],
      resistance: [110, 120],
    })!;
    const far = plan.entryLow;
    expect(Math.abs(far - plan.sl) / far).toBeLessThanOrEqual(MAX_SL_PCT + 1e-9);
  });

  it('次近支撑很远时不应把合格计划判死', () => {
    // 修复前：止损被推到次近支撑 88 下方（约 10%），RR 被压到 1.19 而返回 null
    // 修复后：止损为 1.5% 基础值，真实 RR 约 6.8，计划应正常产出
    const plan = buildTradePlan({
      direction: 'BULLISH',
      score: 55,
      ema25: 100,
      support: [98, 88],
      resistance: [110, 120],
    });
    expect(plan).not.toBeNull();
    expect(plan!.side).toBe('LONG');
    expect(plan!.rrRatio).toBeGreaterThan(1.5);
  });

  it('次近支撑落在 1.5%~3% 之间时采用结构位（更宽但仍受上限约束）', () => {
    const plan = buildTradePlan({
      direction: 'BULLISH',
      score: 55,
      ema25: 100,
      support: [99, 97],
      resistance: [110, 120],
    })!;
    const far = plan.entryLow; // 98.703
    const slPct = Math.abs(far - plan.sl) / far;
    expect(slPct).toBeGreaterThan(BASE_SL_PCT);
    expect(slPct).toBeLessThanOrEqual(MAX_SL_PCT + 1e-9);
  });

  it('空头止损同样受 3% 上限约束', () => {
    const plan = buildTradePlan({
      direction: 'BEARISH',
      score: -60,
      ema25: 100,
      support: [80, 85],
      resistance: [105, 115],
    })!;
    const far = plan.entryHigh;
    expect(Math.abs(plan.sl - far) / far).toBeLessThanOrEqual(MAX_SL_PCT + 1e-9);
  });

  it('支撑为空时不出计划（不得凭空造出场价）', () => {
    expect(
      buildTradePlan({ direction: 'BULLISH', score: 60, ema25: 100, support: [], resistance: [110] }),
    ).toBeNull();
    expect(
      buildTradePlan({ direction: 'BEARISH', score: -60, ema25: 100, support: [90], resistance: [] }),
    ).toBeNull();
  });
});

describe('stopLoss', () => {
  it('无次近关键位时严格使用 1.5% 基础止损', () => {
    expect(stopLoss(100, undefined, 'LONG')).toBeCloseTo(98.5, 10);
    expect(stopLoss(100, undefined, 'SHORT')).toBeCloseTo(101.5, 10);
  });

  it('次近支撑超出上限时退回基础止损', () => {
    // 次近支撑 90，结构位 89.91 比 3% 上限（97）更远 => 必须退回 98.5
    expect(stopLoss(100, 90, 'LONG')).toBeCloseTo(98.5, 10);
  });

  it('次近支撑在上限内时采用结构位', () => {
    // next=98 在基础止损 98.5 之外（更宽），结构位 97.902 未超上限 97 => 采用结构位
    expect(stopLoss(100, 98, 'LONG')).toBeCloseTo(97.902, 10);
  });

  it('次近关键位比基础止损更近时不收紧止损', () => {
    // next=99 的结构位 98.901 高于基础止损 98.5（更紧），不应采用：规范只允许放宽，不允许收紧
    expect(stopLoss(100, 99, 'LONG')).toBeCloseTo(98.5, 10);
  });

  it('做空镜像', () => {
    expect(stopLoss(100, 110, 'SHORT')).toBeCloseTo(101.5, 10);
    expect(stopLoss(100, 102, 'SHORT')).toBeCloseTo(102.102, 10);
    expect(stopLoss(100, 101, 'SHORT')).toBeCloseTo(101.5, 10);
  });
});

describe('评分：RSI 极值使用弱权重', () => {
  it('EMA 多头 + OBV 流入 + RSI 超买时仍为 BULLISH', () => {
    // 修复前 RSI 权重为 −20 => 35 分 => RANGING（实盘 BTC 15m 即此情形）
    const t = compositeScore({
      emaStructure: 'BULLISH',
      macd: { dif: 0, dea: 0, hist: 0, signal: 'NO_SIGNAL', signalAge: null },
      rsiZone: 'OVERBOUGHT',
      obvFlow: 'INFLOW',
    });
    expect(t.score).toBe(30 - SCORE_RSI_WEIGHT + 25);
    expect(t.direction).toBe('BULLISH');
  });

  it('EMA 空头 + OBV 流出 + RSI 超卖时仍为 BEARISH', () => {
    const t = compositeScore({
      emaStructure: 'BEARISH',
      macd: { dif: 0, dea: 0, hist: 0, signal: 'NO_SIGNAL', signalAge: null },
      rsiZone: 'OVERSOLD',
      obvFlow: 'OUTFLOW',
    });
    expect(t.direction).toBe('BEARISH');
  });
});

describe('dropUnclosedCandle', () => {
  const mk = (times: number[]): CandleDto[] =>
    times.map((t) => ({ time: t, open: 1, high: 1, low: 1, close: 1, volume: 1 }));

  it('剔除尚未收盘的最后一根', () => {
    const now = 1_700_000_000 + 19; // 末根开盘后 19 秒
    const candles = mk([now - 900, now]);
    expect(dropUnclosedCandle(candles, 900, now)).toHaveLength(1);
  });

  it('已收盘的末根保留', () => {
    const now = 1_700_000_000 + 901;
    const candles = mk([now - 900, now - 900]);
    expect(dropUnclosedCandle(candles, 900, now)).toHaveLength(2);
  });

  it('只返回一根时不剔除，避免无数据可用', () => {
    const now = 1_700_000_000;
    expect(dropUnclosedCandle(mk([now]), 900, now)).toHaveLength(1);
  });
});

describe('supportResistance', () => {
  it('不使用"现价 ×0.8%"这类纯现价推导的合成位', () => {
    // 单调序列无局部极值 => 无 Pivot 候选，支撑阻力只能来自 EMA99 动态补充位
    const candles: CandleDto[] = [];
    let price = 100;
    for (let i = 0; i < 60; i++) {
      const open = price;
      const close = price + 1;
      candles.push({ time: 1_700_000_000 + i * 900, open, high: close, low: open, close, volume: 1000 });
      price = close;
    }
    const currentPrice = candles[candles.length - 1]!.close;
    // EMA99 故意远离现价，避免数值上巧合等于被禁用的推导值
    const ema99 = currentPrice * 0.9;
    const { support, resistance } = supportResistance(candles, ema99);

    const banned = [currentPrice * 1.008, currentPrice * 0.992];
    for (const p of [...support, ...resistance]) {
      for (const b of banned) {
        expect(Math.abs(p - b) / b).toBeGreaterThan(1e-6);
      }
    }

    // 补充位必须体现 EMA99：支撑 = EMA99 − 现价 × 0.8%
    expect(support).toHaveLength(1);
    expect(support[0]).toBeCloseTo(ema99 - currentPrice * 0.008, 6);
    // EMA99 + 现价 × 0.8% 仍在现价下方 => 不构成阻力，返回空数组而非造假
    expect(resistance).toHaveLength(0);
  });

  it('数组顺序契约：support 降序、resistance 升序（离现价最近优先）', () => {
    // 该顺序是 buildTradePlan 取 [0] 作最近位、[1] 作次近位，以及详情页关键价位取值的依据
    const snap = computeSnapshot(genCandles(200, 100, 0.2), '15m');
    const supDesc = snap.support.every((v, i, a) => i === 0 || a[i - 1]! >= v);
    const resAsc = snap.resistance.every((v, i, a) => i === 0 || a[i - 1]! <= v);
    expect(supDesc).toBe(true);
    expect(resAsc).toBe(true);
  });

  it('support[0] 必须比 support[1] 更接近现价', () => {
    const candles = genCandles(200, 100, 0.2);
    const snap = computeSnapshot(candles, '15m');
    const price = candles[candles.length - 1]!.close;
    if (snap.support.length >= 2) {
      expect(price - snap.support[0]!).toBeLessThanOrEqual(price - snap.support[1]!);
    }
    if (snap.resistance.length >= 2) {
      expect(snap.resistance[0]! - price).toBeLessThanOrEqual(snap.resistance[1]! - price);
    }
  });
});
