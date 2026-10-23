import type {
  MacdAdvancedDto,
  MacdMomentumLevel,
  MacdSeparation,
  MacdAdvancedSignal,
} from '@crypto-monitor/shared';
import type { MacdResult } from '@crypto-monitor/shared';

/**
 * MACD 高阶分析：柱体动能强度 + 收缩 + 快线-柱体分离
 *
 * 源自《MACD高阶实战心法》核心策略：
 * - MACD 本质是统计均线距离的动能指标，金叉死叉仅仅代表动能衰减，不代表趋势反转
 * - 实战核心信号：大柱体 + 柱体收缩 + 快线与柱体形成分离
 * - 零轴上方红柱缩量 + DIF 下行 = 做空信号
 * - 零轴下方绿柱缩量 + DIF 上行 = 做多信号
 *
 * @param macdArr - 完整 MACD 数组（至少需要 CONTRACT_BARS+1 根）
 * @param atrArr - ATR(14) 数组，用于归一化柱体强度
 */
export function analyzeMacdAdvanced(
  macdArr: MacdResult[],
  atrArr: number[],
): MacdAdvancedDto {
  const n = macdArr.length;

  // 数据不足
  if (n < CONTRACT_BARS + 1) {
    return emptyResult('数据不足，MACD 高阶分析需至少 5 根 K 线');
  }

  const last = macdArr[n - 1];
  const atrVal = atrArr[n - 1] ?? 0;
  const atrSafe = Number.isFinite(atrVal) && atrVal > 0 ? atrVal : 1;
  const histNorm = Math.abs(last.hist) / atrSafe;

  // 1. 柱体动能强度
  const momentum = classifyMomentum(histNorm);

  // 2. 零轴位置
  const zeroAxisPos = classifyZeroAxis(last.dif, atrSafe);

  // 3. 柱体收缩检测
  const contracting = detectContracting(macdArr, n);
  const histChangeRate = calcHistChangeRate(macdArr, n, atrSafe);

  // 4. DIF 方向
  const difDirection = classifyDifDirection(macdArr, n);

  // 5. 快线与柱体分离
  const separation = detectSeparation(macdArr, n, last.hist);

  // 6. 综合交易信号
  const actionableSignal = calcActionableSignal({
    zeroAxisPos,
    contracting,
    separation,
    momentum,
  });

  // 7. 生成解读文案
  const interpretation = buildInterpretation({
    momentum,
    contracting,
    separation,
    zeroAxisPos,
    difDirection,
    actionableSignal,
    hist: last.hist,
    dif: last.dif,
  });

  return {
    momentum,
    contracting,
    histChangeRate: round4(histChangeRate),
    difDirection,
    separation,
    zeroAxisPos,
    actionableSignal,
    interpretation,
  };
}

// ─── 常量 ──────────────────────────────────────────────────────────

/** 柱体收缩检测回看根数 */
const CONTRACT_BARS = 3;

/** 动能强度阈值（|hist| / ATR） */
const MOMENTUM_STRONG = 0.5;
const MOMENTUM_MEDIUM = 0.2;
const MOMENTUM_WEAK = 0.08;

/** 零轴粘合阈值（|DIF| / ATR） */
const ZERO_AXIS_NEAR = 0.05;

// ─── 子函数 ────────────────────────────────────────────────────────

function classifyMomentum(histNorm: number): MacdMomentumLevel {
  if (histNorm >= MOMENTUM_STRONG) return 'STRONG';
  if (histNorm >= MOMENTUM_MEDIUM) return 'MEDIUM';
  if (histNorm >= MOMENTUM_WEAK) return 'WEAK';
  return 'EMPTY';
}

function classifyZeroAxis(dif: number, atr: number): 'ABOVE' | 'BELOW' | 'NEAR' {
  if (Math.abs(dif) <= atr * ZERO_AXIS_NEAR) return 'NEAR';
  return dif > 0 ? 'ABOVE' : 'BELOW';
}

