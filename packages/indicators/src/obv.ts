import type { ObvResult, ObvFlow } from '@crypto-monitor/shared';
import { sma, linearRegressionSlope } from './ema.js';

function volumeMetrics(volumes: number[]): { ratio: number; avg20ChangePct: number } {
  if (volumes.length === 0) return { ratio: 1, avg20ChangePct: 0 };
  const current = volumes[volumes.length - 1] ?? 0;
  const window = volumes.slice(-20);
  const avg20 = window.reduce((a, b) => a + b, 0) / window.length;
  const ratio = avg20 > 0 ? current / avg20 : 1;
  const avg20ChangePct = avg20 > 0 ? (current - avg20) / avg20 * 100 : 0;
  return { ratio, avg20ChangePct };
}

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
    const { ratio, avg20ChangePct } = volumeMetrics(volumes.slice(0, i + 1));
    let flow: ObvFlow = 'BALANCED';
    if (!Number.isNaN(ma20[i])) {
      if (obvArr[i] > ma20[i] && slope > 0) flow = 'INFLOW';
      else if (obvArr[i] < ma20[i] && slope < 0) flow = 'OUTFLOW';
    }
    result.push({
      value: obvArr[i],
      ma20: Number.isNaN(ma20[i]) ? obvArr[i] : ma20[i],
      flow,
      volumeRatio: ratio,
      volumeAvg20ChangePct: avg20ChangePct,
    });
  }
  return result;
}
