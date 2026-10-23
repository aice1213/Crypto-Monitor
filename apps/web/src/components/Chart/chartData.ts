import type { CandleDto, TradePlan, PatternSignal } from '@crypto-monitor/shared';
import type { SeriesMarker, Time } from 'lightweight-charts';
import { ema, macd, obv, rsi, sma } from '@crypto-monitor/indicators';

/**
 * K 线图的数据构造层（纯函数，可单测）。
 *
 * 从 `KlineChart.tsx` 抽出，原因有两个：
 * 1. **与指标引擎共用同一套实现**。原先图表自己重算了 MACD（DEA 的预热处理与引擎不同、
 *    且把预热期的 hist 画成 0），存在与详情页数值不一致的风险。这里一律复用
 *    `@crypto-monitor/indicators` 的 `ema / macd / rsi / obv / sma`。
 * 2. 图表代码无法单测，而"数组按时间对齐"正是图表最容易出错的地方。
 */

export interface LinePoint {
  time: number;
  value: number;
}

export interface HistPoint {
  time: number;
  value: number;
  color: string;
}

/** MACD 柱颜色（涨绿跌红，与卡片配色一致） */
const HIST_UP = '#26a69a';
const HIST_DOWN = '#ef5350';

/** 把引擎返回的、与 candles 等长的序列转成 lightweight-charts 的点集（丢弃 NaN） */
function toLinePoints(candles: CandleDto[], values: number[]): LinePoint[] {
  const points: LinePoint[] = [];
  for (let i = 0; i < candles.length; i++) {
    const v = values[i];
    if (v == null || Number.isNaN(v)) continue;
    points.push({ time: candles[i]!.time, value: v });
  }
  return points;
}

/** EMA 线 */
export function buildEmaSeries(candles: CandleDto[], period: number): LinePoint[] {
  if (candles.length === 0) return [];
  return toLinePoints(candles, ema(candles.map((c) => c.close), period));
}

/**
 * MACD 副图（柱 + DIF + DEA）。
 *
 * 引擎为保证 `hist = (dif − dea) × 2` 自洽，在 DEA 预热期令 `dea = dif`、`hist = 0`。
 * 那是给**数值消费方**用的；图上把这段画成一条贴着 0 的假柱会误导，
 * 因此这里显式跳过预热期：首个有效下标 = (slow − 1) + (signal − 1)。
 */
export function macdWarmupBars(slow = 26, signal = 9): number {
  return slow - 1 + signal - 1;
}

export function buildMacdPane(
  candles: CandleDto[],
  slow = 26,
  signal = 9,
): { hist: HistPoint[]; dif: LinePoint[]; dea: LinePoint[] } {
  if (candles.length === 0) return { hist: [], dif: [], dea: [] };

  const results = macd(
    candles.map((c) => c.high),
    candles.map((c) => c.low),
    candles.map((c) => c.close),
    12,
    slow,
    signal,
  );

  const start = macdWarmupBars(slow, signal);
  const hist: HistPoint[] = [];
  const dif: LinePoint[] = [];
  const dea: LinePoint[] = [];
  for (let i = start; i < candles.length; i++) {
    const r = results[i];
    if (!r) continue;
    const time = candles[i]!.time;
    hist.push({ time, value: r.hist, color: r.hist >= 0 ? HIST_UP : HIST_DOWN });
    dif.push({ time, value: r.dif });
    dea.push({ time, value: r.dea });
  }
  return { hist, dif, dea };
}

/** RSI 副图（dev.md 5.3：RSI 14） */
export function buildRsiSeries(candles: CandleDto[], period = 14): LinePoint[] {
  if (candles.length === 0) return [];
  return toLinePoints(candles, rsi(candles.map((c) => c.close), period));
}

