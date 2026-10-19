import type { CandleDto, PatternContext, PatternSignal, PatternDirection, PatternQuality, PatternStrategy } from '@crypto-monitor/shared';
import { atr } from './atr.js';

/**
 * 价格行为形态检测（裸K交易形态）
 *
 * 三大形态：
 * 1. Pinbar（针形K线）— 长影线 = 价格被拒绝，单根K线形态
 * 2. Inside Bar（内包K线）— 当前K线高低完全落在前一根范围内，双K线形态
 * 3. Fakey（假突破）— 内包后假突破收回，三态状态机跨多根K线
 *
 * 所有阈值都用 ATR 归一化，避免不同币种/周期的噪声差异。
 * 信号只返回最近 windowBars 根内的，按时间倒序输出。
 */

/** 形态原始信号（共振评分前） */
type RawPattern = Omit<PatternSignal, 'quality' | 'score' | 'eventZoneId' | 'failed' | 'strategy' | 'breakoutLevel'> & {
  /** 形态突破参考价位上界（Pinbar=自身 high，InsideBar=母K high，Fakey=母K high） */
  rangeHigh: number;
  /** 形态突破参考价位下界 */
  rangeLow: number;
};

/**
 * 检测形态是否失效：
 * 看涨形态（Pinbar/InsideBar/Fakey 看涨）后，检查后续 N 根 K 线：
 *   - 跌破形态低点 → 看涨失效（failed=true）
 *   - 涨破形态高点 → 看涨确认（failed=false）
 * 看跌形态相反。
 *
 * 文档原文："失效的价格行为信号，本身就能成为非常强大的信号。"
 */
function checkPatternOutcome(
  signal: RawPattern,
  candles: CandleDto[],
): boolean {
  const checkBars = 3;
  const startIdx = signal.index + 1;
  const endIdx = Math.min(startIdx + checkBars, candles.length);

  if (startIdx >= candles.length) return false;

  // 找到形态 K 线的极值
  const patCandle = candles[signal.index]!;
  const patHigh = patCandle.high;
  const patLow = patCandle.low;

  for (let i = startIdx; i < endIdx; i++) {
    const c = candles[i]!;
    if (signal.direction === 'BULLISH') {
      // 看涨：跌破低点 = 失效
      if (c.close < patLow) return true;
      // 看涨确认：涨破高点 → 未失效
      if (c.close > patHigh) return false;
    } else {
      // 看跌：涨破高点 = 失效
      if (c.close > patHigh) return true;
      // 看跌确认：跌破低点 → 未失效
      if (c.close < patLow) return false;
    }
  }
  // 未突破 → 未失效
  return false;
}

/**
 * 事件区聚合：
 * 将形态信号按价格聚类（间距 < ATR 为同一事件区）。
 * 连续 2+ 信号来自同一区域 = 高概率事件区，共振质量提升。
 *
 * 文档原文："当多个成功的价格行为信号都源自同一片区域，就可能存在事件区。"
 */
function aggregateEventZones(
  signals: PatternSignal[],
  candles: CandleDto[],
  atrArr: number[],
): PatternSignal[] {
  if (signals.length === 0) return signals;

  const lastAtr = atrArr[atrArr.length - 1] || 0;
  if (lastAtr <= 0) return signals.map(s => ({ ...s, eventZoneId: null }));

  // 按价格排序（从低到高）
  const sorted = [...signals].sort((a, b) => {
    const pa = candles[a.index]!.close;
    const pb = candles[b.index]!.close;
    return pa - pb;
  });

  // 聚类：间距 < ATR 的归入同一事件区
  const clusters: PatternSignal[][] = [];
  let currentCluster: PatternSignal[] = [sorted[0]!];

  for (let i = 1; i < sorted.length; i++) {
    const prevPrice = candles[currentCluster[currentCluster.length - 1]!.index]!.close;
    const currPrice = candles[sorted[i]!.index]!.close;
    if (Math.abs(currPrice - prevPrice) < lastAtr) {
      currentCluster.push(sorted[i]!);
    } else {
      clusters.push(currentCluster);
      currentCluster = [sorted[i]!];
    }
  }
  clusters.push(currentCluster);

  // 为每个聚类分配 ID，≥2 个信号的标记为事件区
  const zoneIdMap = new Map<number, string | null>();
  let zoneCounter = 0;
  for (const cluster of clusters) {
    const id = `EZ-${zoneCounter}`;
    zoneCounter++;
    for (const sig of cluster) {
      zoneIdMap.set(sig.index, cluster.length >= 2 ? id : null);
    }
  }

  return signals.map(s => ({
    ...s,
    eventZoneId: zoneIdMap.get(s.index) ?? null,
  }));
}

