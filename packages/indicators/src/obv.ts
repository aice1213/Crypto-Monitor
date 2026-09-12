import type { ObvResult, ObvFlow } from '@crypto-monitor/shared';
import { sma, linearRegressionSlope } from './ema.js';

/**
 * OBV 能量潮
 * obv += sign(close - prevClose) * volume
 * MA20 = OBV 的 20 周期 SMA
 * 流入/流出：比较 MA20 外，要求 OBV 的 5 周期斜率同号
 */
export function obv(closes: number[], volumes: number[]): ObvResult[] {
  const n = closes.length;
  const result: ObvResult[] = [];
  if (n === 0) return result;

  const obvArr: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const diff = closes[i] - closes[i - 1];
    const sign = diff > 0 ? 1 : diff < 0 ? -1 : 0;
    obvArr[i] = obvArr[i - 1] + sign * volumes[i];
  }

  const ma20 = sma(obvArr, 20);

  for (let i = 0; i < n; i++) {
    const slope = linearRegressionSlope(obvArr.slice(0, i + 1), 5);
    let flow: ObvFlow = 'BALANCED';
    if (!Number.isNaN(ma20[i])) {
      if (obvArr[i] > ma20[i] && slope > 0) flow = 'INFLOW';
      else if (obvArr[i] < ma20[i] && slope < 0) flow = 'OUTFLOW';
    }
    result.push({
      value: obvArr[i],
      ma20: Number.isNaN(ma20[i]) ? obvArr[i] : ma20[i],
      flow,
    });
  }
  return result;
}