/**
 * 柱体收缩检测：检查最近 CONTRACT_BARS 根的 |hist| 是否连续递减。
 * 例如 CONTRACT_BARS=3 时检查 n-3, n-2, n-1 三根的 |hist| 是否严格递减。
 */
function detectContracting(macdArr: MacdResult[], n: number): boolean {
  for (let i = 1; i < CONTRACT_BARS; i++) {
    const prev = Math.abs(macdArr[n - 1 - i].hist);
    const curr = Math.abs(macdArr[n - i].hist);
    if (curr >= prev) return false;
  }
  return true;
}

/**
 * 柱体变化率：(hist[current] - hist[current-CONTRACT_BARS]) / ATR
 * 正值 = 柱体扩张，负值 = 柱体收缩（对柱体绝对值而言）
 * 但这里用有符号变化，因为红柱从 +5 变 +2 是动能衰减（正值变小），
 * 绿柱从 -5 变 -2 是动能增强（负值变大）。
 */
function calcHistChangeRate(
  macdArr: MacdResult[],
  n: number,
  atr: number,
): number {
  const curr = macdArr[n - 1].hist;
  const past = macdArr[n - 1 - CONTRACT_BARS].hist;
  const delta = curr - past;
  // 归一化到 ATR 单位
  return delta / atr;
}

/**
 * DIF 方向：比较最近 3 根 DIF 变化
 */
function classifyDifDirection(
  macdArr: MacdResult[],
  n: number,
): 'UP' | 'DOWN' | 'FLAT' {
  const curr = macdArr[n - 1].dif;
  const past = macdArr[n - 1 - CONTRACT_BARS].dif;
  const delta = curr - past;
  const threshold = Math.abs(curr) * 0.01;
  if (Math.abs(delta) < threshold) return 'FLAT';
  return delta > 0 ? 'UP' : 'DOWN';
}

/**
 * 快线与柱体分离检测
 *
 * 核心概念：DIF（快线）方向与柱体方向形成分离。
 * 柱体正（红柱）表示多头动能，负（绿柱）表示空头动能。
 *
 * BULLISH_SEP（看涨分离）：
 *   - 柱体为负（绿柱，空头动能），但 DIF 向上 → 空头动能衰竭，多头力量在恢复
 *   - 或者柱体从负转正过程中，DIF 已经开始上升
 *
 * BEARISH_SEP（看跌分离）：
 *   - 柱体为正（红柱，多头动能），但 DIF 向下 → 多头动能衰减，空头力量在积蓄
 *   - 或者柱体从正转负过程中，DIF 已经开始下降
 */
function detectSeparation(
  macdArr: MacdResult[],
  n: number,
  hist: number,
): MacdSeparation {
  const curr = macdArr[n - 1].dif;
  const past = macdArr[n - 1 - CONTRACT_BARS].dif;
  const difDelta = curr - past;

  // 柱体为负（绿柱）但 DIF 上升 → 看涨分离
  if (hist < 0 && difDelta > 0) return 'BULLISH_SEP';

  // 柱体为正（红柱）但 DIF 下降 → 看跌分离
  if (hist > 0 && difDelta < 0) return 'BEARISH_SEP';

  return 'NONE';
}

/**
 * 综合交易信号
 *
 * 文档原文：
 * "零轴上方出现长红柱，后续柱体缩量、快线与柱体形成分离走势，空头动能释放，进场做空。"
 * "零轴下方出现长绿柱，后续柱体缩量、快线与柱体形成分离走势，多头动能回暖，进场做多。"
 *
 * 做多条件：零轴下方（BELOW）+ 柱体收缩（contracting）+ 看涨分离（BULLISH_SEP）
 * 做空条件：零轴上方（ABOVE）+ 柱体收缩（contracting）+ 看跌分离（BEARISH_SEP）
 *
 * 注意：零轴粘合（NEAR）不产生信号，因为动能真空期方向不明。
 */
