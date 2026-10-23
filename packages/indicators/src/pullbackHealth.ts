import type { CandleDto, PullbackHealthDto } from '@crypto-monitor/shared';
import { findPivots } from './pivots.js';

/** Min candles required */
const MIN_LEN = 20;

/** Pivot detection window */
const PIVOT_WINDOW = 3;

/** Max bars back to find trend anchor */
const MAX_LOOKBACK = 50;

/** ATR period for normalization */
const ATR_PERIOD = 14;

/** Fibonacci 回调分级阈值 */
const SHALLOW_PCT = 0.236;
const NORMAL_PCT = 0.618;
const DEEP_PCT = 0.786;

/**
 * ATR-normalized slope: slope / ATR
 * slope > +0.5 → 强势上涨, < -0.5 → 强势下跌
 */
function atrNormalizedSlope(candles: CandleDto[], startIdx: number, endIdx: number): number {
  const n = endIdx - startIdx + 1;
  if (n < 3 || startIdx < 0 || endIdx >= candles.length) return 0;

  let sumATR = 0;
  let atrCount = 0;
  for (let i = startIdx + 1; i <= endIdx; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    const hl = c.high - c.low;
    const hc = Math.abs(c.high - prev.close);
    const lc = Math.abs(c.low - prev.close);
    sumATR += Math.max(hl, hc, lc);
    atrCount++;
  }
  const atr = atrCount > 0 ? sumATR / atrCount : 0;
  if (atr <= 0) return 0;

  const slope = (candles[endIdx].close - candles[startIdx].close) / n;
  return slope / atr;
}

