import type {
  CandleDto,
  PatternSignal,
  SwingStrategyDto,
} from '@crypto-monitor/shared';
import { atr } from './atr.js';

/**
 * 波段交易策略分类器
 *
 * 文档核心逻辑：
 *   1. 区间震荡 — 支撑位低买，阻力位高卖
 *   2. 顺势抓浪 — 上涨趋势回踩 EMA50 做多，下跌趋势反弹 EMA50 做空
 *   3. 逆势反转 — 假突破入场，紧凑止损，不宜持仓
 *
 * 文档原文：
 *   "价格回落至支撑区域，出现价格拒绝下跌的信号"
 *   "价格回踩 50 均线之后，买方进场推动价格上行"
 *   "止损放在高点外侧预留缓冲，目标抓取一轮下跌波段"
 */

/** EMA50 价值区间阈值（与 maStrategy.ts 保持一致） */
const EMA50_PROXIMITY = 0.015;

/** 支撑/阻力位接近阈值（价格的百分比） */
const LEVEL_PROXIMITY = 0.01;

/** 假突破检测：突破后的 K 线数量 */
const FAKEOUT_BARS = 3;

/** 置信度评分范围 */
const CONF_LOW = 20;
const CONF_MID = 50;
const CONF_HIGH = 75;
const CONF_MAX = 95;

/**
 * 分类波段交易策略。
 *
 * 输入：K 线、EMA50 序列、支撑/阻力位、形态信号。
 * 输出：SwingStrategyDto，包含 setup、方向、置信度、止损/止盈、解读。
 *
 * 优先级：逆势反转 > 顺势抓浪 > 区间震荡 > 无设置
 *   逆势反转最激进，但盈亏比最高，必须优先识别。
 */
