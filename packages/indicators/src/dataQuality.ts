import type { CandleDto, DataQuality } from '@crypto-monitor/shared';
import { INSUFFICIENT_CANDLE_COUNT } from '@crypto-monitor/shared';

/**
 * 数据质量评估与预处理（dev.md 4.4）
 */
export function assessDataQuality(
  candles: CandleDto[],
  intervalSec: number,
): { candles: CandleDto[]; dataQuality: DataQuality } {
  if (candles.length < INSUFFICIENT_CANDLE_COUNT) {
    return { candles, dataQuality: 'INSUFFICIENT' };
  }

  let gapCount = 0;
  const total = candles.length - 1;
  const processed: CandleDto[] = [];

  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      processed.push({ ...candles[i] });
      continue;
    }
    // 与**已修正**的上一根比较，而不是原始上一根。
    // 否则一根错误报价（如 100 → 130）会把紧随其后的恢复根（130 → 100）也判为 >15% 跳变，
    // 于是一次异常连坐两根；用修正后的前收（100）比较则恢复根涨幅为 0，不再被误杀。
    const prev = processed[i - 1]!;
    const curr = candles[i];
    const expectedTime = prev.time + intervalSec;
    const isGap = curr.time > expectedTime + intervalSec * 0.5;

    if (isGap) {
      gapCount++;
    }

    const pctChange = Math.abs(curr.close - prev.close) / prev.close;
    if (pctChange > 0.15) {
      processed.push({
        ...curr,
        open: prev.close,
        high: Math.max(prev.close, curr.close),
        low: Math.min(prev.close, curr.close),
        close: prev.close,
        volume: 0,
      });
    } else {
      processed.push({ ...curr });
    }
  }

  const gapRatio = total > 0 ? gapCount / total : 0;
  let dataQuality: DataQuality = 'FULL';
  if (gapRatio > 0.2) {
    dataQuality = 'INSUFFICIENT';
  } else if (gapCount > 0) {
    dataQuality = 'GAPS_FILLED';
  }

  return { candles: processed, dataQuality };
}