/** OBV 副图（dev.md 5.3：OBV 线 + MA20） */
export function buildObvPane(candles: CandleDto[]): { obv: LinePoint[]; ma20: LinePoint[] } {
  if (candles.length === 0) return { obv: [], ma20: [] };

  const obvValues = obv(
    candles.map((c) => c.close),
    candles.map((c) => c.volume),
  ).map((o) => o.value);

  return {
    obv: toLinePoints(candles, obvValues),
    // 引擎的 ObvResult.ma20 在预热期会回退为 obv 自身，
    // 画在图上会被误认为"MA20 与 OBV 重合"，因此这里直接用同一套 sma 重新取，
    // 预热期保持 NaN 并被丢弃。
    ma20: toLinePoints(candles, sma(obvValues, 20)),
  };
}

export interface EntryBand {
  low: number;
  high: number;
  side: 'LONG' | 'SHORT';
  color: string;
}

/** 进场区（半透明矩形）：只来自规则引擎的 plan，绝不由前端估算 */
export function buildEntryBand(plan: TradePlan | null): EntryBand | null {
  if (!plan) return null;
  const low = Math.min(plan.entryLow, plan.entryHigh);
  const high = Math.max(plan.entryLow, plan.entryHigh);
  if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) return null;
  return {
    low,
    high,
    side: plan.side,
    // 做多绿、做空红，半透明
    color: plan.side === 'LONG' ? 'rgba(38, 166, 154, 0.18)' : 'rgba(239, 83, 80, 0.18)',
  };
}

/** 形态标记颜色 */
const PAT_MARKER = '#ab47bc';

/** 形态名称短标签 */
const PAT_LABEL: Record<string, string> = { PINBAR: 'P', INSIDE_BAR: 'IB', FAKEY: 'FK', ENGULFING: 'EG' };

/**
 * 将形态信号转换为 lightweight-charts 的 SeriesMarker 数组。
 *
 * - 看涨形态：箭头朝上，标记在蜡烛下方
 * - 看跌形态：箭头朝下，标记在蜡烛上方
 * - HIGH 质量：实心 + 形态标签 + 共振评分
 * - 按时间升序输出（lightweight-charts 要求）
 */
export function buildPatternMarkers(
  patterns: PatternSignal[],
  candles: CandleDto[],
): SeriesMarker<Time>[] {
  if (patterns.length === 0 || candles.length === 0) return [];

  return patterns
    .filter(p => p.index >= 0 && p.index < candles.length)
    .sort((a, b) => a.index - b.index)
    .map(p => {
      const candle = candles[p.index]!;
      const isBull = p.direction === 'BULLISH';
      const label = PAT_LABEL[p.type] ?? '?';
      const showScore = p.quality === 'HIGH' ? ` (${p.score}/3)` : '';
      const stratTag = p.strategy === 'BREAKOUT' ? '破' : p.retracementEntry != null ? '回' : '';
      const failTag = p.failed ? '✕' : '';
      const text = `${isBull ? '▲' : '▼'}${label}${stratTag}${failTag}${isBull ? '多' : '空'}${showScore}`;

      return {
        time: candle.time as Time,
        position: isBull ? 'belowBar' : 'aboveBar',
        color: p.failed ? '#ef5350' : PAT_MARKER,
        shape: isBull ? 'arrowUp' : 'arrowDown',
        id: `pat-${p.type}-${p.index}`,
        text,
      };
    });
}

export interface PlanLevel {
  price: number;
  title: string;
  color: string;
  lineStyle: number;
}

/**
 * 计划价位线：TP1 / TP2 / SL。
 * 只在引擎给出了 plan 时产出——`plan = null` 时不得凭空画线。
 */
export function buildPlanLevels(plan: TradePlan | null): PlanLevel[] {
  if (!plan) return [];
  const levels: PlanLevel[] = [
    { price: plan.tp1, title: `TP1 ${plan.side === 'LONG' ? '+' : '-'}`, color: '#26a69a', lineStyle: 2 },
  ];
  if (Number.isFinite(plan.tp2)) {
    levels.push({ price: plan.tp2, title: 'TP2', color: '#26a69a', lineStyle: 1 });
  }
  levels.push({ price: plan.sl, title: 'SL', color: '#ef5350', lineStyle: 0 });
  return levels.filter((l) => Number.isFinite(l.price));
}
