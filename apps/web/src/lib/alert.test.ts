import { describe, it, expect } from 'vitest';
import type { IndicatorSnapshotDto, CandleDto } from '@crypto-monitor/shared';
import { buildAlert, hasAlert } from './alert';
import { rsiLine, sentimentLine, tfLine, volumePriceLine } from './cardText';

/** 构造一个最小可用的指标快照 */
function snapshot(over: Partial<IndicatorSnapshotDto> = {}): IndicatorSnapshotDto {
  return {
    ema7: 100,
    ema25: 99,
    ema50: 97,
    ema99: 95,
    ema200: 90,
    emaStructure: 'BULLISH',
    rsi14: 55,
    rsiZone: 'NEUTRAL',
    macd: { dif: 1, dea: 0.5, hist: 1, signal: 'NO_SIGNAL', signalAge: null },
    obv: { value: 1, ma20: 1, flow: 'BALANCED', volumeRatio: 1, volumeAvg20ChangePct: 0 },
    trend: { score: 55, direction: 'BULLISH' },
    support: [98],
    resistance: [102],
    patterns: [],
    marketState: { state: 'NARROW_RANGE', interpretation: '区间收窄，等待方向选择' },
    maStrategy: { trendFilter: 'LONG_ONLY', retestCount: 0, nearEma50: false, signalStatus: 'AWAY', interpretation: '上升趋势中价格在 EMA50 上方运行，远离价值区间，不追高' },
    plan: null,
    dataQuality: 'FULL',
    ...over,
  };
}

/** 生成一段无背离的已收盘 K 线，避免 candles15m 影响其他断言 */
function flatCandles(n = 30): CandleDto[] {
  return Array.from({ length: n }, (_, i) => ({
    time: 1_700_000_000 + i * 900,
    open: 100,
    high: 100,
    low: 100,
    close: 100,
    volume: 1000,
  }));
}

describe('sentimentLine 与预警徽标同源（审查项 F7）', () => {
  const rates = [0.00005, 0.0001, 0.0006, -0.0006, 0.001, -0.001];
  const ratios = [0.3, 0.45, 0.49, 0.5, 0.6, 0.8, 1.0, 1.5, 1.6, 1.9, 2.0, 2.1, 2.3, 3];

  it('情绪行挂 ⚠ 当且仅当 fundingSignal !== NEUTRAL', () => {
    for (const rate of rates) {
      for (const ratio of ratios) {
        const alert = buildAlert({
          snapshot15m: snapshot(),
          candles15m: flatCandles(),
          funding: { symbol: 'BTC_USDT', fundingRate: rate, ts: 0 },
          stats: { symbol: 'BTC_USDT', longShortRatio: ratio, ts: 0 },
        });
        const line = sentimentLine(alert.fundingSignal, rate, ratio);
        expect(
          line.tone === 'warn',
          `rate=${rate} ratio=${ratio} signal=${alert.fundingSignal} text=${line.text}`,
        ).toBe(alert.fundingSignal !== 'NEUTRAL');
      }
    }
  });

  it('原先的不一致样本（ratio 1.6 / 0.7）不再产生行内 ⚠', () => {
    // 修复前 sentimentLine 在 ratio>=1.5 与 <=0.8 时就返回 warn，
    // 而 hasAlert 的拥挤阈值是 >2 / <0.5，于是出现"行内 ⚠ 但徽标=平稳"
    const a = buildAlert({
      snapshot15m: snapshot(),
      candles15m: flatCandles(),
      funding: { symbol: 'BTC_USDT', fundingRate: 0.0001, ts: 0 },
      stats: { symbol: 'BTC_USDT', longShortRatio: 1.6, ts: 0 },
    });
    expect(hasAlert(a)).toBe(false);
    expect(sentimentLine(a.fundingSignal, 0.0001, 1.6).tone).toBe('neutral');

    const b = buildAlert({
      snapshot15m: snapshot(),
      candles15m: flatCandles(),
      funding: { symbol: 'BTC_USDT', fundingRate: 0.0001, ts: 0 },
      stats: { symbol: 'BTC_USDT', longShortRatio: 0.7, ts: 0 },
    });
    expect(hasAlert(b)).toBe(false);
    expect(sentimentLine(b.fundingSignal, 0.0001, 0.7).tone).toBe('neutral');
  });

  it('拥挤方向与多空比一致', () => {
    expect(sentimentLine('LONG_HEAVY', 0.001, 3).text).toContain('多头拥挤');
    expect(sentimentLine('SHORT_HEAVY', -0.001, 0.3).text).toContain('空头拥挤');
  });
});

