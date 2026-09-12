/**
 * ATR 平均真实波幅（Wilder 平滑）
 */
export function atr(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 14,
): number[] {
  const n = closes.length;
  const result: number[] = new Array(n).fill(NaN);
  if (n < period + 1) return result;

  const tr: number[] = new Array(n).fill(0);
  tr[0] = highs[0] - lows[0];
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    );
  }

  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  let prev = sum / period;
  result[period] = prev;
  for (let i = period + 1; i < n; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    result[i] = prev;
  }
  return result;
}
