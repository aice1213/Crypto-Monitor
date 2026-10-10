import type { AlertSnapshotDto } from '@crypto-monitor/shared';
import { rsiZone } from '@crypto-monitor/indicators';

/**
 * 监控卡片的**行文案生成逻辑**（纯函数，可单测）。
 *
 * 从 `components/Card/MonitorCard.tsx` 抽出，原因是这些函数承载了
 * "文案必须与状态判定同源"这一强约束（dev.md 5.1.1），
 * 而组件本身没有测试运行环境，关键一致性回归无法被锁住。
 */

export type SentimentTone = 'neutral' | 'warn';
export type VolumePriceTone = 'neutral' | 'warn';
export type TfTone = 'neutral' | 'warn' | 'good';
export type RsiTone = 'neutral' | 'danger' | 'good';

/**
 * 情绪行文案。
 *
 * 是否警示**只由 `fundingSignal` 决定**，与顶部预警徽标（hasAlert）同源，
 * 因此不可能出现"行内挂 ⚠ 而徽标显示平稳"的矛盾。
 * rate/ratio 仅用于在未达拥挤阈值时做中性描述，不产生任何警示。
 */
export function sentimentLine(
  signal: AlertSnapshotDto['fundingSignal'],
  rate: number,
  ratio: number,
): { text: string; tone: SentimentTone } {
  if (signal === 'LONG_HEAVY') return { text: '多头拥挤，谨慎追高', tone: 'warn' };
  if (signal === 'SHORT_HEAVY') return { text: '空头拥挤，谨慎杀跌', tone: 'warn' };

  // fundingSignal === 'NEUTRAL'：仅中性描述，绝不挂警示
  if (ratio >= 1.5) return { text: '账户口径偏多', tone: 'neutral' };
  if (ratio <= 0.8) return { text: '账户口径偏空', tone: 'neutral' };
  if (rate > 0) return { text: '多方小幅溢价', tone: 'neutral' };
  if (rate < 0) return { text: '空方小幅溢价', tone: 'neutral' };
  return { text: '多空分布中性', tone: 'neutral' };
}

/**
 * 量价行文案（dev.md 5.1.1：无背离显示"量价正常"灰字）。
 *
 * 只有真实背离才产生警示；量比只作中性信息补充。
 * `changePct` 必须是**价格**涨跌幅，不能用成交量变化冒充。
 */
export function volumePriceLine(
  divergence: AlertSnapshotDto['volumePriceDivergence'],
  volumeRatio: number,
  changePct: number,
): { text: string; tone: VolumePriceTone } {
  if (divergence === 'BEARISH_DIVERGENCE') {
    return { text: '价涨量缩，顶背离，防冲高回落', tone: 'warn' };
  }
  if (divergence === 'BULLISH_DIVERGENCE') {
    return { text: '价跌量增，底背离，防超跌反抽', tone: 'warn' };
  }

  // 无背离 —— 以下均为中性描述，不产生警示
  if (!Number.isFinite(volumeRatio) || volumeRatio <= 0.5) {
    return { text: `量价正常（量能偏低，${changePct >= 0 ? '上涨' : '下跌'}待确认）`, tone: 'neutral' };
  }
  if (volumeRatio < 0.8) {
    return { text: '量价正常（缩量）', tone: 'neutral' };
  }
  if (volumeRatio <= 1.2) {
    return { text: '量价正常', tone: 'neutral' };
  }
  return { text: '量价正常（放量，波动放大）', tone: 'neutral' };
}

/** 多周期行（dev.md 5.1.1 标签为「多周期:」） */
export function tfLine(
  state: AlertSnapshotDto['multiTfState'],
  conflict: boolean,
): { text: string; tone: TfTone } {
  if (state === 'BULL_ALIGN') return { text: '趋势向上，顺势关注', tone: 'good' };
  if (state === 'BEAR_ALIGN') return { text: '趋势向下，顺势关注', tone: 'good' };
  if (state === 'RANGE_ALIGN') return { text: '横盘区间，不做趋势', tone: 'neutral' };
  if (state === 'CONFLICT' || conflict) return { text: '方向冲突，观望', tone: 'warn' };
  return { text: '多周期待确认', tone: 'neutral' };
}

/**
 * RSI 行（dev.md 5.1.1：≥70 红 / ≤30 绿）。
 * 超买超卖区间判定复用引擎的 `rsiZone()`，保证卡面与 `extremeAlert`、评分口径完全一致。
 */
export function rsiLine(rsi: number): { text: string; tone: RsiTone } {
  const zone = rsiZone(rsi);
  if (zone === 'OVERBOUGHT') return { text: `RSI ${rsi.toFixed(1)} · 超买`, tone: 'danger' };
  if (zone === 'OVERSOLD') return { text: `RSI ${rsi.toFixed(1)} · 超卖`, tone: 'good' };
  return { text: `RSI ${rsi.toFixed(1)} · 中性`, tone: 'neutral' };
}
