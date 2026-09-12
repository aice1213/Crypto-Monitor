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
    const prev = candles[i - 1];
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