/** Sum volume in [startIdx, endIdx] */
function rangeVolume(candles: CandleDto[], startIdx: number, endIdx: number): number {
  let vol = 0;
  for (let i = Math.max(0, startIdx); i <= Math.min(endIdx, candles.length - 1); i++) {
    vol += candles[i].volume;
  }
  return vol;
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/**
 * 分析趋势健康度与回调状态（裸K文档方法四 + 趋势走势 + 回调走势 + 健康度）。
 *
 * 核心逻辑：
 * 1. 用 findPivots 提取最近 swing 点
 * 2. 确定最近趋势方向：pivot low → 上涨；pivot high → 下跌
 * 3. 计算回调深度 = (趋势极值 - 当前价格) / (趋势极值 - 锚点)
 * 4. 量价配合 = 回调段均量 / 趋势段均量（缩量 = 健康）
 * 5. 综合评级：回调深度 × 量价 × ATR斜率 → STRONG/HEALTHY/NORMAL/DEEP/BROKEN
 */
export function analyzePullbackHealth(candles: CandleDto[]): PullbackHealthDto {
  const n = candles.length;

  if (n < MIN_LEN) {
    return {
      state: 'INSUFFICIENT_DATA',
      rating: 'UNKNOWN',
      pullbackPct: 0,
      pullbackBars: 0,
      volumeRatio: 0,
      atrSlope: 0,
      trendDir: 'NONE',
      interpretation: '数据不足，无法评估趋势健康度',
    };
  }

  // ── 1. 提取 swing 点 ──
  const pivotWindow = Math.min(PIVOT_WINDOW, Math.floor(n / 10));
  const { highs, lows } = findPivots(candles, pivotWindow);

  if (highs.length === 0 || lows.length === 0) {
    return {
      state: 'NO_SWING',
      rating: 'UNKNOWN',
      pullbackPct: 0,
      pullbackBars: 0,
      volumeRatio: 0,
      atrSlope: 0,
      trendDir: 'NONE',
      interpretation: '无有效波段点，无法评估',
    };
  }

  // ── 2. 确定最近趋势锚点 ──
  const lastHigh = highs[highs.length - 1];
  const lastLow = lows[lows.length - 1];
  const lastIdx = n - 1;
  const lastClose = candles[lastIdx].close;

  let trendDir: 'UP' | 'DOWN' | 'NONE' = 'NONE';
  let anchorIdx: number;
  let anchorPrice: number;

  if (lastLow.index > lastHigh.index) {
    // 最近 pivot 是 low → 上涨趋势（从 low 出发往上）
    trendDir = 'UP';
    anchorIdx = lastLow.index;
    anchorPrice = lastLow.price;
  } else if (lastHigh.index > lastLow.index) {
    // 最近 pivot 是 high → 下跌趋势（从 high 出发往下）
    trendDir = 'DOWN';
    anchorIdx = lastHigh.index;
    anchorPrice = lastHigh.price;
  } else {
    return {
      state: 'RANGING',
      rating: 'UNKNOWN',
      pullbackPct: 0,
      pullbackBars: 0,
      volumeRatio: 0,
      atrSlope: 0,
      trendDir: 'NONE',
      interpretation: '趋势方向不明，建议等待明确方向',
    };
  }

  // ── 3. 计算回调深度 ──
  const lookbackEnd = Math.min(n - 1, anchorIdx + MAX_LOOKBACK);
  let totalMove: number;
  let peakIdx: number;
  let peakPrice: number;
  let pullbackPct: number;

  if (trendDir === 'UP') {
    // 上涨趋势：找 anchor 之后的最高 close
    peakPrice = anchorPrice;
    peakIdx = anchorIdx;
    for (let i = anchorIdx + 1; i <= lookbackEnd; i++) {
      if (candles[i].close > peakPrice) {
        peakPrice = candles[i].close;
        peakIdx = i;
      }
    }
    totalMove = peakPrice - anchorPrice;
    if (totalMove <= 0) {
      return {
        state: 'FLAT',
        rating: 'UNKNOWN',
        pullbackPct: 0,
        pullbackBars: 0,
        volumeRatio: 0,
        atrSlope: 0,
        trendDir: 'NONE',
        interpretation: '上涨趋势未建立有效运动范围',
      };
    }
    // 回调深度 = (最高点 - 当前价) / 总运动
    pullbackPct = Math.max(0, Math.min(1, (peakPrice - lastClose) / totalMove));
  } else {
    // 下跌趋势：找 anchor 之后的最低 close
    peakPrice = anchorPrice;
    peakIdx = anchorIdx;
    for (let i = anchorIdx + 1; i <= lookbackEnd; i++) {
      if (candles[i].close < peakPrice) {
        peakPrice = candles[i].close;
        peakIdx = i;
      }
    }
    totalMove = anchorPrice - peakPrice;
    if (totalMove <= 0) {
      return {
        state: 'FLAT',
        rating: 'UNKNOWN',
        pullbackPct: 0,
        pullbackBars: 0,
        volumeRatio: 0,
        atrSlope: 0,
        trendDir: 'NONE',
        interpretation: '下跌趋势未建立有效运动范围',
      };
    }
    // 回调深度 = (当前价 - 最低点) / 总运动
    pullbackPct = Math.max(0, Math.min(1, (lastClose - peakPrice) / totalMove));
  }

  // ── 4. 量价配合 ──
  const pullbackBars = Math.max(1, lastIdx - peakIdx);
  const trendBars = Math.max(1, peakIdx - anchorIdx);

  const trendVol = rangeVolume(candles, anchorIdx, peakIdx);
  const pullbackVol = rangeVolume(candles, peakIdx + 1, lastIdx);
  const avgTrendVol = trendBars > 0 ? trendVol / trendBars : 0;
  const avgPullbackVol = pullbackBars > 0 ? pullbackVol / pullbackBars : 0;
  const volumeRatio = avgTrendVol > 0 ? avgPullbackVol / avgTrendVol : 0;

  // ── 5. ATR 斜率（最近 ATR_PERIOD 根 K 线）──
  const rawSlope = atrNormalizedSlope(candles, Math.max(0, lastIdx - ATR_PERIOD), lastIdx);
  // 下跌趋势下，正向 ATR slope 意味着价格仍在下行
  const atrSlope = trendDir === 'UP' ? rawSlope : -rawSlope;

  // ── 6. 评级 ──
  const { state: stateLabel, rating } = classifyRating(pullbackPct, volumeRatio, atrSlope, trendDir);

  return {
    state: trendDir,
    rating,
    pullbackPct: round4(pullbackPct),
    pullbackBars,
    volumeRatio: round4(volumeRatio),
    atrSlope: round4(atrSlope),
    trendDir,
    interpretation: buildInterpretation(stateLabel, pullbackPct, volumeRatio, atrSlope, trendDir),
  };
}

function classifyRating(
  pullbackPct: number,
  volumeRatio: number,
  atrSlope: number,
  trendDir: 'UP' | 'DOWN',
): { state: string; rating: PullbackHealthDto['rating'] } {
  const label = trendDir === 'UP' ? '上涨' : '下跌';

  if (pullbackPct >= DEEP_PCT) {
    if (volumeRatio > 1) {
      return { state: `${label}破位风险`, rating: 'BROKEN' };
    }
    return { state: `${label}深度回调`, rating: 'DEEP' };
  }

  if (pullbackPct >= NORMAL_PCT) {
    if (volumeRatio <= 0.6) {
      return { state: `${label}健康回调`, rating: 'HEALTHY' };
    }
    return { state: `${label}正常回调`, rating: 'NORMAL' };
  }

  if (pullbackPct >= SHALLOW_PCT) {
    if (volumeRatio <= 0.5 && atrSlope > 0) {
      return { state: `${label}强势回调`, rating: 'STRONG' };
    }
    if (volumeRatio <= 0.7) {
      return { state: `${label}健康回调`, rating: 'HEALTHY' };
    }
    return { state: `${label}正常回调`, rating: 'NORMAL' };
  }

  // < 23.6% → 浅回调
  if (atrSlope > 0.3) {
    return { state: `${label}强势延续`, rating: 'STRONG' };
  }
  if (atrSlope > 0) {
    return { state: `${label}延续中`, rating: 'HEALTHY' };
  }
  return { state: `${label}动能减弱`, rating: 'NORMAL' };
}

function buildInterpretation(
  state: string,
  pullbackPct: number,
  volumeRatio: number,
  atrSlope: number,
  trendDir: 'UP' | 'DOWN',
): string {
  const parts: string[] = [];

  if (trendDir === 'UP') parts.push('上涨趋势');
  else parts.push('下跌趋势');

  parts.push(state);
  parts.push(`回调${(pullbackPct * 100).toFixed(1)}%`);

  if (volumeRatio > 0) {
    if (volumeRatio < 0.5) parts.push('明显缩量');
    else if (volumeRatio < 0.8) parts.push('温和缩量');
    else if (volumeRatio < 1.0) parts.push('基本持平');
    else parts.push(`放量${volumeRatio.toFixed(2)}×`);
  }

  if (atrSlope > 0.3) parts.push('ATR斜率强');
  else if (atrSlope > 0) parts.push('ATR斜率弱');
  else if (atrSlope < 0) parts.push('ATR斜率反向');

  // Fibonacci 参考：总是显示最接近的 Fibonacci 级别
  const fibLevels = [
    { pct: 0, label: '0%' },
    { pct: SHALLOW_PCT, label: '23.6%' },
    { pct: 0.382, label: '38.2%' },
    { pct: 0.5, label: '50%' },
    { pct: NORMAL_PCT, label: '61.8%' },
    { pct: DEEP_PCT, label: '78.6%' },
  ];
  let nearest = fibLevels[0];
  let nearestDist = Math.abs(pullbackPct - nearest.pct);
  for (const f of fibLevels) {
    const dist = Math.abs(pullbackPct - f.pct);
    if (dist < nearestDist) {
      nearest = f;
      nearestDist = dist;
    }
  }
  if (nearestDist < 0.08) {
    parts.push(`接近Fib ${nearest.label}`);
  } else {
    parts.push(`Fib区间 ${nearest.label}~${pullbackPct > nearest.pct ? '下一级' : '前一级'}`);
  }

  return parts.join('，');
}
