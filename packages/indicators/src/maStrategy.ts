import type { CandleDto, MaStrategyDto, MaSignalStatus } from '@crypto-monitor/shared';

/**
 * 均线交易策略分类器（EMA200 趋势过滤 + EMA50 价值区间回踩）
 *
 * 文档核心逻辑：
 *   1. 趋势过滤：价格 > EMA200 → 只做多；价格 < EMA200 → 只做空
 *   2. 价值区间：EMA50 作为回踩目标位
 *   3. 回踩计数：最近 N 根内价格触及 EMA50 的次数（≥2 次回踩确认价值区）
 *   4. 入场信号：回踩 + 价格拒绝 = READY
 *
 * 文档原文：
 *   "价格在200周期均线上方，只考虑做多"
 *   "50周期均线，可以很方便识别趋势里的波动"
 *   "等行情转向对你有利之后再进场"
 */

const RETEST_WINDOW = 30;       // 回踩计数窗口（根数）
const EMA50_PROXIMITY = 0.015;  // EMA50 价值区间阈值（1.5%）
const MIN_RETEST_COUNT = 2;     // 最少回踩次数确认价值区
const REJECTION_BARS = 3;       // 价格拒绝检测窗口（根数）

/**
 * 计算价格触及 EMA50 的回踩次数。
 *
 * 回踩定义：最近 N 根内，价格从 EMA50 上方跌到 EMA50 附近（1.5%以内），
 * 然后又回到 EMA50 上方。每次这样的来回计一次回踩。
 *
 * 文档原文："价格没有真正碰到50周期均线，但我依然算作第二次测试。
 *           我们看的是价值区间，不是一根死板的线。"
 */
function countRetests(
  candles: CandleDto[],
  ema50Arr: number[],
  windowBars: number,
): number {
  const n = candles.length;
  if (n < windowBars) return 0;

  const startIdx = Math.max(0, n - windowBars);
  let count = 0;
  let wasAbove = false;

  for (let i = startIdx; i < n; i++) {
    const close = candles[i]!.close;
    const ema50 = ema50Arr[i];
    if (!Number.isFinite(ema50) || ema50 <= 0) continue;

    const nearEma50 = Math.abs(close - ema50) / ema50 <= EMA50_PROXIMITY;
    const aboveEma50 = close > ema50;

    if (wasAbove && nearEma50) {
      count++;
      wasAbove = false;
    } else if (aboveEma50) {
      wasAbove = true;
    }
  }

  return count;
}

/**
 * 检测价格是否在 EMA50 附近出现拒绝信号（看涨锤子线/吞没等）。
 *
 * 文档原文："价格跌到这个支撑位，短暂下探之后被快速拉回，最终收在支撑上方。
 *           出现这种强烈的价格拒绝形态，这笔交易盈利概率会更高。"
 */
function hasRejectionSignal(
  candles: CandleDto[],
  ema50: number,
): boolean {
  const n = candles.length;
  if (n < REJECTION_BARS || !Number.isFinite(ema50) || ema50 <= 0) return false;

  // 检查最近 REJECTION_BARS 根 K 线
  const startIdx = n - REJECTION_BARS;
  let touchedEma50 = false;

  for (let i = startIdx; i < n; i++) {
    const c = candles[i]!;
    const nearEma50 = Math.abs(c.close - ema50) / ema50 <= EMA50_PROXIMITY;

    if (nearEma50) {
      touchedEma50 = true;
    }

    // 拒绝信号：K线从EMA50附近快速收回（长下影线 + 收盘 > 开盘）
    if (nearEma50) {
      const body = Math.abs(c.close - c.open);
      const lowerWick = Math.min(c.open, c.close) - c.low;
      const range = c.high - c.low;
      // 锤子线特征：下影线 > 实体×2 且 实体 < 总范围×40%
      if (lowerWick > body * 2 && body < range * 0.4 && c.close > c.open) {
        return true;
      }
    }
  }

  // 最终收盘价在 EMA50 上方（多头确认）
  const lastClose = candles[n - 1]!.close;
  return touchedEma50 && lastClose > ema50;
}

/**
 * 判断当前价格是否处于 EMA50 价值区间。
 */