describe('volumePriceLine（审查项 F6）', () => {
  it('无背离时永远不挂警示，且文案含"量价正常"', () => {
    for (const vr of [0, 0.01, 0.3, 0.5, 0.7, 0.8, 1.0, 1.2, 1.5, 3]) {
      for (const chg of [-0.05, 0, 0.05]) {
        const line = volumePriceLine('NONE', vr, chg);
        expect(line.tone, `vr=${vr}`).toBe('neutral');
        expect(line.text).toContain('量价正常');
      }
    }
  });

  it('只有真实背离才挂警示', () => {
    expect(volumePriceLine('BEARISH_DIVERGENCE', 1, 0).tone).toBe('warn');
    expect(volumePriceLine('BULLISH_DIVERGENCE', 1, 0).tone).toBe('warn');
  });

  it('涨跌方向取自价格涨跌幅，而不是成交量变化率', () => {
    // 价格 +1.09% 上涨，量比偏低 —— 修复前会因传入成交量变化率(-99.5%)而显示"下行"
    expect(volumePriceLine('NONE', 0.02, 0.0109).text).toContain('上涨');
    expect(volumePriceLine('NONE', 0.02, -0.0109).text).toContain('下跌');
  });
});

describe('rsiLine（审查项 F21）', () => {
  it('超买红、超卖绿、中性灰', () => {
    expect(rsiLine(75).tone).toBe('danger');
    expect(rsiLine(25).tone).toBe('good');
    expect(rsiLine(50).tone).toBe('neutral');
  });

  it('边界与引擎 rsiZone 一致（闭区间）', () => {
    expect(rsiLine(70).text).toContain('超买');
    expect(rsiLine(30).text).toContain('超卖');
    expect(rsiLine(69.9).text).toContain('中性');
  });
});

describe('tfLine', () => {
  it('五种多周期状态都有文案', () => {
    expect(tfLine('BULL_ALIGN', false).text).toContain('向上');
    expect(tfLine('BEAR_ALIGN', false).text).toContain('向下');
    expect(tfLine('RANGE_ALIGN', false).text).toContain('横盘');
    expect(tfLine('CONFLICT', false).tone).toBe('warn');
    expect(tfLine('INSUFFICIENT', false).tone).toBe('neutral');
  });
});

