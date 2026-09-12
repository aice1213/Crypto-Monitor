/**
 * EMA 指数移动平均
 * ema[i] = k * close[i] + (1-k) * ema[i-1], k = 2/(n+1)
 * 首值用前 n 根 SMA 初始化
 */
export function ema(values: number[], period: number): number[] {
  const n = values.length;
  if (n === 0 || period <= 0) return [];
  const k = 2 / (period + 1);
  const result: number[] = new Array(n).fill(NaN);

  if (n < period) {
    let prev = values[0];
    result[0] = prev;
    for (let i = 1; i < n; i++) {
      prev = k * values[i] + (1 - k) * prev;
      result[i] = prev;
    }
    return result;
  }

  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  result[period - 1] = prev;
  for (let i = period; i < n; i++) {
    prev = k * values[i] + (1 - k) * prev;
    result[i] = prev;
  }
  return result;
}

/**
 * 简单移动平均 SMA
 */
export function sma(values: number[], period: number): number[] {
  const n = values.length;
  const result: number[] = new Array(n).fill(NaN);
  if (n < period || period <= 0) return result;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  result[period - 1] = sum / period;
  for (let i = period; i < n; i++) {
    sum += values[i] - values[i - period];
    result[i] = sum / period;
  }
  return result;
}

/**
 * 线性回归斜率
 */
export function linearRegressionSlope(values: number[], window: number): number {
  const n = Math.min(window, values.length);
  if (n < 2) return 0;
  const slice = values.slice(-n);
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i++) {
    const v = slice[i];
    sumX += i;
    sumY += v;
    sumXY += i * v;
    sumXX += i * i;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}
