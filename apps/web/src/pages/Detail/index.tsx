import { useEffect, useState, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import type {
  CandleDto,
  IndicatorSnapshotDto,
  AiStrategyDto,
  TickerDto,
  FundingRateDto,
} from '@crypto-monitor/shared';
import { AI_REGEN_COOLDOWN_MS, fmtPrice, formatBeijingTime } from '@crypto-monitor/shared';
import { api } from '../../lib/api';
import { AiPanel } from '../../components/AiStrategy/AiPanel';
import { KlineChart } from '../../components/Chart/KlineChart';
import { usePolling } from '../../hooks/usePolling';
import { useWatchlistStore } from '../../store/watchlist';

function toPercent(rate: number): number {
  return rate * 100;
}

function fundingInterpretation(rate: number): { label: string; detail: string; meaning: string } {
  const p = toPercent(rate);
  if (p >= 0.1) {
    return { label: '极端', detail: '> 0.1%', meaning: '市场极度贪婪，常见于阶段性顶部附近，反转概率大增' };
  }
  if (p > 0.05) {
    return { label: '偏热', detail: '0.05% ~ 0.1%', meaning: '多头过度拥挤，追多成本高，回调风险上升' };
  }
  if (p > 0.01) {
    return { label: '温和偏多', detail: '0.01% ~ 0.05%', meaning: '多头情绪积极，趋势可能延续' };
  }
  if (p >= 0) {
    return { label: '基准/中性', detail: '≈ 0.01%', meaning: '多空均衡，市场健康' };
  }
  if (p > -0.01) {
    return { label: '轻微偏空', detail: '0 ~ -0.01%', meaning: '接近中性，空头压力不大' };
  }
  if (p > -0.05) {
    return { label: '偏空', detail: '-0.01% ~ -0.05%', meaning: '空头情绪明显，市场偏悲观' };
  }
  if (p >= -0.1) {
    return { label: '空头拥挤', detail: '-0.05% ~ -0.1%', meaning: '反弹/轧空风险上升' };
  }
  return { label: '极端看空', detail: '< -0.1%', meaning: '常见于阶段性底部附近，容易出现空头挤压' };
}

function momentumState(snapshot: IndicatorSnapshotDto): 'confirmed' | 'weak' | 'negative' {
  const macdBull = snapshot.macd.signal === 'GOLDEN_CROSS' || snapshot.macd.hist > 0;
  const obvInflow = snapshot.obv.flow === 'INFLOW';
  if (macdBull && obvInflow) return 'confirmed';
  if (!macdBull && !obvInflow) return 'negative';
  return 'weak';
}

function fundingBias(rate?: number): 'long' | 'neutral' | 'short' {
  const p = (rate ?? 0) * 100;
  if (p > 0.01) return 'long';
  if (p < -0.01) return 'short';
  return 'neutral';
}

/**
 * 指标事实串：只陈述"是什么"，不下结论。
 * 结论由 `decisionSummary` 统一给出，避免两处拼接后出现
 * "均线偏多……反抽不宜追涨，多头结构……" 这类自相矛盾的读感。
 */
function biasText(snapshot: IndicatorSnapshotDto, fundingRate?: number): string {
  const ema = snapshot.emaStructure === 'BULLISH' ? '均线偏多' : snapshot.emaStructure === 'BEARISH' ? '均线偏空' : '均线未定';
  // 交叉必须带上新鲜度：当根交叉与"3 根内保留"对决策的含义完全不同（dev.md 4.1）
  const { signal, signalAge, hist } = snapshot.macd;
  const macd =
    signal === 'GOLDEN_CROSS'
      ? signalAge === 0 ? 'MACD当根金叉' : `MACD金叉（近 ${signalAge} 根内）`
      : signal === 'DEATH_CROSS'
        ? signalAge === 0 ? 'MACD当根死叉' : `MACD死叉（近 ${signalAge} 根内）`
        : hist > 0 ? '动能转正' : '动能未转正';
  const obv = snapshot.obv.flow === 'INFLOW' ? 'OBV流入' : snapshot.obv.flow === 'OUTFLOW' ? 'OBV流出' : 'OBV中性';
  const funding = fundingRate === undefined ? '' : fundingBias(fundingRate) === 'long' ? '，资金偏多' : fundingBias(fundingRate) === 'short' ? '，资金偏空' : '，资金中性';
  return `${ema}，${macd}，${obv}${funding}`;
}

function decisionSummary(snapshot: IndicatorSnapshotDto, symbol: string, current?: number, fundingRate?: number): string {
  const levels = keyLevels(snapshot, current);
  const bias = biasText(snapshot, fundingRate);
  const mom = momentumState(snapshot);
  const { emaStructure, trend } = snapshot;

  if (snapshot.plan) {
    const action = snapshot.plan.side === 'LONG' ? '做多' : '做空';
    return `${symbol}：${action}\n区间 ${fmtPrice(snapshot.plan.entryLow)}–${fmtPrice(snapshot.plan.entryHigh)}\n目标 ${fmtPrice(snapshot.plan.tp1)} / ${fmtPrice(snapshot.plan.tp2)}\n止损 ${fmtPrice(snapshot.plan.sl)} · RR ${snapshot.plan.rrRatio.toFixed(2)}`;
  }

  // 突破位（上方阻力）与跌破位（即时支撑）必须是**现价之外**的价位，否则"站上 X"恒为真、毫无信息量
  const breakout =
    levels.nextResistanceValue != null && levels.nextResistanceValue !== levels.upperResistanceValue
      ? `站上 ${levels.upperResistance} 再看 ${levels.nextResistance}`
      : `站上 ${levels.upperResistance}`;
  const breakdown = `跌破 ${levels.immediateSupport}`;

  if (emaStructure === 'BULLISH') {
    // 多头排列：评分未达阈值只代表"动能未共振"，不能反过来说成偏空
    const timing =
      mom === 'confirmed'
        ? '动能已共振，回踩不破可跟随'
        : `多头结构但动能未共振（评分 ${trend.score} < +40），先等关键位确认`;
    return `${symbol}：${bias}；${timing}。${breakout} 转强，${breakdown} 结构转弱。`;
  }

  if (emaStructure === 'BEARISH') {
    const timing = mom === 'negative' ? '空头动能延续，反弹是卖点' : '空头结构但动能未续，反弹先减仓';
    return `${symbol}：${bias}；${timing}。${breakdown} 延续下探，站上 ${levels.upperResistance} 才有反弹空间。`;
  }

  return `${symbol}：${bias}；均线缠绕方向未明，${levels.immediateSupport}–${levels.upperResistance} 区间内不追单，${breakout} 或 ${breakdown} 后再评估。`;
}

/** EMA 动态解读：方向 + 价格乖离质量 */
function emaInterpretation(snapshot: IndicatorSnapshotDto, current?: number): { title: string; meaning: string } {
  const { emaStructure, ema25, rsi14 } = snapshot;
  const price = current ?? snapshot.ema7;
  const devPct = ema25 > 0 ? ((price - ema25) / ema25) * 100 : 0;
  const absDev = Math.abs(devPct);

  if (emaStructure === 'BULLISH') {
    if (absDev > 4) {
      return { title: 'EMA 多头 · 正乖离过大', meaning: `方向偏多，但价格偏离EMA20达${devPct.toFixed(1)}%，均值回归压力上升，不追多，等回踩均线` };
    }
    if (rsi14 >= 70) {
      return { title: 'EMA 多头 · RSI超买', meaning: '方向偏多但RSI超买，追高赔率差，等回踩不破EMA20再考虑' };
    }
    return { title: 'EMA 多头排列', meaning: '方向偏多，趋势健康，回踩不破EMA20/50可顺势跟进' };
  }

  if (emaStructure === 'BEARISH') {
    if (absDev > 4) {
      return { title: 'EMA 空头 · 负乖离过大', meaning: `方向偏空，但价格偏离EMA20达${devPct.toFixed(1)}%，超卖反弹概率上升，不追空` };
    }
    if (rsi14 <= 30) {
      return { title: 'EMA 空头 · RSI超卖', meaning: '方向偏空但RSI超卖，追空性价比低，等反弹至均线附近再评估' };
    }
    return { title: 'EMA 空头排列', meaning: '方向偏空，反弹至均线是阻力，反弹做空胜率更高' };
  }

  return { title: 'EMA 纠缠', meaning: '均线缠绕，方向未明，突破需放量确认，否则频繁金叉死叉都是假信号' };
}

/** RSI 动态解读：位置风险 + 动能确认 */
function rsiInterpretation(snapshot: IndicatorSnapshotDto): { title: string; meaning: string } {
  const { rsi14, rsiZone, macd } = snapshot;
  const macdBullish = macd.hist > 0;

  if (rsiZone === 'OVERBOUGHT') {
    if (!macdBullish || macd.signal === 'DEATH_CROSS') {
      return { title: `RSI ${rsi14.toFixed(1)} 超买 · 动能背离`, meaning: '超买+动能衰减，最危险的追多信号，减多或观望' };
    }
    return { title: `RSI ${rsi14.toFixed(1)} 超买`, meaning: '超买但MACD红柱仍在扩张，强趋势可容忍，需盯柱线是否收缩' };
  }

  if (rsiZone === 'OVERSOLD') {
    if (macdBullish || macd.signal === 'GOLDEN_CROSS') {
      return { title: `RSI ${rsi14.toFixed(1)} 超卖 · 卖压衰竭`, meaning: '超卖+动能修复，反弹概率上升，但不单独抄底，等确认' };
    }
    return { title: `RSI ${rsi14.toFixed(1)} 超卖`, meaning: '超卖但空动能仍在，下跌趋势未止，不单独抄底' };
  }

  if (rsi14 >= 50) {
    return { title: `RSI ${rsi14.toFixed(1)} 中性偏强`, meaning: '多头占优，趋势健康区，回踩不破50可顺势' };
  }

  if (rsi14 > 45) {
    return { title: `RSI ${rsi14.toFixed(1)} 多空平衡`, meaning: '方向未定，上穿50偏多，下穿50偏空，不交易' };
  }

  return { title: `RSI ${rsi14.toFixed(1)} 中性偏弱`, meaning: '空头占优，反弹至50附近是阻力，偏空' };
}

/** MACD 动态解读：动能节奏 + 零轴位置 + 信号新鲜度 */
function macdInterpretation(snapshot: IndicatorSnapshotDto): { title: string; meaning: string } {
  const { dif, dea, hist, signal, signalAge } = snapshot.macd;
  const aboveZero = dif > 0;
  const belowZero = dif < 0;
  const nearZero = Math.abs(dif) < 0.01 * Math.abs(dif + dea + 0.001);
  // signalAge === 0 为当根交叉；1~3 是保留期内的"近期信号"，按 dev.md 4.1 必须弱化呈现
  const isFresh = signalAge === 0;
  const staleness = isFresh ? '' : `（近 ${signalAge} 根内，已弱化）`;

  if (signal === 'GOLDEN_CROSS') {
    if (aboveZero) {
      return {
        title: `MACD 零轴上金叉${staleness}`,
        meaning: isFresh
          ? '多头市场中的动能再增强，趋势延续信号，可靠性高'
          : '金叉已过去若干根，动能未进一步扩张，参考价值低于当根金叉',
      };
    }
    return {
      title: `MACD 零轴下金叉${staleness}`,
      meaning: isFresh
        ? '空头市场中的修复性反弹，可能只是反弹不是反转，需观察能否上零轴'
        : '零轴下金叉已过去若干根，反弹力度未确认，观察能否上零轴',
    };
  }

  if (signal === 'DEATH_CROSS') {
    if (aboveZero) {
      return {
        title: `MACD 零轴上死叉${staleness}`,
        meaning: isFresh
          ? '多头市场中的动能减弱，可能是上涨中继回调，不一定是转势'
          : '死叉已过去若干根，回调未继续扩大，参考价值低于当根死叉',
      };
    }
    return {
      title: `MACD 零轴下死叉${staleness}`,
      meaning: isFresh
        ? '空头市场中的动能再增强，下跌延续信号，反弹做空'
        : '零轴下死叉已过去若干根，下跌动能未再增强，谨慎追空',
    };
  }

  if (nearZero || Math.abs(hist) < Math.abs(dif) * 0.05) {
    return { title: 'MACD 零轴粘合', meaning: '动能真空，方向选择前夜，不交易，等突破' };
  }

  if (hist > 0) {
    if (aboveZero) {
      return { title: 'MACD 红柱 · 零轴上', meaning: '多头动能仍存，趋势健康，回踩做多为主' };
    }
    return { title: 'MACD 红柱 · 零轴下', meaning: '空头市场中多头动能修复，反弹但未确认转势' };
  }

  if (belowZero) {
    return { title: 'MACD 绿柱 · 零轴下', meaning: '空头动能仍存，下跌趋势延续，反弹做空为主' };
  }

  return { title: 'MACD 绿柱 · 零轴上', meaning: '多头市场中动能衰减，警惕回调' };
}

/** 量价背离 + OBV 动态解读：价格方向 × 成交量变化 × OBV 趋势 → 背离类型 + 交易含义 */
function volumePriceInterpretation(snapshot: IndicatorSnapshotDto): { title: string; meaning: string } {
  const { obv: obvRes, trend, rsi14, rsiZone, macd } = snapshot;
  const priceTrendUp = trend.direction === 'BULLISH';
  const priceTrendDown = trend.direction === 'BEARISH';
  const priceTrendFlat = trend.direction === 'RANGING';
  const volumeRatio = obvRes.volumeRatio;
  const obvAboveMa20 = obvRes.value > obvRes.ma20;
  const volumeShrinking = volumeRatio < 0.6;
  const volumeSurging = volumeRatio > 2.0;
  const volumeModerate = volumeRatio >= 0.8 && volumeRatio <= 1.2;
  const volumeGrowing = volumeRatio > 1.2;

  const resonance = priceTrendUp && macd.hist > 0 && rsi14 >= 50 && obvRes.flow === 'INFLOW'
    ? '量价齐升共振，趋势健康，回踩不破可顺势'
    : priceTrendDown && macd.hist < 0 && rsi14 <= 50 && obvRes.flow === 'OUTFLOW'
      ? '量价齐跌共振，下跌动能充分，不抄底的信号'
      : '';

  // ── 巨量不涨：高量低涨 → 主力出货 ──
  if (volumeSurging && !priceTrendUp) {
    if (priceTrendDown) {
      return { title: '巨量下跌 · 恐慌/出货', meaning: '天量下跌，卖压集中释放，不宜抄底，等缩量企稳后再观察' };
    }
    return { title: '巨量不涨 · 高位出货', meaning: '天量但价格滞涨，主力借量能吸引接盘，减仓离场不进场 ⚫' };
  }

  // ── 顶背离：价格涨但量能萎缩 ──
  if (priceTrendUp && volumeShrinking) {
    if (rsiZone === 'OVERBOUGHT') {
      return { title: '顶背离 · RSI超买', meaning: '价涨量缩+超买，动能衰竭加剧，减仓信号，等放量阴线确认后离场 🔴' };
    }
    return { title: '顶背离 · 追价意愿减弱', meaning: '价格上涨但量能持续萎缩，上涨动能正在耗尽，不追多，等确认信号 🔴' };
  }

  // ── 底背离：价格跌但量能萎缩 ──
  if (priceTrendDown && volumeShrinking) {
    if (rsiZone === 'OVERSOLD') {
      return { title: '底背离 · 卖压衰竭', meaning: '价跌量缩+超卖，卖方力量枯竭，关注企稳信号，放量阳线确认后小仓介入 🟡' };
    }
    return { title: '底背离 · 卖方力量衰减', meaning: '价格下跌但量能持续萎缩，抛售力度在减弱，不追空，等放量阳线确认 🟡' };
  }

  // ── 量价齐升（健康上涨） ──
  if (priceTrendUp && volumeGrowing) {
    if (macd.hist < 0 || macd.signal === 'DEATH_CROSS') {
      return { title: '量价齐升 · 动能背离', meaning: '量能配合但MACD动能衰减，上涨持续性存疑，谨慎追多' };
    }
    if (rsiZone === 'OVERBOUGHT') {
      return { title: '量价齐升 · RSI超买', meaning: '量价配合但RSI超买，强趋势可容忍，盯柱线是否收缩' };
    }
    return { title: '量价齐升 · 上涨健康', meaning: '价格上涨且量能配合放大，趋势健康，回踩不破可顺势' };
  }

  // ── 量价齐跌（下跌动能充分） ──
  if (priceTrendDown && volumeGrowing) {
    if (rsiZone === 'OVERSOLD') {
      return { title: '量价齐跌 · RSI超卖', meaning: '量能配合下跌但RSI超卖，极端抛压后常有技术性反弹，但趋势未止，不单独抄底' };
    }
    return { title: '量价齐跌 · 下跌动能充分', meaning: '价格下跌且放量，下跌动能充分，趋势延续概率大，不抄底' };
  }

  // ── OBV 趋势与价格趋势背离（OBV 是量价的"X光片"） ──
  if (priceTrendUp && obvRes.value < obvRes.ma20 && obvRes.flow === 'OUTFLOW') {
    return { title: 'OBV 顶背离雏形', meaning: '价格上涨但 OBV 在 MA20 下方且资金流出，资金未追随价格，上涨缺乏真实支撑，警惕 ⚠️' };
  }
  if (priceTrendDown && obvRes.value > obvRes.ma20 && obvRes.flow === 'INFLOW') {
    return { title: 'OBV 底背离雏形', meaning: '价格下跌但 OBV 在 MA20 上方且资金流入，聪明钱可能低位吸筹，关注企稳信号' };
  }

  // ── 高位横盘 + OBV 下降 = 派发 ──
  if (priceTrendFlat && obvAboveMa20 && obvRes.flow === 'OUTFLOW') {
    return { title: '横盘派发', meaning: '价格横盘但 OBV 下降，高位筹码派发，具有看跌意义，不宜进场' };
  }

  // ── 低位横盘 + OBV 上升 = 吸筹 ──
  if (priceTrendFlat && !obvAboveMa20 && obvRes.flow === 'INFLOW') {
    return { title: '横盘吸筹', meaning: '价格横盘但 OBV 上升，低位筹码搜集，上涨行情可能酝酿中' };
  }

  // ── 缩量阴跌 ──
  if (priceTrendDown && volumeShrinking && obvRes.flow === 'OUTFLOW') {
    return { title: '缩量阴跌 · 无人接盘', meaning: '持续下滑且量能萎缩，无承接意愿，跌势可能持续，坚决远离 🟠' };
  }

  // ── 量价同向健康 ──
  if (resonance) {
    return { title: '量价共振', meaning: resonance };
  }

  // ── 温和量价（量能接近均值） ──
  if (volumeModerate) {
    if (priceTrendUp) return { title: '量价同向 · 上涨温和', meaning: '价格与量能温和上行，无明显背离，趋势延续但缺乏加速动力' };
    if (priceTrendDown) return { title: '量价同向 · 下跌温和', meaning: '价格与量能温和下行，下跌趋势未加速，观望' };
  }

  return { title: '量价中性', meaning: '量价关系无明显背离，不触发背离交易信号，以 EMA/MACD 方向为主' };
}

function decisionBasis(snapshot: IndicatorSnapshotDto, current?: number): Array<{ title: string; detail: string; meaning: string }> {
  const ema = emaInterpretation(snapshot, current);
  const rsi = rsiInterpretation(snapshot);
  const macd = macdInterpretation(snapshot);
  const vp = volumePriceInterpretation(snapshot);
  const obvText = snapshot.obv.flow === 'INFLOW' ? '流入' : snapshot.obv.flow === 'OUTFLOW' ? '流出' : '中性';

  return [
    {
      title: ema.title,
      detail: `EMA7 ${snapshot.ema7.toFixed(2)} / EMA25 ${snapshot.ema25.toFixed(2)} / EMA99 ${snapshot.ema99.toFixed(2)}`,
      meaning: ema.meaning,
    },
    {
      title: rsi.title,
      detail: `RSI ${snapshot.rsi14.toFixed(1)} · ${snapshot.rsiZone}`,
      meaning: rsi.meaning,
    },
    {
      title: macd.title,
      detail: `DIF ${snapshot.macd.dif.toFixed(4)} / DEA ${snapshot.macd.dea.toFixed(4)}`,
      meaning: macd.meaning,
    },
    {
      title: vp.title,
      detail: `量比 ${snapshot.obv.volumeRatio.toFixed(2)} · OBV${obvText} · ${snapshot.trend.direction}`,
      meaning: vp.meaning,
    },
  ];
}

/** 价位格式化：无有效价位时统一显示占位符，绝不把 0 当作价格 */
function fmtLevel(value: number | undefined): string {
  return value != null && Number.isFinite(value) && value > 0 ? fmtPrice(value) : '--';
}

/**
 * 关键价位分组。
 *
 * `snapshot.support` / `resistance` 的契约是**离现价最近优先**
 * （support 降序、resistance 升序，见 dev.md 2.3），因此下标即"深度"。
 * 四个标签对应四个不同的价位，不再像修复前那样三个标签渲染同一个最远支撑：
 *
 * - 即时支撑   = support[0]                        第一道防线
 * - 关键支撑   = support[1] ?? support[0]          跌破则结构转弱
 * - 下方风险位 = support[最后]                      下行目标 / 极限风险位
 * - 上方阻力   = resistance[0]                     第一压力位
 */
function keyLevels(snapshot: IndicatorSnapshotDto, current?: number) {
  const support = snapshot.support;
  const resistance = snapshot.resistance;

  const immediateSupportValue = support[0];
  const keySupportValue = support[1] ?? support[0];
  const downsideRiskValue = support[support.length - 1];
  const upperResistanceValue = resistance[0];
  const nextResistanceValue = resistance[1] ?? resistance[0];

  // 区间位置：以整段结构（最深支撑 → 最远阻力）为标尺
  const rangeLo = downsideRiskValue;
  const rangeHi = resistance[resistance.length - 1];
  const base = current ?? immediateSupportValue ?? rangeHi ?? 0;
  const positionPct =
    rangeLo != null && rangeHi != null && rangeHi > rangeLo
      ? Math.max(0, Math.min(100, ((base - rangeLo) / (rangeHi - rangeLo)) * 100))
      : 0;

  return {
    // 展示用字符串
    immediateSupport: fmtLevel(immediateSupportValue),
    keySupport: fmtLevel(keySupportValue),
    downsideRisk: fmtLevel(downsideRiskValue),
    upperResistance: fmtLevel(upperResistanceValue),
    nextResistance: fmtLevel(nextResistanceValue),
    // 文案拼接用的数值
    immediateSupportValue,
    keySupportValue,
    downsideRiskValue,
    upperResistanceValue,
    nextResistanceValue,
    positionPct,
  };
}

function tradePlan(snapshot: IndicatorSnapshotDto, current?: number) {
  const levels = keyLevels(snapshot, current);
  const plan = snapshot.plan;

  const price = current ?? snapshot.ema25;
  const atrPct = price > 0 ? price * 0.005 : 0; // 动态 ATR% ≈ 0.5%
  const zone = atrPct * 1.5; // 进场区带宽 = 1.5×ATR

  // ── 动态触发条件 ──
  const longNearSupport =
    levels.immediateSupportValue != null && price <= levels.immediateSupportValue * 1.02;
  const longRsiOk = snapshot.rsi14 > 50;
  const longMacdOk = snapshot.macd.hist > 0;
  const longVolOk = snapshot.obv.volumeRatio >= 0.8;
  const longObvInflow = snapshot.obv.flow === 'INFLOW';
  const longNoBearDivergence = snapshot.obv.volumeRatio < 2.0 || snapshot.obv.flow !== 'OUTFLOW'; // 无巨量出货

  const shortNearResistance =
    levels.upperResistanceValue != null && price >= levels.upperResistanceValue * 0.98;
  const shortRsiOk = snapshot.rsi14 < 50;
  const shortMacdOk = snapshot.macd.hist < 0;
  const shortVolOk = snapshot.obv.volumeRatio >= 0.8;
  const shortObvOutflow = snapshot.obv.flow === 'OUTFLOW';

  // ── 动作：只能来自引擎 plan ──
  const action = plan ? (plan.side === 'LONG' ? '做多' : '做空') : '观望';

  // ── 做多进场区 ──
  const longZoneHi = levels.immediateSupportValue ?? price;
  const longZoneLo = longZoneHi - zone;
  const longEntry = (longZoneHi + longZoneLo) / 2;
  const longSL = levels.keySupportValue ?? longZoneLo - zone * 0.5;
  const longTP1 = levels.immediateSupportValue && levels.upperResistanceValue
    ? (levels.immediateSupportValue + levels.upperResistanceValue) / 2
    : longEntry + atrPct * 2;
  const longTP2 = levels.upperResistanceValue ?? longEntry + atrPct * 3;
  const longRR = longSL > 0
    ? Math.round(((longTP1 - longEntry) / (longEntry - longSL)) * 100) / 100
    : 0;

  // ── 做空进场区 ──
  const shortZoneLo = levels.upperResistanceValue ?? price;
  const shortZoneHi = shortZoneLo + zone;
  const shortEntry = (shortZoneLo + shortZoneHi) / 2;
  const shortSL = shortZoneHi + zone * 0.5;
  const shortTP1 = levels.keySupportValue ?? shortEntry - atrPct * 2;
  const shortTP2 = levels.downsideRiskValue ?? shortEntry - atrPct * 3;
  const shortRR = shortSL > 0
    ? Math.round(((shortEntry - shortTP1) / (shortSL - shortEntry)) * 100) / 100
    : 0;

  return {
    action,
    long: [
      `价格接近最近支撑（${levels.immediateSupport}）${longNearSupport ? '✓' : '✗'}`,
      `站上 ${levels.upperResistance} 突破确认`,
      `量价无背离，量比≥0.8${longVolOk ? ' ✓' : ' ✗'}${!longNoBearDivergence ? ' · 巨量出货⚠️' : ''}`,
      longObvInflow ? 'OBV 流入 ✓' : '等 OBV 流入 ✗',
      `RSI > 50，当前 ${snapshot.rsi14.toFixed(1)} ${longRsiOk ? '✓' : '✗'}`,
      longMacdOk ? 'MACD 柱线已转正 ✓' : '等 MACD 柱线转正 ✗',
    ],
    short: [
      `价格接近最近阻力（${levels.upperResistance}）${shortNearResistance ? '✓' : '✗'}`,
      `跌破 ${levels.immediateSupport} 确认转弱`,
      `放量确认，量比≥0.8${shortVolOk ? ' ✓' : ' ✗'}`,
      shortObvOutflow ? 'OBV 流出 ✓' : '等 OBV 流出 ✗',
      `RSI < 50，当前 ${snapshot.rsi14.toFixed(1)} ${shortRsiOk ? '✓' : '✗'}`,
      shortMacdOk ? 'MACD 柱线已转负 ✓' : '等 MACD 柱线转负 ✗',
    ],
    longPlan: {
      entryLow: fmtLevel(longZoneLo),
      entryHigh: fmtLevel(longZoneHi),
      sl: fmtLevel(longSL),
      tp1: fmtLevel(longTP1),
      tp2: fmtLevel(longTP2),
      rr: longRR.toFixed(2),
    },
    shortPlan: {
      entryLow: fmtLevel(shortZoneLo),
      entryHigh: fmtLevel(shortZoneHi),
      sl: fmtLevel(shortSL),
      tp1: fmtLevel(shortTP1),
      tp2: fmtLevel(shortTP2),
      rr: shortRR.toFixed(2),
    },
    invalidation: `失效条件：站上 ${levels.upperResistance} 空头失效；跌破 ${levels.downsideRisk} 多头失效`,
  };
}

function riskLevel(l: 'low' | 'medium' | 'high' | 'extreme'): { badge: string; color: string; bg: string; border: string; label: string } {
  switch (l) {
    case 'low': return { badge: '🟢', color: 'text-up', bg: 'bg-up/10', border: 'border-up/40', label: '低风险' };
    case 'medium': return { badge: '🟡', color: 'text-gold', bg: 'bg-gold/10', border: 'border-gold/40', label: '中风险' };
    case 'high': return { badge: '🔴', color: 'text-down', bg: 'bg-down/10', border: 'border-down/40', label: '高风险' };
    case 'extreme': return { badge: '⚫', color: 'text-gray-300', bg: 'bg-gray-500/10', border: 'border-gray-500/50', label: '极高风险' };
  }
}

function riskAssessment(snapshot: IndicatorSnapshotDto, current?: number, fundingRate?: number) {
  const levels = keyLevels(snapshot, current);
  const ema = snapshot.emaStructure;
  const { dif, dea, hist, signal } = snapshot.macd;
  const rsi = snapshot.rsi14;
  // 超买/超卖一律用引擎的 rsiZone 判定，避免与"核心依据"面板在阈值边界给出相反结论
  const overbought = snapshot.rsiZone === 'OVERBOUGHT';
  const oversold = snapshot.rsiZone === 'OVERSOLD';
  const f = fundingBias(fundingRate);

  // ── 三指标共振多：EMA多头 + MACD红柱零轴上 + RSI 50~未超买 ──
  if (ema === 'BULLISH' && hist > 0 && dif > 0 && rsi >= 50 && !overbought) {
    return {
      level: 'low' as const,
      state: '三指标共振多',
      risk: '趋势末端追高、RSI进入超买后动能突然衰竭、止损放均线下方过宽',
      action: `回踩EMA20/50做多，不追高。RSI 超买后减仓，跌破${levels.keySupport}止损`,
    };
  }

  // ── 三指标共振空：EMA空头 + MACD绿柱零轴下 + RSI 未超卖~50 ──
  if (ema === 'BEARISH' && hist < 0 && dif < 0 && rsi <= 50 && !oversold) {
    return {
      level: 'low' as const,
      state: '三指标共振空',
      risk: '超卖后追空、逼空反弹、空头拥挤导致踩踏',
      action: `反弹至EMA20/50做空，不追空。RSI 超卖后减仓，站上${levels.upperResistance}止损`,
    };
  }

  // ── 方向多但时机错：EMA多头 + RSI超买 + MACD红柱收缩/死叉 ──
  if (ema === 'BULLISH' && overbought && (signal === 'DEATH_CROSS' || hist < 0)) {
    return {
      level: 'high' as const,
      state: '方向多，时机错',
      risk: '追多被套、假突破、均值回归至EMA20/50、日线超买后回调',
      action: '不追多。等回踩，观察RSI回落至50–60再评估',
    };
  }

  // ── 方向空但时机错：EMA空头 + RSI超卖 + MACD绿柱收缩/金叉 ──
  if (ema === 'BEARISH' && oversold && (signal === 'GOLDEN_CROSS' || hist > 0)) {
    return {
      level: 'high' as const,
      state: '方向空，时机错',
      risk: '追空被反弹、空头回补、超卖反弹',
      action: '不追空。等反弹，观察RSI回升至40–50再评估',
    };
  }

  // ── 假突破结构：EMA纠缠 + RSI超买 + MACD柱线收缩 ──
  if (ema === 'MIXED' && overbought && Math.abs(hist) < Math.abs(dif) * 0.3) {
    return {
      level: 'extreme' as const,
      state: '假突破结构',
      risk: '追突破被反杀、流动性真空、插针扫损',
      action: '禁止追单。等回踩确认或直接观望',
    };
  }

  // ── 超卖假突破结构：EMA纠缠 + RSI超卖 + MACD柱线收缩 ──
  if (ema === 'MIXED' && oversold && Math.abs(hist) < Math.abs(dif) * 0.3) {
    return {
      level: 'extreme' as const,
      state: '假突破结构',
      risk: '追空被反杀、流动性真空、插针扫损',
      action: '禁止追单。等回踩确认或直接观望',
    };
  }

  // ── 趋势可能转弱：EMA多头 + MACD死叉 + RSI下穿50 ──
  if (ema === 'BULLISH' && signal === 'DEATH_CROSS' && rsi < 50) {
    return {
      level: 'high' as const,
      state: '趋势可能转弱',
      risk: '滞后多头信号会放大回撤、方向即将反转',
      action: `减多，观察是否演变为空头排列，跌破${levels.keySupport}清仓`,
    };
  }

  // ── 趋势可能转强：EMA空头 + MACD金叉 + RSI上穿50 ──
  if (ema === 'BEARISH' && signal === 'GOLDEN_CROSS' && rsi > 50) {
    return {
      level: 'high' as const,
      state: '趋势可能转强',
      risk: '滞后空头信号会放大反弹、方向即将反转',
      action: `减空，观察是否演变为多头排列，站上${levels.upperResistance}清仓`,
    };
  }

  // ── 极端资金费率 + 指标冲突 ──
  if (ema === 'BULLISH' && f === 'short') {
    return {
      level: 'medium' as const,
      state: 'EMA多头 + 资金偏空',
      risk: '方向与资金面冲突，多头拥挤度可能虚高',
      action: '方向对但位置存疑，降低仓位，等资金面回归一致',
    };
  }
  if (ema === 'BEARISH' && f === 'long') {
    return {
      level: 'medium' as const,
      state: 'EMA空头 + 资金偏多',
      risk: '方向与资金面冲突，空头拥挤度可能虚高',
      action: '方向对但位置存疑，降低仓位，等资金面回归一致',
    };
  }

  // ── 震荡无趋势：EMA纠缠 + MACD零轴粘合 + RSI 40–60 ──
  if (ema === 'MIXED' && Math.abs(dif) < 0.01 * Math.max(Math.abs(dif + dea), 0.001) && rsi >= 40 && rsi <= 60) {
    return {
      level: 'medium' as const,
      state: '震荡无趋势',
      risk: '假信号频繁、来回止损、手续费磨损、突破失败',
      action: '不做。等放量突破后再评估',
    };
  }

  // ── EMA纠缠 + 非中性RSI ──
  if (ema === 'MIXED') {
    if (overbought) {
      return { level: 'medium' as const, state: '震荡偏热', risk: '方向未明但位置过热，追多赔率差', action: '不追多。等RSI回落至50–60再评估' };
    }
    if (oversold) {
      return { level: 'medium' as const, state: '震荡偏冷', risk: '方向未明但位置超卖，追空赔率差', action: '不追空。等RSI回升至40–50再评估' };
    }
    return { level: 'medium' as const, state: '震荡等待', risk: '均线缠绕，突破需放量确认', action: '不做。等方向选择后再入场' };
  }

  // ── 默认：EMA多头无明确共振 ──
  if (ema === 'BULLISH') {
    const fStr = f === 'long' ? '，资金偏多' : f === 'short' ? '，资金偏空' : '';
    return {
      level: 'medium' as const,
      state: 'EMA多头，动能未共振',
      risk: `方向偏多但动能未确认${fStr}，假信号风险较高`,
      action: `等待MACD红柱扩张+RSI>50确认，跌破${levels.keySupport}取消追多`,
    };
  }

  // ── 默认：EMA空头无明确共振 ──
  if (ema === 'BEARISH') {
    const fStr = f === 'short' ? '，资金偏空' : f === 'long' ? '，资金偏多' : '';
    return {
      level: 'medium' as const,
      state: 'EMA空头，动能未共振',
      risk: `方向偏空但动能未确认${fStr}，反弹随时出现`,
      action: `等待MACD绿柱扩张+RSI<50确认，站上${levels.upperResistance}取消追空`,
    };
  }

  return {
    level: 'medium' as const,
    state: '指标未形成明确共识',
    risk: '方向、动能、位置三者未共振，假信号风险高',
    action: '不提前押注，等突破+回踩确认后入场',
  };
}

// 统一使用 shared 的固定偏移实现（原先是手写 UTC+8，与宏观页的 toLocaleString 各成一套）
const renderTime = formatBeijingTime;

export function Detail() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const symbol = params.get('symbol') || 'BTC_USDT';

  const [interval, setInterval] = useState<'1m' | '5m' | '15m'>('15m');
  const [candles, setCandles] = useState<CandleDto[]>([]);
  const [snapshot, setSnapshot] = useState<IndicatorSnapshotDto | null>(null);
  const [ticker, setTicker] = useState<TickerDto | null>(null);
  const storeFunding = useWatchlistStore((s) => s.funding[symbol]);
  const setFundingStore = useWatchlistStore((s) => s.setFunding);
  const [funding, setFunding] = useState<FundingRateDto | null>(storeFunding ?? null);
  const [ai, setAi] = useState<AiStrategyDto | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState('');
  const [lastRegen, setLastRegen] = useState(0);
  const [nowTick, setNowTick] = useState(() => Date.now());

  const loadTicker = useCallback(async () => {
    try {
      const t = await api.getTicker(symbol).catch(() => null);
      if (t) setTicker(t);
    } catch {
      // ignore
    }
  }, [symbol]);

  const loadCandles = useCallback(async () => {
    try {
      const c = await api.getCandles(symbol, interval).catch(() => null);
      if (c) {
        setCandles(c.candles);
        setSnapshot(c.snapshot);
      }
    } catch {
      // ignore
    }
  }, [symbol, interval]);

  const loadFunding = useCallback(async () => {
    try {
      const f = await api.getFunding(symbol).catch(() => null);
      if (f) {
        setFunding(f);
        setFundingStore(symbol, f);
      }
    } catch {
      // ignore
    }
  }, [symbol, setFundingStore]);

  usePolling(loadTicker, 3000);
  usePolling(loadCandles, 15000);
  usePolling(loadFunding, 60000);

  const generateAi = useCallback(
    async (force = false) => {
      if (!ticker || !snapshot || aiLoading) return;
      // 60s 冷却防刷（dev.md 5.3）。首次自动生成不受冷却限制。
      if (!force && ai && Date.now() - lastRegen < AI_REGEN_COOLDOWN_MS) return;
      setAiLoading(true);
      setAiError('');
      setLastRegen(Date.now());
      try {
        const result = await api.getAiStrategy({
          symbol,
          interval,
          ticker: { last: ticker.last, change24h: ticker.change24h },
          snapshot,
        });
        setAi(result);
      } catch (e) {
        setAiError(e instanceof Error ? e.message : 'AI 请求失败');
      } finally {
        setAiLoading(false);
      }
    },
    [symbol, interval, ticker, snapshot, lastRegen, ai, aiLoading],
  );

  // 首次进入或切换 symbol/interval 时自动生成一次（结果会被渲染出来，不再是白烧额度）
  useEffect(() => {
    setAi(null);
    setAiError('');
  }, [symbol, interval]);

  useEffect(() => {
    if (ticker && snapshot && !ai && !aiLoading) {
      generateAi(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker, snapshot, symbol, interval]);

  // 冷却倒计时（仅用于按钮文案）
  // 注意：本组件内 `setInterval` 已被周期 state 的 setter 遮蔽（见上方 useState），
  // 因此必须显式走 window.setInterval，否则拿到的是 state setter（只接受 1 个参数）。
  useEffect(() => {
    const t = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const regenRemainMs = Math.max(0, AI_REGEN_COOLDOWN_MS - (nowTick - lastRegen));
  const canRegen = !aiLoading && !!ai && regenRemainMs <= 0;

  const tp = snapshot ? tradePlan(snapshot, ticker?.last) : null;

  return (
    <div className="min-h-screen bg-bg text-text p-4">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <button onClick={() => navigate('/')} className="text-gold text-sm hover:underline">
            ← 返回监控面板
          </button>
          <h1 className="text-xl font-bold text-white">{symbol}</h1>
          <div className="flex gap-1">
            {(['1m', '5m', '15m'] as const).map((tf) => (
              <button
                key={tf}
                onClick={() => setInterval(tf)}
                className={`px-2 py-1 text-xs rounded ${interval === tf ? 'bg-gold text-black' : 'bg-card text-gray-400 hover:text-white'}`}
              >
                {tf}
              </button>
            ))}
          </div>
        </div>

        {ticker && (
          <div className="bg-card border border-cardborder rounded-lg p-3 mb-4 flex gap-6 text-sm flex-wrap">
            <div>
              <span className="text-gray-500">最新价 </span>
              <span className="text-text font-mono font-semibold">{fmtPrice(ticker.last)}</span>
            </div>
            <div>
              <span className="text-gray-500">24h涨跌 </span>
              <span className={ticker.change24h >= 0 ? 'text-up' : 'text-down'}>
                {ticker.change24h >= 0 ? '+' : ''}{(ticker.change24h * 100).toFixed(2)}%
              </span>
            </div>
            <div>
              <span className="text-gray-500">24h高 </span>
              <span className="text-white font-mono">{fmtPrice(ticker.high24h)}</span>
            </div>
            <div>
              <span className="text-gray-500">24h低 </span>
              <span className="text-white font-mono">{fmtPrice(ticker.low24h)}</span>
            </div>
            <div>
              <span className="text-gray-500">24h额 </span>
              <span className="text-white font-mono">
                {ticker.volume24h > 0 ? `${(ticker.volume24h / 1e6).toFixed(1)}M` : '--'}
              </span>
            </div>
          </div>
        )}

        {candles.length > 0 && snapshot && (
          <div className="bg-card border border-cardborder rounded-lg p-3 mb-4">
            <KlineChart candles={candles} snapshot={snapshot} />
          </div>
        )}

        {snapshot && (
          <div className="bg-card border border-cardborder rounded-lg p-4 mb-4">
            <h2 className="text-white font-semibold mb-3">决策面板</h2>

            <div className="rounded-lg bg-black/20 border border-cardborder p-3 text-sm mb-4">
              <div className="flex items-center justify-between gap-3 mb-2">
                <div className="text-gray-500 text-xs">10 秒结论</div>
                <div className="text-gray-500 text-xs">周期 {interval} · 数据 {ticker ? renderTime(ticker.ts) : '--'}</div>
              </div>
              <div className="text-white whitespace-pre-line">{decisionSummary(snapshot, symbol, ticker?.last, funding?.fundingRate)}</div>
            </div>

            <div className="mb-4">
              <div className="text-gray-500 text-xs mb-2">核心依据</div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
                {decisionBasis(snapshot, ticker?.last).map((item, idx) => (
                  <div key={idx} className="rounded-lg border border-cardborder bg-black/10 p-3 text-sm">
                    <div className="text-white font-medium mb-1">{item.title}</div>
                    <div className="text-gray-400 text-xs mb-1">{item.detail}</div>
                    <div className="text-gray-300 text-xs">{item.meaning}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="mb-4">
              <div className="flex items-center justify-between gap-3 mb-2">
                <div className="text-gray-500 text-xs">关键价位</div>
                <div className="text-gray-500 text-xs">周期 {interval} · 数据 {ticker ? renderTime(ticker.ts) : '--'}</div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="rounded-lg border border-cardborder bg-black/10 p-3 text-sm space-y-1">
                  <div className="flex justify-between"><span className="text-gray-400">即时支撑</span><span className="text-white">{keyLevels(snapshot, ticker?.last).immediateSupport}</span></div>
                  <div className="flex justify-between"><span className="text-gray-400">关键支撑</span><span className="text-white">{keyLevels(snapshot, ticker?.last).keySupport}</span></div>
                  <div className="flex justify-between"><span className="text-gray-400">下方风险位</span><span className="text-white">{keyLevels(snapshot, ticker?.last).downsideRisk}</span></div>
                  <div className="flex justify-between"><span className="text-gray-400">上方阻力</span><span className="text-white">{keyLevels(snapshot, ticker?.last).upperResistance}</span></div>
                  <div className="mt-2">
                    <div className="relative h-1.5 rounded-full bg-gradient-to-r from-up via-gold to-down">
                      <div className="absolute top-1/2 h-3 w-0.5 bg-white -translate-y-1/2 rounded-full" style={{ left: `${keyLevels(snapshot, ticker?.last).positionPct}%` }} />
                    </div>
                  </div>
                </div>
                <div className="rounded-lg border border-cardborder bg-black/10 p-3 text-sm">
                  <div className="text-white font-semibold mb-2">资金费率</div>
                  <div className="text-white mb-2">{funding ? `${(funding.fundingRate * 100).toFixed(4)}%（年化 ${(funding.fundingRate * 3 * 365 * 100).toFixed(1)}%）` : '--'}</div>
                  {funding && (
                    <>
                      <div className="text-gray-300 text-sm mb-1">{fundingInterpretation(funding.fundingRate).label} · {fundingInterpretation(funding.fundingRate).detail}</div>
                      <div className="text-gray-300 text-sm">{fundingInterpretation(funding.fundingRate).meaning}</div>
                    </>
                  )}
                </div>
              </div>
            </div>

            <div className="mb-4">
              <div className="text-gray-500 text-xs mb-2">交易计划</div>
              <div className="rounded-lg border border-cardborder bg-black/10 p-3 text-sm">
                <div className="mb-3 text-white font-semibold">当前动作: {tp?.action}</div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
                  <div className="border border-up/40 rounded-lg p-3">
                    <div className="text-up font-medium mb-2">做多需满足</div>
                    <ul className="space-y-1 text-gray-300 text-sm list-disc list-inside">
                      {tp?.long.map((line, idx) => (
                        <li key={idx}>{line}</li>
                      ))}
                    </ul>
                    <div className="mt-3 text-xs text-gray-300 space-y-1">
                      <div>进场区：{tp?.longPlan?.entryLow}–{tp?.longPlan?.entryHigh}</div>
                      <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                        <div>目标1：{tp?.longPlan?.tp1}</div>
                        <div>目标2：{tp?.longPlan?.tp2}</div>
                        <div>止损：{tp?.longPlan?.sl}</div>
                        <div>盈亏比：{tp?.longPlan?.rr}</div>
                      </div>
                    </div>
                  </div>
                  <div className="border border-down/40 rounded-lg p-3">
                    <div className="text-down font-medium mb-2">做空需满足</div>
                    <ul className="space-y-1 text-gray-300 text-sm list-disc list-inside">
                      {tp?.short.map((line, idx) => (
                        <li key={idx}>{line}</li>
                      ))}
                    </ul>
                    <div className="mt-3 text-xs text-gray-300 space-y-1">
                      <div>进场区：{tp?.shortPlan?.entryLow}–{tp?.shortPlan?.entryHigh}</div>
                      <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                        <div>目标1：{tp?.shortPlan?.tp1}</div>
                        <div>目标2：{tp?.shortPlan?.tp2}</div>
                        <div>止损：{tp?.shortPlan?.sl}</div>
                        <div>盈亏比：{tp?.shortPlan?.rr}</div>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="mt-3 text-gray-500 text-xs">{tp?.invalidation}</div>
              </div>
            </div>

            <div className="mb-4">
              <div className="text-gray-500 text-xs mb-2">风险提示</div>
              {(() => {
                const ra = riskAssessment(snapshot, ticker?.last, funding?.fundingRate);
                const rl = riskLevel(ra.level);
                return (
                  <div className={`rounded-lg border ${rl.border} ${rl.bg} p-3 text-sm`}>
                    <div className="flex items-center gap-2 mb-2">
                      <span className={rl.color}>{rl.badge}</span>
                      <span className={`text-sm font-medium ${rl.color}`}>{rl.label}</span>
                      <span className="text-white text-sm">{ra.state}</span>
                    </div>
                    <div className="text-gray-400 text-xs mb-1">核心风险</div>
                    <div className="text-gray-300 text-sm mb-2">{ra.risk}</div>
                    <div className="text-gray-400 text-xs mb-1">操作警示</div>
                    <div className="text-gray-300 text-sm">{ra.action}</div>
                  </div>
                );
              })()}
            </div>

            {/* AI 策略面板（dev.md 5.3：Markdown 渲染、禁用 HTML 防 XSS、重新生成 60s 冷却） */}
            <AiPanel
              ai={ai}
              loading={aiLoading}
              error={aiError}
              canRegen={canRegen}
              regenRemainMs={regenRemainMs}
              onRegenerate={() => generateAi(true)}
              generatedAtLabel={ai ? renderTime(ai.generatedAt) : undefined}
            />
          </div>
        )}
      </div>
    </div>
  );
}
