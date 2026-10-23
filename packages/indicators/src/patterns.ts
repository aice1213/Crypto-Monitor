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
type RawPattern = Omit<PatternSignal, 'quality' | 'score' | 'eventZoneId' | 'failed' | 'strategy' | 'breakoutLevel' | 'retracementEntry'> & {
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

/* ─── Fake Breakout（关键位假突破）─── */

/**
 * 关键位假突破检测（文档"读懂假突破套路"陷阱3）：
 *
 * 价格向阻力突破后快速收回 → 假突破（BEARISH 信号）
 * 价格向支撑跌破后快速收回 → 假突破（BULLISH 信号）
 *
 * 核心逻辑：突破后没有加速延续（突破不加速、强势变滞涨），
 * 而是停滞震荡后回落，确认假突破后散户追突破的止损集中触发，
 * 顺势反向收割流动性。
 *
 * 检测条件：
 *   1. 当前 K 线收盘突破关键位（阻力向上突破 / 支撑向下跌破）
 *   2. 突破幅度 > 0.05×ATR（排除微小穿透）
 *   3. 后续 2~5 根 K 线内收盘价回到关键位内侧（突破失败确认）
 *   4. 假突破确认后，反向信号强度综合穿透深度、回落幅度和量能变化
 */
const FAKE_BO_LOOKBACK = 30;       // 回溯窗口
const FAKE_BO_MIN_PEN = 0.05;      // 最小穿透幅度（ATR）
const FAKE_BO_MIN_RETRACE = 0.1;   // 最小回挫幅度（ATR）
const FAKE_BO_MAX_CONFIRM = 5;     // 最大确认窗口（K线根数）

/**
 * 检测关键位假突破，返回假突破后反向确认的信号（BEARISH/BULLISH）。
 *
 * 信号方向与突破方向相反：
 *   向上突破阻力后失败 → BEARISH（顺势做空）
 *   向下突破支撑后失败 → BULLISH（顺势做多）
 */
function detectFakeBreakout(
  candles: CandleDto[],
  context: PatternContext,
  atrArr: number[],
): RawPattern[] {
  const signals: RawPattern[] = [];
  const n = candles.length;

  for (let i = n - 1; i >= Math.max(5, n - FAKE_BO_LOOKBACK); i--) {
    const c = candles[i]!;
    const atrVal = atrArr[i] || 0;
    if (atrVal <= 0) continue;

    // ── 测试 1：向上突破阻力 → 假突破失败 → BEARISH 信号 ──
    for (const level of context.resistance) {
      const penetration = c.close - level;
      if (penetration <= 0 || penetration <= atrVal * FAKE_BO_MIN_PEN) continue;

      // 检查后续 2~5 根是否收回（回挫到 level 下方）
      const endIdx = Math.min(i + 1 + FAKE_BO_MAX_CONFIRM, n);
      let confirmed = false;
      let confirmIdx = -1;
      let pullback = 0;

      for (let j = i + 1; j < endIdx; j++) {
        const cj = candles[j]!;
        if (cj.close <= level) {
          confirmed = true;
          confirmIdx = j;
          pullback = level - cj.close;
          break;
        }
      }
      if (!confirmed) continue;

      if (pullback < atrVal * FAKE_BO_MIN_RETRACE) continue;

      // 计算假突破事件的全程范围（突破K线到确认K线）
      let evHigh = -Infinity;
      let evLow = Infinity;
      for (let j = i; j <= confirmIdx; j++) {
        evHigh = Math.max(evHigh, candles[j]!.high);
        evLow = Math.min(evLow, candles[j]!.low);
      }

      const baseVol = avgVolume(candles, i, 5);
      const volR = baseVol > 0 ? c.volume / baseVol : 1;
      const strength = Math.min(
        Math.min(penetration / atrVal, 1) + Math.min(pullback / atrVal, 1) + Math.abs(volR - 1) * 0.3,
        1.0,
      );

      signals.push({
        type: 'FAKE_BREAKOUT',
        direction: 'BEARISH',
        strength,
        index: confirmIdx,
        time: candles[confirmIdx]!.time,
        rangeHigh: evHigh,
        rangeLow: evLow,
      });
      break;
    }

    // ── 测试 2：向下突破支撑 → 假突破失败 → BULLISH 信号 ──
    for (const level of context.support) {
      const penetration = level - c.close;
      if (penetration <= 0 || penetration <= atrVal * FAKE_BO_MIN_PEN) continue;

      const endIdx = Math.min(i + 1 + FAKE_BO_MAX_CONFIRM, n);
      let confirmed = false;
      let confirmIdx = -1;
      let pullback = 0;

      for (let j = i + 1; j < endIdx; j++) {
        const cj = candles[j]!;
        if (cj.close >= level) {
          confirmed = true;
          confirmIdx = j;
          pullback = cj.close - level;
          break;
        }
      }
      if (!confirmed) continue;

      if (pullback < atrVal * FAKE_BO_MIN_RETRACE) continue;

      let evHigh = -Infinity;
      let evLow = Infinity;
      for (let j = i; j <= confirmIdx; j++) {
        evHigh = Math.max(evHigh, candles[j]!.high);
        evLow = Math.min(evLow, candles[j]!.low);
      }

      const baseVol = avgVolume(candles, i, 5);
      const volR = baseVol > 0 ? c.volume / baseVol : 1;
      const strength = Math.min(
        Math.min(penetration / atrVal, 1) + Math.min(pullback / atrVal, 1) + Math.abs(volR - 1) * 0.3,
        1.0,
      );

      signals.push({
        type: 'FAKE_BREAKOUT',
        direction: 'BULLISH',
        strength,
        index: confirmIdx,
        time: candles[confirmIdx]!.time,
        rangeHigh: evHigh,
        rangeLow: evLow,
      });
      break;
    }
  }

  return signals;
}

/** 计算 index 之前 period 根 K 线的平均成交量 */
function avgVolume(candles: CandleDto[], beforeIdx: number, period: number): number {
  const start = Math.max(0, beforeIdx - period);
  if (start >= beforeIdx) return 0;
  let sum = 0;
  let cnt = 0;
  for (let k = start; k < beforeIdx; k++) {
    sum += candles[k]!.volume;
    cnt++;
  }
  return cnt > 0 ? sum / cnt : 0;
}

/* ─── Engulfing（看涨/看跌吞没）─── */

/**
 * 看涨吞没（Bullish Engulfing）：阳烛实体完全包裹前一根阴烛实体。
 * 文档原文："阳线实体完全包裹前一根K线，代表这个位置多头进攻动能很强。"
 *
 * 条件：
 *   - 前一根为阴烛（close < open）
 *   - 当前为阳烛（close > open）
 *   - 当前 open ≤ 前根 close（当前实体上沿覆盖前根实体下沿）
 *   - 当前 close ≥ 前根 open（当前实体下沿覆盖前根实体上沿）
 *
 * 看跌吞没（Bearish Engulfing）相反：前一根阳烛，当前阴烛完全包裹。
 *
 * 强度 = 当前K线实体 / ATR，与 Pinbar 的影线/ATR 对称。
 * 突破参考价 = 当前K线的 high/low（形态确认后的突破范围）。
 */
function detectEngulfingAt(
  current: CandleDto,
  prev: CandleDto,
  index: number,
  atrVal: number,
): RawPattern | null {
  const prevBody = Math.abs(prev.close - prev.open);
  const currBody = Math.abs(current.close - current.open);

  // 零实体跳过（十字星不构成吞没）
  if (prevBody === 0 || currBody === 0) return null;
  if (atrVal === 0) return null;

  const prevIsBearish = prev.close < prev.open;
  const currIsBullish = current.close > current.open;

  // 看涨吞没：前阴后阳，阳实体完全包裹前阴实体
  if (prevIsBearish && currIsBullish) {
    if (current.open <= prev.close && current.close >= prev.open) {
      const strength = Math.min(currBody / atrVal, 1.0);
      return {
        type: 'ENGULFING',
        direction: 'BULLISH',
        strength,
        index,
        time: current.time,
        rangeHigh: current.high,
        rangeLow: current.low,
      };
    }
  }

  // 看跌吞没：前阳后阴，阴实体完全包裹前阳实体
  const prevIsBullish = prev.close > prev.open;
  const currIsBearish = current.close < current.open;

  if (prevIsBullish && currIsBearish) {
    if (current.open >= prev.close && current.close <= prev.open) {
      const strength = Math.min(currBody / atrVal, 1.0);
      return {
        type: 'ENGULFING',
        direction: 'BEARISH',
        strength,
        index,
        time: current.time,
        rangeHigh: current.high,
        rangeLow: current.low,
      };
    }
  }

  return null;
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
): PatternStrategy {
  const price = candle.close;
  const nearSupport = context.support.some(s => Math.abs(price - s) / s <= 0.03);
  const nearResistance = context.resistance.some(r => Math.abs(price - r) / r <= 0.03);

  if (nearSupport || nearResistance) {
    // 关键位附近 → 反转策略（价格拒绝关键位后反向）
    return 'REVERSAL';
  }

  // 非关键位 → 突破策略（形态破位后价格延续）
  return 'BREAKOUT';
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

/**
 * 计算 50% 回调限价进场价（仅 REVERSAL 策略针形K线）：
 * - 看涨：rangeLow + (rangeHigh - rangeLow) × 0.5
 * - 看跌：rangeHigh - (rangeHigh - rangeLow) × 0.5
 *
 * 文档原文："进场价 = 针形K线低点 + (针形K线高点 - 针形K线低点) × 0.5"
 * "如果价格直接离开，不追；如果重新回到50%位置，说明市场愿意给更优成本。"
 */
function calcRetracementEntry(signal: RawPattern): number | null {
  const range = signal.rangeHigh - signal.rangeLow;
  if (range <= 0) return null;
  return signal.rangeLow + range * 0.5;
}

/* ─── 共振评分 ─── */

/**
 * 检查价格是否在某个关键位附近（3% 以内）
 */
function nearLevel(price: number, levels: number[]): boolean {
  return levels.some((l) => Math.abs(price - l) / Math.max(Math.abs(price), Math.abs(l)) <= 0.03);
}

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

  // 关键位检查（文档规则2：至少满足 2 个条件）
  // 条件1: 价格回调至 EMA50
  const price = candle.close;
  const nearEma50 = context.ema50 != null && context.ema50 > 0 && nearLevel(price, [context.ema50]);
  // 条件2: 价格回调至支撑/阻力位（pivot 高低点）
  const nearSRL = (context.support.length > 0 && nearLevel(price, context.support)) ||
                   (context.resistance.length > 0 && nearLevel(price, context.resistance));
  // 条件3: 价格回调至 Fibonacci 黄金分割位
  const nearFib = context.fibLevels && context.fibLevels.length > 0 && nearLevel(price, context.fibLevels);

  const keyLevelCount = (nearEma50 ? 1 : 0) + (nearSRL ? 1 : 0) + (nearFib ? 1 : 0);
  if (keyLevelCount >= 2) score += 2;
  // 1 个条件不算"合格关键位"（文档规则2：至少满足2个条件），不给加分

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

    // Engulfing（看涨/看跌吞没）
    const engulf = detectEngulfingAt(candle, prev, i, atrVal);
    if (engulf) rawSignals.push(engulf);
  }

  // Fakey（状态机跨多根K线）
  for (const f of detectFakey(candles, atrArr)) {
    rawSignals.push(f);
  }

  // Fake Breakout（关键位假突破，需要支持/阻力上下文）
  if (context.support.length > 0 || context.resistance.length > 0) {
    for (const f of detectFakeBreakout(candles, context, atrArr)) {
      rawSignals.push(f);
    }
  }

  // 吞没 + 长引线组合增强（文档规则3：吞没是核心信号，长引线是加分项，两者共振="强强联合"）
  // 当 ENGULFING 和 PINBAR 在同一根 K 线上出现且方向一致时：
  // 1. 提升 ENGULFING 强度 ×1.3（动能彻底反转 + 动能衰竭 = 更强信号）
  // 2. 移除同位置的 PINBAR（ENGULFING 是核心信号，按文档优先级保留）
  {
    const pinbarMap = new Map<number, PatternDirection>();
    for (const s of rawSignals) {
      if (s.type === 'PINBAR') pinbarMap.set(s.index, s.direction);
    }
    const removePinbar = new Set<number>();
    for (let k = 0; k < rawSignals.length; k++) {
      const s = rawSignals[k]!;
      if (s.type === 'ENGULFING') {
        const pinDir = pinbarMap.get(s.index);
        if (pinDir === s.direction) {
          rawSignals[k] = { ...s, strength: Math.min(s.strength * 1.3, 1.0) };
          removePinbar.add(s.index);
        }
      }
    }
    for (let k = rawSignals.length - 1; k >= 0; k--) {
      const s = rawSignals[k]!;
      if (s.type === 'PINBAR' && removePinbar.has(s.index)) {
        rawSignals.splice(k, 1);
      }
    }
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
      const strategy = classifyStrategy(candle, context);
      const breakoutLevel = strategy === 'BREAKOUT' ? calcBreakoutLevel(s, atrVal) : null;
      // 50% 回调限价进场价：仅 REVERSAL 策略的针形K线适用
      const retracementEntry = strategy === 'REVERSAL' && s.type === 'PINBAR' ? calcRetracementEntry(s) : null;
      return { ...s, quality, score, failed, strategy, breakoutLevel, retracementEntry, eventZoneId: null };
    })
    .sort((a, b) => b.index - a.index)
    .slice(0, maxSignals);

  return aggregateEventZones(scored, candles, atrArr);
}