import type { CandleDto, EmaStructure, MarketStateDto } from '@crypto-monitor/shared';
import { atr } from './atr.js';

/**
 * 市场状态分类器
 *
 * 基于文档："你在图表上需要学会听懂的第一条重要讯息，就是市场是否处于趋势中。"
 * 四种状态：
 *   TREND_UP      — EMA 多头排列 + 价格向上发散，最轻松的赚钱方式
 *   TREND_DOWN    — EMA 空头排列 + 价格向下发散
 *   WIDE_RANGE    — 均线纠缠 + 价格区间宽（> 3×ATR），区间交易有利
 *   NARROW_RANGE  — 均线纠缠 + 价格区间窄（< 1.5×ATR），杂波过多，不宜交易
 */

/** EMA 发散度阈值：7/25/99 极差 / 价格 > 此值视为趋势成立 */
const EMA_SPREAD_THRESHOLD = 0.01; // 1%

/** 趋势中价格偏离 EMA25 的最小比例 */
const PRICE_VS_EMA_THRESHOLD = 0.002; // 0.2%

/** 宽幅震荡：20 根区间宽度 / ATR > 此值 */
const WIDE_RANGE_ATR_MULT = 3.0;

/** 窄幅震荡：20 根区间宽度 / ATR < 此值 */
const NARROW_RANGE_ATR_MULT = 1.5;

export function classifyMarketState(
  candles: CandleDto[],
  ema7: number,
  ema25: number,
  ema99: number,
  emaStructure: EmaStructure,
): MarketStateDto {
  if (candles.length < 20) {
    return { state: 'NARROW_RANGE', interpretation: '数据不足，暂无法判断' };
  }

  const currentPrice = candles[candles.length - 1]!.close;
  if (currentPrice <= 0) {
    return { state: 'NARROW_RANGE', interpretation: '价格数据异常' };
  }

  // 计算最近 20 根 K 线的区间宽度
  const recent = candles.slice(-20);
  const rangeHigh = Math.max(...recent.map(c => c.high));
  const rangeLow = Math.min(...recent.map(c => c.low));
  const rangeWidth = rangeHigh - rangeLow;
  const rangePct = rangeWidth / currentPrice;

  // 计算当前 ATR%
  const atrValues = atr(
    candles.map(c => c.high),
    candles.map(c => c.low),
    candles.map(c => c.close),
    14,
  );
  const currentAtr = atrValues[atrValues.length - 1] || 0;
  const atrPct = currentAtr / currentPrice;

  // EMA 发散度
  const emaSpread = (Math.max(ema7, ema25, ema99) - Math.min(ema7, ema25, ema99)) / currentPrice;

  // 价格相对 EMA25 的位置
  const priceVsEma = (currentPrice - ema25) / ema25;

  // ── 趋势判断 ──
  if (emaStructure === 'BULLISH' && emaSpread > EMA_SPREAD_THRESHOLD && priceVsEma > PRICE_VS_EMA_THRESHOLD) {
    return {
      state: 'TREND_UP',
      interpretation: `均线多头排列（发散 ${(emaSpread * 100).toFixed(1)}%），顺势做多是最轻松的赚钱方式`,
    };
  }

  if (emaStructure === 'BEARISH' && emaSpread > EMA_SPREAD_THRESHOLD && priceVsEma < -PRICE_VS_EMA_THRESHOLD) {
    return {
      state: 'TREND_DOWN',
      interpretation: `均线空头排列（发散 ${(emaSpread * 100).toFixed(1)}%），顺势做空`,
    };
  }

  // ── 震荡判断 ──
  if (atrPct > 0 && rangeWidth / currentAtr > WIDE_RANGE_ATR_MULT) {
    return {
      state: 'WIDE_RANGE',
      interpretation: `宽幅震荡（区间 ${(rangePct * 100).toFixed(1)}% ≈ ${(rangeWidth / currentAtr).toFixed(1)}×ATR），区间交易有利，高抛低吸`,
    };
  }

  if (atrPct > 0 && rangeWidth / currentAtr < NARROW_RANGE_ATR_MULT) {
    return {
      state: 'NARROW_RANGE',
      interpretation: `窄幅随机（区间 ${(rangePct * 100).toFixed(1)}% ≈ ${(rangeWidth / currentAtr).toFixed(1)}×ATR），杂波过多，不宜交易`,
    };
  }

  // 边界情况：区间宽度适中
  return {
    state: 'WIDE_RANGE',
    interpretation: `均线纠缠（发散 ${(emaSpread * 100).toFixed(1)}%），区间震荡（${(rangePct * 100).toFixed(1)}%），等待突破或回踩信号`,
  };
}