/* ─── Pinbar ─── */

const PINBAR_WICK_RATIO = 2.0;    // 影线 >= 2× 实体
const PINBAR_ASYM_RATIO = 0.6;    // 对侧影线 <= 实体 × 0.6

function detectPinbarAt(
  candle: CandleDto,
  atrVal: number,
  index: number,
): RawPattern | null {
  const { open, high, low, close } = candle;
  const range = high - low;
  if (range === 0) return null;

  const body = Math.abs(close - open);
  const upperWick = high - Math.max(close, open);
  const lowerWick = Math.min(close, open) - low;

  let dir: PatternDirection | null = null;
  let longWick = 0;

  // 看涨：下影线长（价格被下方拒绝）
  if (lowerWick >= body * PINBAR_WICK_RATIO && upperWick <= body * PINBAR_ASYM_RATIO) {
    dir = 'BULLISH';
    longWick = lowerWick;
  }
  // 看跌：上影线长（价格被上方拒绝）
  if (upperWick >= body * PINBAR_WICK_RATIO && lowerWick <= body * PINBAR_ASYM_RATIO) {
    dir = 'BEARISH';
    longWick = upperWick;
  }

  if (!dir || longWick === 0 || atrVal === 0) return null;

  const strength = Math.min(longWick / atrVal, 1.0);
  return { type: 'PINBAR', direction: dir, strength, index, time: candle.time, rangeHigh: high, rangeLow: low };
}

/* ─── Inside Bar ─── */

function detectInsideBarAt(
  current: CandleDto,
  prev: CandleDto,
  index: number,
): RawPattern | null {
  // 内包定义：当前K线 highs/lows 完全在母K范围内
  const isInside = current.high <= prev.high && current.low >= prev.low;
  if (!isInside) return null;

  // 方向跟随母K
  const dir: PatternDirection = prev.close >= prev.open ? 'BULLISH' : 'BEARISH';

  // 强度：母K的实体/总振幅比 × 内包压缩系数
  const prevRange = prev.high - prev.low;
  const prevBody = Math.abs(prev.close - prev.open);
  const bodyRatio = prevRange > 0 ? prevBody / prevRange : 0;
  const compressRatio = prevRange > 0 ? 1 - ((current.high - current.low) / prevRange) : 0;

  const strength = Math.min(bodyRatio * (1 + compressRatio), 1.0);
  // 突破参考价 = 母K范围
  return { type: 'INSIDE_BAR', direction: dir, strength, index, time: current.time, rangeHigh: prev.high, rangeLow: prev.low };
}

/* ─── Fakey ─── */

/**
 * Fakey 三态状态机：
 *
 *   IDLE ──→ FOUND_INSIDE ──→ BROKEN ──→ (收回) → 确认 Fakey → IDLE
 *                 ↑                                    │
 *                 └── (超时 N 根无突破) ←──────────────┘
 *
 * - IDLE: 寻找内包
 * - FOUND_INSIDE: 已找到内包，等待突破（最多 FAKEY_MAX_WAIT 根）
 * - BROKEN: 突破发生，等待收回（最多 FAKEY_MAX_WAIT 根）
 */