function isNearEma50(close: number, ema50: number): boolean {
  if (!Number.isFinite(ema50) || ema50 <= 0) return false;
  return Math.abs(close - ema50) / ema50 <= EMA50_PROXIMITY;
}

/**
 * 分类均线交易策略。
 */
export function classifyMaStrategy(
  candles: CandleDto[],
  ema50Arr: number[],
  ema200Arr: number[],
): MaStrategyDto {
  const n = candles.length;
  const lastIdx = n - 1;
  const price = n > 0 ? candles[lastIdx]!.close : 0;
  const ema50 = ema50Arr[lastIdx];
  const ema200 = ema200Arr[lastIdx];

  // 数据不足
  if (n < 60 || !Number.isFinite(ema50) || !Number.isFinite(ema200) || ema200 <= 0) {
    return {
      trendFilter: 'NONE',
      retestCount: 0,
      nearEma50: false,
      signalStatus: 'AWAY',
      interpretation: '数据不足，均线策略暂不可用',
    };
  }

  // 1. 趋势过滤
  let trendFilter: MaStrategyDto['trendFilter'];
  if (price > ema200) {
    trendFilter = 'LONG_ONLY';
  } else if (price < ema200) {
    trendFilter = 'SHORT_ONLY';
  } else {
    trendFilter = 'NONE';
  }

  // 2. 回踩计数
  const retestCount = countRetests(candles, ema50Arr, RETEST_WINDOW);

  // 3. 是否处于价值区间
  const nearEma50 = isNearEma50(price, ema50);

  // 4. 信号状态
  let signalStatus: MaSignalStatus;
  let interpretation: string;

  if (trendFilter === 'NONE') {
    signalStatus = 'INVALID';
    interpretation = '价格在 EMA200 附近震荡，趋势方向不明确，观望';
  } else if (trendFilter === 'LONG_ONLY') {
    if (!nearEma50 && price > ema50) {
      signalStatus = 'AWAY';
      interpretation = '上升趋势中价格在 EMA50 上方运行，远离价值区间，不追高';
    } else if (!nearEma50 && price < ema50) {
      signalStatus = 'AWAY';
      interpretation = '价格跌破 EMA50 价值区间，趋势可能转弱，观望';
    } else {
      // 在 EMA50 附近
      if (retestCount >= MIN_RETEST_COUNT) {
        // 第3次回踩 → 价值区确认
        const hasRejection = hasRejectionSignal(candles, ema50);
        if (hasRejection) {
          signalStatus = 'READY';
          interpretation = `🟢 第${retestCount}次回踩 EMA50，价格拒绝确认，做多入场就绪`;
        } else {
          signalStatus = 'WAITING';
          interpretation = `🟡 第${retestCount}次回踩 EMA50，价值区确认，等待价格拒绝信号（锤子线/吞没）`;
        }
      } else {
        signalStatus = 'WAITING';
        interpretation = `🟡 第${retestCount}次回踩 EMA50，回踩次数不足${MIN_RETEST_COUNT}次，价值区未确认`;
      }
    }
  } else {
    // SHORT_ONLY（镜像逻辑）
    if (!nearEma50 && price < ema50) {
      signalStatus = 'AWAY';
      interpretation = '下降趋势中价格在 EMA50 下方运行，远离价值区间，不追空';
    } else if (!nearEma50 && price > ema50) {
      signalStatus = 'AWAY';
      interpretation = '价格涨破 EMA50 价值区间，趋势可能转强，观望';
    } else {
      if (retestCount >= MIN_RETEST_COUNT) {
        const hasRejection = hasRejectionSignal(candles, ema50);
        if (hasRejection) {
          signalStatus = 'READY';
          interpretation = `🟢 第${retestCount}次回踩 EMA50，价格拒绝确认，做空入场就绪`;
        } else {
          signalStatus = 'WAITING';
          interpretation = `🟡 第${retestCount}次回踩 EMA50，价值区确认，等待价格拒绝信号`;
        }
      } else {
        signalStatus = 'WAITING';
        interpretation = `🟡 第${retestCount}次回踩 EMA50，回踩次数不足${MIN_RETEST_COUNT}次，价值区未确认`;
      }
    }
  }

  return { trendFilter, retestCount, nearEma50, signalStatus, interpretation };
}
