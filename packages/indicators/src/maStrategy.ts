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
 * 计算价格在 EMA50 附近完成"来回"的次数。
 *
 * 完整回踩 = 触及 EMA50 + 回到原位（被价值区承接）
 *   - 上方回踩：价格从 EMA50 上方跌到 EMA50 附近 → 又回到上方（多头价值区承接）
 *   - 下方反弹：价格从 EMA50 下方涨到 EMA50 附近 → 又回到下方（空头价值区承接）
 *
 * 为什么要"来回"才计数？
 *   文档原文："价格没有真正碰到50周期均线，但我依然算作第二次测试。
 *             我们看的是价值区间，不是一根死板的线。"
 *   价值区的意义在于"价格到这里会被接住"，只触不回说明没被承接，不算真正的回踩测试。
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
  // 状态机：ABOVE=在EMA50上方远离  BELOW=在EMA50下方远离
  //        NEAR_ABOVE=从上方进入接近EMA50  NEAR_BELOW=从下方进入接近EMA50
  type State = 'ABOVE' | 'BELOW' | 'NEAR_ABOVE' | 'NEAR_BELOW';
  let state: State = 'ABOVE';

  for (let i = startIdx; i < n; i++) {
    const close = candles[i]!.close;
    const ema50 = ema50Arr[i];
    if (!Number.isFinite(ema50) || ema50 <= 0) continue;

    const nearEma50 = Math.abs(close - ema50) / ema50 <= EMA50_PROXIMITY;
    const aboveEma50 = close > ema50;

    switch (state) {
      case 'ABOVE': {
        if (nearEma50) {
          // 从上方首次进入 EMA50 附近 → 开始一次回踩测试
          state = 'NEAR_ABOVE';
        } else if (!aboveEma50) {
          // 从上方直接跌到 EMA50 下方（跳空/长阴线）→ 切换到下方
          state = 'BELOW';
        }
        break;
      }
      case 'BELOW': {
        if (nearEma50) {
          // 从下方首次进入 EMA50 附近 → 开始一次反弹测试
          state = 'NEAR_BELOW';
        } else if (aboveEma50) {
          // 从下方直接跳到上方 → 切换
          state = 'ABOVE';
        }
        break;
      }
      case 'NEAR_ABOVE': {
        // 已在 EMA50 附近（来自上方）
        if (aboveEma50 && !nearEma50) {
          // 确认回到上方且远离 EMA50 → 完成一次回踩！
          count++;
          state = 'ABOVE';
        } else if (!aboveEma50 && !nearEma50) {
          // 跌破 EMA50 且远离 → 回踩失败（没被承接），切换到下方
          state = 'BELOW';
        }
        // 仍然在 nearEma50 范围内 → 继续等待，不计数
        break;
      }
      case 'NEAR_BELOW': {
        // 已在 EMA50 附近（来自下方）
        if (!aboveEma50 && !nearEma50) {
          // 确认回到下方且远离 EMA50 → 完成一次反弹回踩！
          count++;
          state = 'BELOW';
        } else if (aboveEma50 && !nearEma50) {
          // 涨破 EMA50 且远离 → 反弹失败，切换到上方
          state = 'ABOVE';
        }
        break;
      }
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
