import type { CandleDto, ReversalEntryDto, TrendStructureDto } from '@crypto-monitor/shared';

/**
 * K线反转精准入场分析
 *
 * 核心逻辑（文档《K线反转精准入场》第五~六节）：
 *
 * 趋势走势 vs 回调走势：
 *   - 趋势走势 = 大蜡烛，动能强劲，价格顺着趋势方向走
 *   - 回调走势 = 小蜡烛，逆趋势方向的短暂回拨
 *   - 大蜡烛回调 = 趋势反转预警（回调出现大蜡烛说明反向动能已介入）
 *
 * 三大信号共振 + 关键位确认：
 *   ① 趋势走势转弱 — 最后趋势K线实体缩小（动能不足）
 *   ② 回调走势变强 — 回调中出现大蜡烛（反向动能介入）
 *   ③ 趋势架构破坏 — 上升出LL / 下跌出HH（结构被打破）
 *   ④ 关键位确认（加分项）— 价格在支撑/阻力位附近，确定性翻倍
 *
 * 信号共振规则：
 *   ≥3 个条件 → STRONG_REVERSAL（强反转信号）
 *   2 个条件  → REVERSAL_WATCH（关注反转）
 *   <2 个条件 → NO_REVERSAL（趋势健康）
 */

/** 分析窗口（K线根数） */
const ANALYSIS_WINDOW = 20;
/** 最少K线数（低于此数无法分析） */
const MIN_CANDLES = 10;
/** 趋势转弱阈值：最后趋势K线实体 < 前序均值 × 此比例 → 转弱 */
const WEAKENING_RATIO = 0.6;
/** 强回调阈值：回调K线实体 >= 趋势均值 × 此比例 → 强回调 */
const STRONG_PULLBACK_RATIO = 0.7;
/** 关键位距离（±3%） */
const KEY_LEVEL_PCT = 0.03;
/** 止损缓冲（× ATR） */
const SL_BUFFER_ATR = 0.5;
/** 止盈回退距离（× ATR，无关键位时使用） */
const TP_FALLBACK_ATR = 2.0;

/**
 * 分析K线反转入场信号。
 *
 * @param candles       K线数据
 * @param atrArr        ATR 数组（14期）
 * @param trendStructure 趋势结构分析（来自 trendStructure 模块）
 * @param support       支撑位列表
 * @param resistance    阻力位列表
 * @returns ReversalEntryDto 反转信号
 */