const FAKEY_MAX_WAIT = 3;

type FakeyState = 'IDLE' | 'FOUND_INSIDE' | 'BROKEN';

function detectFakey(
  candles: CandleDto[],
  atrArr: number[],
): RawPattern[] {
  const signals: RawPattern[] = [];
  if (candles.length < 3) return signals;

  let state: FakeyState = 'IDLE';
  let parentHigh = 0;
  let parentLow = 0;
  let parentRange = 0;
  let stateSince = 0;
  let brokenDirection: PatternDirection | null = null;

  for (let i = 2; i < candles.length; i++) {
    const current = candles[i]!;

    switch (state) {
      case 'IDLE': {
        // 检查当前K线是否为内包（相对前一根）
        const prev = candles[i - 1]!;
        if (current.high <= prev.high && current.low >= prev.low) {
          // 当前是内包，母K = 前一根
          parentHigh = prev.high;
          parentLow = prev.low;
          parentRange = parentHigh - parentLow;
          state = 'FOUND_INSIDE';
          stateSince = i;
        }
        break;
      }

      case 'FOUND_INSIDE': {
        // 检查当前K线是否突破母K
        if (current.close > parentHigh) {
          state = 'BROKEN';
          brokenDirection = 'BULLISH';
          stateSince = i;
        } else if (current.close < parentLow) {
          state = 'BROKEN';
          brokenDirection = 'BEARISH';
          stateSince = i;
        } else if (i - stateSince > FAKEY_MAX_WAIT) {
          state = 'IDLE';
          brokenDirection = null;
        }
        break;
      }

      case 'BROKEN': {
        // 突破后收回 → Fakey 确认
        if (current.high <= parentHigh && current.low >= parentLow) {
          const dir: PatternDirection = brokenDirection === 'BULLISH' ? 'BEARISH' : 'BULLISH';
          const atrVal = atrArr[i] || 0;
          const strength = Math.min(parentRange / (atrVal || 1), 1.0);
          signals.push({ type: 'FAKEY', direction: dir, strength, index: i, time: current.time, rangeHigh: parentHigh, rangeLow: parentLow });
          state = 'IDLE';
          brokenDirection = null;
        } else if (i - stateSince > FAKEY_MAX_WAIT) {
          state = 'IDLE';
          brokenDirection = null;
        }
        break;
      }
    }
  }

  return signals;
}

/* ─── 策略分类 & 突破价位 ─── */

/**
 * 策略分类：
 * - REVERSAL：形态出现在关键位附近（3% 以内）→ 逆势反转，信号方向与趋势相反
 * - BREAKOUT：形态未出现在关键位附近 → 顺势突破，形态破位后价格延续
 *
 * 文档原文：
 *   "当市场已经形成清晰趋势，行情发生回调到关键价位时，等待价格行为反转信号"
 *   "突破策略一般配合挂单入场（条件限价单）使用"
 *
 * 判断依据：是否 near level（支撑/阻力 3% 以内）
 */
function classifyStrategy(
  candle: CandleDto,
  context: PatternContext,
): { strategy: PatternStrategy; breakoutLevel: number | null } {
  const price = candle.close;
  const nearSupport = context.support.some(s => Math.abs(price - s) / s <= 0.03);
  const nearResistance = context.resistance.some(r => Math.abs(price - r) / r <= 0.03);

  if (nearSupport || nearResistance) {
    // 关键位附近 → 反转策略（价格拒绝关键位后反向）
    return { strategy: 'REVERSAL', breakoutLevel: null };
  }

  // 非关键位 → 突破策略（形态破位后价格延续）
  // 但需要计算突破触发价位
  return { strategy: 'BREAKOUT', breakoutLevel: null };
}

/**
 * 计算突破触发价位（挂止损单的价位）：
 * - 看涨形态：突破参考价上界 + ATR 缓冲
 * - 看跌形态：突破参考价下界 - ATR 缓冲
 *
 * 文档原文："突破策略一般配合挂单入场（条件限价单）使用。
 *           在形态高点或低点附近放置买入止损单或卖出止损单。"
 */
