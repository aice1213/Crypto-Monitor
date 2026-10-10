/**
 * RSI(14) Wilder 平滑
 *
 * 边界：`avgLoss === 0` 时 RSI 为 100（纯上涨）；但**两者同时为 0**（完全横盘、
 * 无涨无跌）时定义为 50（中性），否则会被误判为"超买"并扣分。
 */
function rsiFromAverages(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

export function rsi(closes: number[], period = 14): number[] {
  const n = closes.length;
  const result: number[] = new Array(n).fill(NaN);
  if (n <= period) return result;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  result[period] = rsiFromAverages(avgGain, avgLoss);

  for (let i = period + 1; i < n; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    result[i] = rsiFromAverages(avgGain, avgLoss);
  }
  return result;
}