function calcActionableSignal(params: {
  zeroAxisPos: 'ABOVE' | 'BELOW' | 'NEAR';
  contracting: boolean;
  separation: MacdSeparation;
  momentum: MacdMomentumLevel;
}): MacdAdvancedSignal {
  const { zeroAxisPos, contracting, separation, momentum } = params;

  // 动能太弱时不产生信号（EMPTY 级别的柱体没有动能意义）
  if (momentum === 'EMPTY') return 'NONE';

  // 零轴粘合不产生信号
  if (zeroAxisPos === 'NEAR') return 'NONE';

  // 做多：零轴下方 + 柱体收缩 + 看涨分离
  if (zeroAxisPos === 'BELOW' && contracting && separation === 'BULLISH_SEP') {
    return 'LONG';
  }

  // 做空：零轴上方 + 柱体收缩 + 看跌分离
  if (zeroAxisPos === 'ABOVE' && contracting && separation === 'BEARISH_SEP') {
    return 'SHORT';
  }

  return 'NONE';
}

// ─── 解读文案 ──────────────────────────────────────────────────────

function buildInterpretation(params: {
  momentum: MacdMomentumLevel;
  contracting: boolean;
  separation: MacdSeparation;
  zeroAxisPos: 'ABOVE' | 'BELOW' | 'NEAR';
  difDirection: 'UP' | 'DOWN' | 'FLAT';
  actionableSignal: MacdAdvancedSignal;
  hist: number;
  dif: number;
}): string {
  const { momentum, contracting, separation, zeroAxisPos, difDirection, actionableSignal } = params;

  // 有可操作信号时优先展示
  if (actionableSignal === 'LONG') {
    return '零轴下方绿柱缩量 + 快线上行分离：空头动能衰竭，多头回暖，顺势做多';
  }
  if (actionableSignal === 'SHORT') {
    return '零轴上方红柱缩量 + 快线下行分离：多头动能衰竭，空头释放，顺势做空';
  }

  // 零轴粘合
  if (zeroAxisPos === 'NEAR') {
    return 'MACD 零轴粘合，动能真空，方向选择前夜，不交易，等突破';
  }

  // 动能太强，尚未收缩
  if (momentum === 'STRONG' && !contracting) {
    if (zeroAxisPos === 'ABOVE') {
      return '零轴上方强势红柱：多头动能充沛，趋势健康，回踩做多为主';
    }
    return '零轴下方强势绿柱：空头动能充沛，下跌延续，反弹做空为主';
  }

  // 柱体收缩但未分离
  if (contracting && separation === 'NONE') {
    return '柱体收缩但快线未分离：动能衰减中，等待方向确认';
  }

  // 柱体扩张但未分离
  if (!contracting && separation === 'NONE') {
    if (zeroAxisPos === 'ABOVE' && momentum !== 'EMPTY') {
      return '零轴上方红柱扩张：多头动能增强，趋势延续';
    }
    if (zeroAxisPos === 'BELOW' && momentum !== 'EMPTY') {
      return '零轴下方绿柱扩张：空头动能增强，下跌延续';
    }
  }

  // 分离但未收缩
  if (separation === 'BULLISH_SEP' && !contracting) {
    return '看涨分离出现但柱体未收缩：底部结构初步形成，等待动能衰竭确认';
  }
  if (separation === 'BEARISH_SEP' && !contracting) {
    return '看跌分离出现但柱体未收缩：顶部结构初步形成，等待动能衰竭确认';
  }

  // 动能弱
  if (momentum === 'WEAK' || momentum === 'EMPTY') {
    return 'MACD 动能微弱，信号模糊，以 EMA/趋势结构判断为主';
  }

  return `MACD ${zeroAxisPos === 'ABOVE' ? '红柱' : '绿柱'} · DIF ${difDirection === 'UP' ? '上行' : '下行'}，动能${momentum === 'STRONG' ? '强劲' : '一般'}`;
}

// ─── 工具函数 ──────────────────────────────────────────────────────

function emptyResult(reason: string): MacdAdvancedDto {
  return {
    momentum: 'EMPTY',
    contracting: false,
    histChangeRate: 0,
    difDirection: 'FLAT',
    separation: 'NONE',
    zeroAxisPos: 'NEAR',
    actionableSignal: 'NONE',
    interpretation: reason,
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
