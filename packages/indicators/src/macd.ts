import type { MacdResult } from '@crypto-monitor/shared';
import { ema } from './ema.js';
import { atr } from './atr.js';

/**
 * MACD(12,26,9)
 * DIF = EMA12 - EMA26; DEA = EMA9(DIF); hist = (DIF - DEA) * 2
 *
 * 金叉: dif[t-1] <= dea[t-1] && dif[t] > dea[t] && hist[t] > 0 && |dif[t]| <= ATR14 * 0.5
 * 死叉对称。仅标记交叉当根，之后 3 根内保留"近期信号"。
 */
export function macd(
  highs: number[],
  lows: number[],
  closes: number[],
  fast = 12,
  slow = 26,
  signal = 9,
): MacdResult[] {
  const n = closes.length;
  const result: MacdResult[] = [];
  if (n === 0) return result;

  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const dif: number[] = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (!Number.isNaN(emaFast[i]) && !Number.isNaN(emaSlow[i])) {
      dif[i] = emaFast[i] - emaSlow[i];
    }
  }

  const validDifStart = dif.findIndex((v) => !Number.isNaN(v));
  const dea: number[] = new Array(n).fill(NaN);
  if (validDifStart >= 0) {
    const difSlice = dif.slice(validDifStart);
    const deaSlice = ema(difSlice, signal);
    for (let i = 0; i < deaSlice.length; i++) {
      dea[validDifStart + i] = deaSlice[i];
    }
  }

  const atrArr = atr(highs, lows, closes, 14);
  let lastSignal: MacdResult['signal'] = 'NONE';
  let signalAge = 99;

  for (let i = 0; i < n; i++) {
    const d = dif[i];
    const e = dea[i];
    const hist = !Number.isNaN(d) && !Number.isNaN(e) ? (d - e) * 2 : NaN;

    let sig: MacdResult['signal'] = 'NONE';
    if (
      i > 0 &&
      !Number.isNaN(d) &&
      !Number.isNaN(e) &&
      !Number.isNaN(dif[i - 1]) &&
      !Number.isNaN(dea[i - 1])
    ) {
      const atrVal = atrArr[i];
      const nearZero = Number.isNaN(atrVal) || Math.abs(d) <= atrVal * 0.5;
      const golden = dif[i - 1] <= dea[i - 1] && d > e && hist > 0 && nearZero;
      const death = dif[i - 1] >= dea[i - 1] && d < e && hist < 0 && nearZero;
      if (golden) {
        sig = 'GOLDEN_CROSS';
        lastSignal = 'GOLDEN_CROSS';
        signalAge = 0;
      } else if (death) {
        sig = 'DEATH_CROSS';
        lastSignal = 'DEATH_CROSS';
        signalAge = 0;
      } else if (signalAge < 3) {
        sig = lastSignal;
        signalAge++;
      }
    }

    result.push({
      dif: Number.isNaN(d) ? 0 : d,
      dea: Number.isNaN(e) ? 0 : e,
      hist: Number.isNaN(hist) ? 0 : hist,
      signal: sig,
    });
  }
  return result;
}