export function analyzeReversalEntry(
  candles: CandleDto[],
  atrArr: number[],
  trendStructure: TrendStructureDto,
  support: number[],
  resistance: number[],
): ReversalEntryDto {
  const n = candles.length;

  const noSignal: ReversalEntryDto = {
    direction: 'BULLISH',
    originalTrend: 'UP',
    trendWeakening: false,
    strongPullback: false,
    structureBroken: false,
    nearKeyLevel: false,
    resonanceCount: 0,
    strength: 0,
    verdict: 'NO_REVERSAL',
    entryPrice: null,
    stopLoss: null,
    takeProfit: null,
    interpretation: '当前趋势健康，无显著反转信号',
  };

  if (n < MIN_CANDLES) {
    return { ...noSignal, interpretation: '数据不足，无法分析反转信号' };
  }

  const lastAtr = atrArr[n - 1] || 0;
  if (lastAtr <= 0) {
    return { ...noSignal, interpretation: 'ATR 无效，无法分析反转信号' };
  }

  // ── 确定原始趋势方向 ──
  let originalTrend: 'UP' | 'DOWN' | null = null;
  if (trendStructure.direction === 'BULLISH') originalTrend = 'UP';
  else if (trendStructure.direction === 'BEARISH') originalTrend = 'DOWN';

  if (!originalTrend) {
    return { ...noSignal, interpretation: '无明确趋势方向（震荡/数据不足），不评估反转信号' };
  }

  const currentClose = candles[n - 1]!.close;
  const reversalDirection: 'BULLISH' | 'BEARISH' = originalTrend === 'UP' ? 'BEARISH' : 'BULLISH';

  // ── 分析窗口 ──
  const startIdx = Math.max(0, n - ANALYSIS_WINDOW);

  // ── 分类K线：趋势K线 vs 回调K线 ──
  // 趋势K线：收盘方向与趋势方向一致（UP趋势=阳线, DOWN趋势=阴线）
  // 回调K线：收盘方向与趋势方向相反
  const trendCandles: { index: number; body: number }[] = [];
  const pullbackCandles: { index: number; body: number }[] = [];

  for (let i = startIdx; i < n; i++) {
    const c = candles[i]!;
    const body = Math.abs(c.close - c.open);
    if (body === 0) continue; // 跳过零实体
    const isBullish = c.close > c.open;

    if (originalTrend === 'UP') {
      if (isBullish) trendCandles.push({ index: i, body });
      else pullbackCandles.push({ index: i, body });
    } else {
      if (!isBullish) trendCandles.push({ index: i, body });
      else pullbackCandles.push({ index: i, body });
    }
  }

  // ── 信号①：趋势走势转弱 ──
  // 最后趋势K线实体 < 前序均值 × 0.6 → 趋势动能不足
  let trendWeakening = false;
  if (trendCandles.length >= 3) {
    const lastTrend = trendCandles[trendCandles.length - 1]!;
    const prevTrends = trendCandles.slice(0, -1);
    const avgBody = prevTrends.reduce((s, t) => s + t.body, 0) / prevTrends.length;
    trendWeakening = lastTrend.body < avgBody * WEAKENING_RATIO;
  }

  // ── 信号②：回调走势变强 ──
  // 回调K线中出现实体 >= 趋势均值 × 0.7 的大蜡烛 → 反向动能介入
  const avgTrendBody = trendCandles.length > 0
    ? trendCandles.reduce((s, t) => s + t.body, 0) / trendCandles.length
    : 0;

  let strongPullback = false;
  if (avgTrendBody > 0) {
    for (const pb of pullbackCandles) {
      if (pb.body >= avgTrendBody * STRONG_PULLBACK_RATIO) {
        strongPullback = true;
        break;
      }
    }
  }

  // ── 信号③：趋势架构破坏 ──
  // UP 趋势 + BULL_BROKEN（上升出LL） → 看跌反转
  // DOWN 趋势 + BEAR_BROKEN（下跌出HH） → 看涨反转
  const structureBroken = trendStructure.structureBreak === 'BULL_BROKEN' ||
                          trendStructure.structureBreak === 'BEAR_BROKEN';

  // ── 信号④：关键位确认 ──
  let nearKeyLevel = false;
  for (const s of support) {
    if (s > 0 && Math.abs(currentClose - s) / s <= KEY_LEVEL_PCT) {
      nearKeyLevel = true;
      break;
    }
  }
  if (!nearKeyLevel) {
    for (const r of resistance) {
      if (r > 0 && Math.abs(currentClose - r) / r <= KEY_LEVEL_PCT) {
        nearKeyLevel = true;
        break;
      }
    }
  }

  // ── 共振计数与强度计算 ──
  const resonanceCount = [trendWeakening, strongPullback, structureBroken, nearKeyLevel]
    .filter(Boolean).length;

  // 加权强度：架构破坏权重最高，其次强回调、趋势转弱、关键位
  const strength = Math.min(
    (trendWeakening ? 0.20 : 0) +
    (strongPullback ? 0.25 : 0) +
    (structureBroken ? 0.35 : 0) +
    (nearKeyLevel ? 0.20 : 0),
    1.0,
  );

  // ── 信号评级 ──
  let verdict: ReversalEntryDto['verdict'];
  if (resonanceCount >= 3) verdict = 'STRONG_REVERSAL';
  else if (resonanceCount >= 2) verdict = 'REVERSAL_WATCH';
  else verdict = 'NO_REVERSAL';

  // ── 入场/止损/止盈 ──
  let entryPrice: number | null = null;
  let stopLoss: number | null = null;
  let takeProfit: number | null = null;

  if (verdict !== 'NO_REVERSAL') {
    entryPrice = currentClose;
    if (reversalDirection === 'BEARISH') {
      // UP→DOWN：做空，止损在上方，止盈=最近支撑位
      stopLoss = currentClose + lastAtr * SL_BUFFER_ATR;
      takeProfit = support.length > 0 && support[0] < currentClose
        ? support[0]
        : currentClose - lastAtr * TP_FALLBACK_ATR;
    } else {
      // DOWN→UP：做多，止损在下方，止盈=最近阻力位
      stopLoss = currentClose - lastAtr * SL_BUFFER_ATR;
      takeProfit = resistance.length > 0 && resistance[0] > currentClose
        ? resistance[0]
        : currentClose + lastAtr * TP_FALLBACK_ATR;
    }
  }

  // ── 解读文案 ──
  const signals: string[] = [];
  if (trendWeakening) signals.push('趋势动能减弱');
  if (strongPullback) signals.push('回调动能异常增强');
  if (structureBroken) signals.push('趋势结构破坏');
  if (nearKeyLevel) signals.push('关键位确认');

  const trendLabel = originalTrend === 'UP' ? '上升' : '下跌';
  const reverseLabel = reversalDirection === 'BEARISH' ? '做空' : '做多';

  let interpretation: string;
  if (verdict === 'STRONG_REVERSAL') {
    interpretation = `🔴 ${trendLabel}趋势反转！${signals.join(' + ')}，建议${reverseLabel}入场`;
  } else if (verdict === 'REVERSAL_WATCH') {
    interpretation = `🟡 关注${trendLabel}趋势反转。已满足${signals.join(' + ')}，等待更多确认`;
  } else {
    interpretation = `${trendLabel}趋势健康，无显著反转信号`;
  }

  return {
    direction: reversalDirection,
    originalTrend,
    trendWeakening,
    strongPullback,
    structureBroken,
    nearKeyLevel,
    resonanceCount,
    strength,
    verdict,
    entryPrice,
    stopLoss,
    takeProfit,
    interpretation,
  };
}