describe('buildAlert', () => {
  it('拥挤判定：|费率|>0.05% 或 多空比>2 / <0.5', () => {
    const mk = (rate: number, ratio: number) =>
      buildAlert({
        snapshot15m: snapshot(),
        candles15m: flatCandles(),
        funding: { symbol: 'S', fundingRate: rate, ts: 0 },
        stats: { symbol: 'S', longShortRatio: ratio, ts: 0 },
      });
    expect(mk(0.0001, 1).fundingSignal).toBe('NEUTRAL');
    expect(mk(0.0006, 1).fundingSignal).toBe('LONG_HEAVY');
    expect(mk(-0.0006, 1).fundingSignal).toBe('SHORT_HEAVY');
    expect(mk(0.0001, 2.5).fundingSignal).toBe('LONG_HEAVY');
    expect(mk(0.0001, 0.3).fundingSignal).toBe('SHORT_HEAVY');
  });

  it('funding/stats 缺失时按中性处理，不误报拥挤', () => {
    const a = buildAlert({ snapshot15m: snapshot(), candles15m: flatCandles() });
    expect(a.fundingSignal).toBe('NEUTRAL');
    expect(a.longShortRatio).toBe(1);
    expect(hasAlert(a)).toBe(false);
  });

  it('1h 快照缺失时 multiTfState 为 INSUFFICIENT 且不判冲突', () => {
    const a = buildAlert({ snapshot15m: snapshot(), candles15m: flatCandles() });
    expect(a.multiTfState).toBe('INSUFFICIENT');
    expect(a.multiTfConflict).toBe(false);
  });

  it('15m 与 1h 方向相反时判冲突', () => {
    const a = buildAlert({
      snapshot15m: snapshot({ trend: { score: 60, direction: 'BULLISH' } }),
      candles15m: flatCandles(),
      snapshot1h: snapshot({ trend: { score: -60, direction: 'BEARISH' } }),
    });
    expect(a.multiTfConflict).toBe(true);
    expect(a.multiTfState).toBe('CONFLICT');
  });

  it('任一方为 RANGING 时不判冲突（震荡不算方向冲突）', () => {
    const a = buildAlert({
      snapshot15m: snapshot({ trend: { score: 0, direction: 'RANGING' } }),
      candles15m: flatCandles(),
      snapshot1h: snapshot({ trend: { score: -60, direction: 'BEARISH' } }),
    });
    expect(a.multiTfConflict).toBe(false);
    expect(a.multiTfState).toBe('CONFLICT');
  });

  it('extremeAlert 与引擎 rsiZone 边界一致', () => {
    const mk = (rsi: number) =>
      buildAlert({ snapshot15m: snapshot({ rsi14: rsi, rsiZone: rsi >= 70 ? 'OVERBOUGHT' : rsi <= 30 ? 'OVERSOLD' : 'NEUTRAL' }), candles15m: flatCandles() }).extremeAlert;
    expect(mk(70)).toBe('OVERBOUGHT');
    expect(mk(69.9)).toBeNull();
    expect(mk(30)).toBe('OVERSOLD');
    expect(mk(30.1)).toBeNull();
  });

  it('dataQuality 取 15m 快照', () => {
    const a = buildAlert({ snapshot15m: snapshot({ dataQuality: 'GAPS_FILLED' }), candles15m: flatCandles() });
    expect(a.dataQuality).toBe('GAPS_FILLED');
  });

  it('量价背离按"价格创新高/新低而 OBV 未同步"判定（审查项 F8）', () => {
    // 价格持续走高但成交量逐步萎缩 => 顶背离
    const candles: CandleDto[] = Array.from({ length: 20 }, (_, i) => ({
      time: 1_700_000_000 + i * 900,
      open: 100 + i,
      high: 101 + i,
      low: 99 + i,
      close: 100 + i,
      volume: 10_000 - i * 400,
    }));
    const a = buildAlert({ snapshot15m: snapshot(), candles15m: candles });
    expect(a.volumePriceDivergence).toBe('BEARISH_DIVERGENCE');
  });

  it('未传 candles15m 时不猜测背离（退化为 NONE）', () => {
    const a = buildAlert({ snapshot15m: snapshot({ rsi14: 90, rsiZone: 'OVERBOUGHT' }) });
    // 修复前会用"RSI 极端 + OBV 流向"自创规则，此处应保持 NONE
    expect(a.volumePriceDivergence).toBe('NONE');
  });
});

describe('hasAlert', () => {
  it('四类警示任一命中即为 true', () => {
    const base = buildAlert({ snapshot15m: snapshot(), candles15m: flatCandles() });
    expect(hasAlert(base)).toBe(false);
    expect(hasAlert({ ...base, extremeAlert: 'OVERBOUGHT' })).toBe(true);
    expect(hasAlert({ ...base, multiTfConflict: true })).toBe(true);
    expect(hasAlert({ ...base, volumePriceDivergence: 'BEARISH_DIVERGENCE' })).toBe(true);
    expect(hasAlert({ ...base, fundingSignal: 'LONG_HEAVY' })).toBe(true);
  });
});