function calcBreakoutLevel(
  signal: RawPattern,
  atrVal: number,
): number | null {
  if (atrVal <= 0) return null;
  const buffer = atrVal * 0.25; // 0.25×ATR 缓冲避免假突破

  if (signal.direction === 'BULLISH') {
    return signal.rangeHigh + buffer;
  } else {
    return signal.rangeLow - buffer;
  }
}

/* ─── 共振评分 ─── */

function scoreResonance(
  dir: PatternDirection,
  strength: number,
  candle: CandleDto,
  context: PatternContext,
): { score: number; quality: PatternQuality } {
  let score = 0;

  // 趋势一致
  if (dir === 'BULLISH' && context.trend === 'BULLISH') score++;
  if (dir === 'BEARISH' && context.trend === 'BEARISH') score++;

  // 关键位附近（3% 以内）
  const price = candle.close;
  const nearLevel = context.support.some((s: number) => Math.abs(price - s) / s <= 0.03) ||
                    context.resistance.some((r: number) => Math.abs(price - r) / r <= 0.03);
  if (nearLevel) score++;

  // 强度足够
  if (strength >= 0.5) score++;

  const quality: PatternQuality = score >= 3 ? 'HIGH' : score === 2 ? 'MEDIUM' : 'LOW';
  return { score, quality };
}

/* ─── 主函数 ─── */

export interface PatternScanOptions {
  maxSignals?: number;
  windowBars?: number;
}

/**
 * 扫描所有 K 线，返回最近的形态信号（时间倒序）。
 */
export function detectPatterns(
  candles: CandleDto[],
  context: PatternContext,
  options: PatternScanOptions = {},
): PatternSignal[] {
  const { maxSignals = 10, windowBars = 30 } = options;
  if (candles.length < 3) return [];

  const atrArr = atr(
    candles.map(c => c.high),
    candles.map(c => c.low),
    candles.map(c => c.close),
    14,
  );

  const rawSignals: RawPattern[] = [];

  for (let i = 1; i < candles.length; i++) {
    const candle = candles[i]!;
    const prev = candles[i - 1]!;
    const atrVal = atrArr[i] || 0;

    // Pinbar
    const pin = detectPinbarAt(candle, atrVal, i);
    if (pin) rawSignals.push(pin);

    // Inside Bar
    const inside = detectInsideBarAt(candle, prev, i);
    if (inside) rawSignals.push(inside);
  }

  // Fakey（状态机跨多根K线）
  for (const f of detectFakey(candles, atrArr)) {
    rawSignals.push(f);
  }

  // 去重（同一根K线可能出现多个形态，只保留最强的）
  const byIndex = new Map<number, RawPattern>();
  for (const s of rawSignals) {
    const existing = byIndex.get(s.index);
    if (!existing || s.strength > existing.strength) {
      byIndex.set(s.index, s);
    }
  }

  // 过滤窗口 + 共振评分 + 失效检测 + 策略分类 + 突破价位 + 排序 + 截断
  const startIdx = Math.max(0, candles.length - windowBars);
  const scored = [...byIndex.values()]
    .filter(s => s.index >= startIdx)
    .map((s): PatternSignal => {
      const candle = candles[s.index]!;
      const atrVal = atrArr[s.index] || 0;
      const { score, quality } = scoreResonance(s.direction, s.strength, candle, context);
      const failed = checkPatternOutcome(s, candles);
      const { strategy } = classifyStrategy(candle, context);
      const breakoutLevel = strategy === 'BREAKOUT' ? calcBreakoutLevel(s, atrVal) : null;
      return { ...s, quality, score, failed, strategy, breakoutLevel, eventZoneId: null };
    })
    .sort((a, b) => b.index - a.index)
    .slice(0, maxSignals);

  return aggregateEventZones(scored, candles, atrArr);
}