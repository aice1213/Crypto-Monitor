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
  let lastSignal: MacdResult['signal'] = 'NO_SIGNAL';
  /** 距最近一次交叉的根数；99 表示尚无交叉 */
  let barsSinceCross = 99;

  for (let i = 0; i < n; i++) {
    const d = dif[i];
    const e = dea[i];
    const hist = !Number.isNaN(d) && !Number.isNaN(e) ? (d - e) * 2 : NaN;

    let sig: MacdResult['signal'] = 'NO_SIGNAL';
    let age: number | null = null;
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
        barsSinceCross = 0;
        age = 0;
      } else if (death) {
        sig = 'DEATH_CROSS';
        lastSignal = 'DEATH_CROSS';
        barsSinceCross = 0;
        age = 0;
      } else if (barsSinceCross < 3) {
        // 保留期内的"近期信号"：signal 值不变，但 age ≥ 1 表示它不是当根交叉
        sig = lastSignal;
        barsSinceCross++;
        age = barsSinceCross;
      }
    }

    // DEA 尚未就绪（EMA9 of DIF 的预热期）时令 dea = dif，
    // 这样 hist 恒为 0，三个字段之间保持 hist = (dif − dea) × 2 的自洽关系。
    // 原实现把未就绪的 dea 写成 0，会出现 dif=14 / dea=0 / hist=0 这类自相矛盾的三元组。
    const deaOut = Number.isNaN(e) ? (Number.isNaN(d) ? 0 : d) : e;
    result.push({
      dif: Number.isNaN(d) ? 0 : d,
      dea: deaOut,
      hist: Number.isNaN(hist) ? 0 : hist,
      signal: sig,
      signalAge: age,
    });
  }
  return result;
}
