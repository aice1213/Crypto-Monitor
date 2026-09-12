import type { CandleDto } from '@crypto-monitor/shared';
import { ema } from './ema.js';

interface Cluster {
  center: number;
  totalVolume: number;
  count: number;
}

/**
 * 支撑/阻力位计算（dev.md 4.2）
 */
export function supportResistance(
  candles: CandleDto[],
  ema99Last: number,
): { support: number[]; resistance: number[] } {
  if (candles.length === 0) return { support: [], resistance: [] };

  const slice = candles.slice(-100);
  const currentPrice = slice[slice.length - 1].close;
  const window = 3;

  const resistanceCands: { price: number; volume: number }[] = [];
  const supportCands: { price: number; volume: number }[] = [];

  for (let i = window; i < slice.length - window; i++) {
    let isResistance = true;
    let isSupport = true;
    for (let j = i - window; j <= i + window; j++) {
      if (j === i) continue;
      if (slice[j].high >= slice[i].high) isResistance = false;
      if (slice[j].low <= slice[i].low) isSupport = false;
    }
    if (isResistance) resistanceCands.push({ price: slice[i].high, volume: slice[i].volume });
    if (isSupport) supportCands.push({ price: slice[i].low, volume: slice[i].volume });
  }

  const cluster = (cands: { price: number; volume: number }[]): number[] => {
    if (cands.length === 0) return [];
    const sorted = [...cands].sort((a, b) => a.price - b.price);
    const clusters: Cluster[] = [];
    const band = 0.003;
    for (const c of sorted) {
      const last = clusters[clusters.length - 1];
      if (last && Math.abs(c.price - last.center) / last.center <= band) {
        last.center =
          (last.center * last.totalVolume + c.price * c.volume) / (last.totalVolume + c.volume);
        last.totalVolume += c.volume;
        last.count++;
      } else {
        clusters.push({ center: c.price, totalVolume: c.volume, count: 1 });
      }
    }
    return clusters.map((c) => c.center);
  };

  let supports = cluster(supportCands).filter((p) => p < currentPrice);
  let resistances = cluster(resistanceCands).filter((p) => p > currentPrice);

  supports.sort((a, b) => b - a);
  resistances.sort((a, b) => a - b);

  supports = supports.slice(0, 3);
  resistances = resistances.slice(0, 3);

  const dynamicUp = currentPrice * 1.008;
  const dynamicDown = currentPrice * 0.992;
  if (resistances.length < 3 && dynamicUp > currentPrice) resistances.push(dynamicUp);
  if (supports.length < 3 && dynamicDown < currentPrice) supports.push(dynamicDown);

  if (resistances.length < 3) {
    const emaUp = ema99Last > currentPrice ? ema99Last : ema99Last * 1.008;
    if (emaUp > currentPrice) resistances.push(emaUp);
  }
  if (supports.length < 3) {
    const emaDown = ema99Last < currentPrice ? ema99Last : ema99Last * 0.992;
    if (emaDown < currentPrice) supports.push(emaDown);
  }

  resistances.sort((a, b) => a - b);
  supports.sort((a, b) => b - a);

  return {
    support: supports.slice(0, 3),
    resistance: resistances.slice(0, 3),
  };
}

export function ema99LastValue(closes: number[]): number {
  if (closes.length === 0) return 0;
  const e = ema(closes, 99);
  const last = e[e.length - 1];
  return Number.isNaN(last) ? closes[closes.length - 1] : last;
}