export function classifySwingStrategy(
  candles: CandleDto[],
  ema50Arr: number[],
  support: number[],
  resistance: number[],
  patterns: PatternSignal[],
): SwingStrategyDto {
  const n = candles.length;
  const last = n > 0 ? candles[n - 1]! : null;

  // 数据不足
  if (!last || n < 30) {
    return {
      setup: 'NO_SETUP',
      direction: 'NEUTRAL',
      confidence: 0,
      stopLoss: null,
      takeProfit: null,
      reference: '',
      interpretation: '数据不足，波段策略暂不可用',
      riskNote: '',
    };
  }

  const price = last.close;
  const ema50 = ema50Arr[ema50Arr.length - 1] || 0;
  const atrValues = atr(
    candles.map((c) => c.high),
    candles.map((c) => c.low),
    candles.map((c) => c.close),
    14,
  );
  const atrVal = atrValues[atrValues.length - 1] || 0;

  /** 简单假突破检测：最近 N 根内价格突破后回到原区间 */
  function detectSimpleFakeout(
    candles: CandleDto[],
    level: number,
    above: boolean,
  ): boolean {
    const n = candles.length;
    if (n < FAKEOUT_BARS) return false;
    const start = n - FAKEOUT_BARS;
    let brokeOut = false;
    for (let i = start; i < n; i++) {
      if (above && candles[i]!.high > level) brokeOut = true;
      if (!above && candles[i]!.low < level) brokeOut = true;
    }
    const lastC = candles[n - 1]!;
    if (above) return brokeOut && lastC.close < level;
    return brokeOut && lastC.close > level;
  }

  const nearSupport = support.find(
    (s) => Math.abs(price - s) / s <= LEVEL_PROXIMITY,
  );
  const nearResistance = resistance.find(
    (r) => Math.abs(price - r) / r <= LEVEL_PROXIMITY,
  );
  const nearEma50 =
    ema50 > 0 && Math.abs(price - ema50) / ema50 <= EMA50_PROXIMITY;

  // 检查最近 K 线中的看涨/看跌形态
  const recentPatterns = patterns.filter((p) => p.index >= n - 5);
  const bullishPattern = recentPatterns.find((p) => p.direction === 'BULLISH');
  const bearishPattern = recentPatterns.find((p) => p.direction === 'BEARISH');

  // 检查最近 K 线的价格行为（影线方向）
  const recentCandles = candles.slice(-3);
  const lastBullishWick = recentCandles.some((c) => {
    const body = Math.abs(c.close - c.open);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    return lowerWick > body * 1.5 && c.close > c.open;
  });
  const lastBearishWick = recentCandles.some((c) => {
    const body = Math.abs(c.close - c.open);
    const upperWick = c.high - Math.max(c.open, c.close);
    return upperWick > body * 1.5 && c.close < c.open;
  });

  // ═══════════════════════════════════════════════════════
  // 1. 逆势反转（最高优先级 — 最激进，盈亏比最高）
  // ═══════════════════════════════════════════════════════

  // COUNTER_TREND_BEARISH: 价格在阻力位附近，假突破后做空
  // 文档："价格经过大幅上涨抵达波段高点、阻力位置时，就会出现逆势交易机会"
  // 逆势只认"假突破"（FAKEY 形态或价格突破后收回），不认单纯影线拒绝——
  // 影线/针形K线是"拒绝"信号，属于区间/顺势范畴，误判成逆势会放大风险。
  if (nearResistance) {
    const fakeoutPattern = recentPatterns.find(
      (p) => p.type === 'FAKEY' && p.direction === 'BEARISH',
    );
    const simpleFakeout = detectSimpleFakeout(candles, nearResistance, true);

    if (fakeoutPattern || simpleFakeout) {
      const confidence = fakeoutPattern ? CONF_MAX : CONF_HIGH;
      const sl = nearResistance + atrVal * 0.5; // 止损放在高点外侧
      const tp = price - atrVal * 2; // 目标：下方 2×ATR

      return {
        setup: 'COUNTER_TREND_BEARISH',
        direction: 'SHORT',
        confidence,
        stopLoss: sl,
        takeProfit: tp,
        reference: `阻力位 ${nearResistance.toFixed(4)}，假突破做空`,
        interpretation: `🔴 逆势做空：价格在阻力位 ${nearResistance.toFixed(4)} 附近出现${fakeoutPattern ? '假突破形态' : '突破后收回'}，追突破的交易者将被套，止损触发带来额外抛压`,
        riskNote: '逆势交易，持仓不宜过长。收线重新站上前高即离场，移动止损设紧凑。',
      };
    }
  }

  // COUNTER_TREND_BULLISH: 价格在支撑位附近，假突破后做多
  if (nearSupport) {
    const fakeoutPattern = recentPatterns.find(
      (p) => p.type === 'FAKEY' && p.direction === 'BULLISH',
    );
    const simpleFakeout = detectSimpleFakeout(candles, nearSupport, false);

    if (fakeoutPattern || simpleFakeout) {
      const confidence = fakeoutPattern ? CONF_MAX : CONF_HIGH;
      const sl = nearSupport - atrVal * 0.5; // 止损放在低点外侧
      const tp = price + atrVal * 2; // 目标：上方 2×ATR

      return {
        setup: 'COUNTER_TREND_BULLISH',
        direction: 'LONG',
        confidence,
        stopLoss: sl,
        takeProfit: tp,
        reference: `支撑位 ${nearSupport.toFixed(4)}，假突破做多`,
        interpretation: `🟢 逆势做多：价格在支撑位 ${nearSupport.toFixed(4)} 附近出现${fakeoutPattern ? '假突破形态' : '突破后收回'}，追突破的交易者将被套，止损触发带来额外买压`,
        riskNote: '逆势交易，持仓不宜过长。收线跌破前低即离场，移动止损设紧凑。',
      };
    }
  }

  // ═══════════════════════════════════════════════════════
  // 2. 顺势抓浪（中等优先级）
  // ═══════════════════════════════════════════════════════

  // TREND_PULLBACK_LONG: 价格在 EMA50 附近（从上方回踩），看涨信号
  // 文档："价格回踩 50 均线这个价值区域，观察 K 线信号"
  if (nearEma50 && price >= ema50) {
    const hasBullishSignal =
      bullishPattern || lastBullishWick || price > ema50 * 1.005;

    if (hasBullishSignal) {
      const confidence = bullishPattern ? CONF_HIGH : CONF_MID;
      const sl = ema50 - atrVal * 0.5;
      const tp = ema50 + atrVal * 2;

      return {
        setup: 'TREND_PULLBACK_LONG',
        direction: 'LONG',
        confidence,
        stopLoss: sl,
        takeProfit: tp,
        reference: `EMA50 价值区间 ${ema50.toFixed(4)}，回踩做多`,
        interpretation: `🟢 顺势做多：价格在 EMA50 ${ema50.toFixed(4)} 附近回踩确认，${bullishPattern ? '看涨形态出现' : '价格守住价值区间'}，顺势抓浪`,
        riskNote: '顺势交易止损容错空间更大。收盘跌破 EMA50 即离场。',
      };
    }
  }

  // TREND_PULLBACK_SHORT: 价格在 EMA50 附近（从下方反弹），看跌信号
  if (nearEma50 && price <= ema50) {
    const hasBearishSignal =
      bearishPattern || lastBearishWick || price < ema50 * 0.995;

    if (hasBearishSignal) {
      const confidence = bearishPattern ? CONF_HIGH : CONF_MID;
      const sl = ema50 + atrVal * 0.5;
      const tp = ema50 - atrVal * 2;

      return {
        setup: 'TREND_PULLBACK_SHORT',
        direction: 'SHORT',
        confidence,
        stopLoss: sl,
        takeProfit: tp,
        reference: `EMA50 价值区间 ${ema50.toFixed(4)}，反弹做空`,
        interpretation: `🟡 顺势做空：价格在 EMA50 ${ema50.toFixed(4)} 附近反弹受阻，${bearishPattern ? '看跌形态出现' : '价格无法突破价值区间'}，顺势抓浪`,
        riskNote: '顺势交易止损容错空间更大。收盘站回 EMA50 即离场。',
      };
    }
  }

  // ═══════════════════════════════════════════════════════
  // 3. 区间震荡（最低优先级）
  // ═══════════════════════════════════════════════════════

  // RANGE_LOW: 价格在支撑位附近，看涨信号
  if (nearSupport) {
    const hasBullishSignal = bullishPattern || lastBullishWick;

    if (hasBullishSignal) {
      const confidence = bullishPattern ? CONF_MID : CONF_LOW;
      const sl = nearSupport - atrVal * 0.5;
      const tp = nearResistance || price + atrVal * 2;

      return {
        setup: 'RANGE_LOW',
        direction: 'LONG',
        confidence,
        stopLoss: sl,
        takeProfit: tp,
        reference: `支撑位 ${nearSupport.toFixed(4)}，区间做多`,
        interpretation: `⚪ 区间震荡做多：价格在支撑位 ${nearSupport.toFixed(4)} 附近出现${bullishPattern ? '看涨形态' : '拒绝下跌信号'}，目标阻力位`,
        riskNote: '区间震荡低买高卖。首次反弹可能不达阻力位，注意分批止盈。',
      };
    }
  }

  // RANGE_HIGH: 价格在阻力位附近，看跌信号
  if (nearResistance) {
    const hasBearishSignal = bearishPattern || lastBearishWick;

    if (hasBearishSignal) {
      const confidence = bearishPattern ? CONF_MID : CONF_LOW;
      const sl = nearResistance + atrVal * 0.5;
      const tp = nearSupport || price - atrVal * 2;

      return {
        setup: 'RANGE_HIGH',
        direction: 'SHORT',
        confidence,
        stopLoss: sl,
        takeProfit: tp,
        reference: `阻力位 ${nearResistance.toFixed(4)}，区间做空`,
        interpretation: `⚪ 区间震荡做空：价格在阻力位 ${nearResistance.toFixed(4)} 附近出现${bearishPattern ? '看跌形态' : '拒绝上涨信号'}，目标支撑位`,
        riskNote: '区间震荡高抛低吸。首次回落可能不达支撑位，注意分批止盈。',
      };
    }
  }

  // ═══════════════════════════════════════════════════════
  // 4. 无明确设置
  // ═══════════════════════════════════════════════════════

  return {
    setup: 'NO_SETUP',
    direction: 'NEUTRAL',
    confidence: 0,
    stopLoss: null,
    takeProfit: null,
    reference: '',
    interpretation: '当前无明确波段设置，等待价格回到关键位或出现形态信号',
    riskNote: '',
  };
}
