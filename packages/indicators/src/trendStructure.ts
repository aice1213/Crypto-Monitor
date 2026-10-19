import type { CandleDto, TrendDirection, TrendStructureDto } from '@crypto-monitor/shared';
import { findPivots } from './pivots.js';

/** Price comparison tolerance: below this percentage is considered equivalent (EQUIV) */
const EQUIV_PCT = 0.002;

/** Max swing pairs to analyze for trend structure */
const MAX_SWING_PAIRS = 20;

/** Minimum structure count for trend break detection */
const MIN_STRUCTURE_COUNT = 3;

/**
 * Determine if two prices are "close enough" (EQUIV).
 * Tolerance is 0.2% of the larger value.
 */
function isEquiv(a: number, b: number): boolean {
  if (a <= 0 || b <= 0) return false;
  const tolerance = Math.max(Math.abs(a), Math.abs(b)) * EQUIV_PCT;
  return Math.abs(a - b) <= tolerance;
}

/**
 * Analyze HH/HL/LH/LL trend structure from swing highs/lows.
 *
 * Core logic (Bare K-line Trend Identification doc #2, #3, #6):
 * 1. Use findPivots to extract swing highs and swing lows
 * 2. Compare consecutive swings:
 *    - High vs High -> HH (Higher High) or LH (Lower High)
 *    - Low vs Low -> HL (Higher Low) or LL (Lower Low)
 * 3. Consecutive count: count consecutive HH/HL from the latest backward
 * 4. Trend break detection:
 *    - Bullish structure (>=3 HH+HL) broken by price below last HL -> BULL_BROKEN
 *    - Bearish structure (>=3 LH+LL) broken by price above last LH -> BEAR_BROKEN
 * 5. Direction determination:
 *    - HH + HL -> BULLISH
 *    - LH + LL -> BEARISH
 *    - Other -> RANGING
 */
export function analyzeTrendStructure(candles: CandleDto[]): TrendStructureDto {
  const n = candles.length;

  const minLen = 20;
  if (n < minLen) {
    return {
      direction: 'RANGING',
      lastHigh: null,
      lastLow: null,
      highPattern: 'EQUIV',
      lowPattern: 'EQUIV',
      highCount: 0,
      lowCount: 0,
      structureBreak: 'UNCLEAR',
      interpretation: 'Data insufficient for trend structure analysis',
    };
  }

  const pivotWindow = Math.min(5, Math.floor(n / 10));
  const { highs, lows } = findPivots(candles, pivotWindow);

  if (highs.length < 2 || lows.length < 2) {
    return {
      direction: 'RANGING',
      lastHigh: null,
      lastLow: null,
      highPattern: 'EQUIV',
      lowPattern: 'EQUIV',
      highCount: 0,
      lowCount: 0,
      structureBreak: 'UNCLEAR',
      interpretation: 'Insufficient swing points for trend structure analysis',
    };
  }

  const recentHighs = highs.slice(-MAX_SWING_PAIRS);
  const recentLows = lows.slice(-MAX_SWING_PAIRS);

  const lastHigh = recentHighs[recentHighs.length - 1];
  const lastLow = recentLows[recentLows.length - 1];

  // High pattern
  let highPattern: TrendStructureDto['highPattern'] = 'EQUIV';
  if (recentHighs.length >= 2) {
    const prevHigh = recentHighs[recentHighs.length - 2];
    const currHigh = lastHigh;
    if (isEquiv(prevHigh.price, currHigh.price)) {
      highPattern = 'EQUIV';
    } else if (currHigh.price > prevHigh.price) {
      highPattern = 'HH';
    } else {
      highPattern = 'LH';
    }
  }

  // Low pattern
  let lowPattern: TrendStructureDto['lowPattern'] = 'EQUIV';
  if (recentLows.length >= 2) {
    const prevLow = recentLows[recentLows.length - 2];
    const currLow = lastLow;
    if (isEquiv(prevLow.price, currLow.price)) {
      lowPattern = 'EQUIV';
    } else if (currLow.price > prevLow.price) {
      lowPattern = 'HL';
    } else {
      lowPattern = 'LL';
    }
  }

  // Consecutive counts
  let highCount = 0;
  if (recentHighs.length >= 2) {
    for (let i = recentHighs.length - 1; i >= 1; i--) {
      const curr = recentHighs[i];
      const prev = recentHighs[i - 1];
      if (curr.price > prev.price && !isEquiv(curr.price, prev.price)) {
        highCount++;
      } else {
        break;
      }
    }
  }

  let lowCount = 0;
  if (recentLows.length >= 2) {
    for (let i = recentLows.length - 1; i >= 1; i--) {
      const curr = recentLows[i];
      const prev = recentLows[i - 1];
      if (curr.price > prev.price && !isEquiv(curr.price, prev.price)) {
        lowCount++;
      } else {
        break;
      }
    }
  }

  // Direction
  let direction: TrendDirection;
  if (highPattern === 'HH' && lowPattern === 'HL') {
    direction = 'BULLISH';
  } else if (highPattern === 'LH' && lowPattern === 'LL') {
    direction = 'BEARISH';
  } else {
    direction = 'RANGING';
  }

  // Trend break detection
  const currentPrice = candles[n - 1].close;
  let structureBreak: TrendStructureDto['structureBreak'] = 'INTACT';

  if (direction === 'BULLISH' && lastLow.price > 0 && highCount >= MIN_STRUCTURE_COUNT) {
    if (currentPrice < lastLow.price) {
      structureBreak = 'BULL_BROKEN';
    }
  } else if (direction === 'BEARISH' && lastHigh.price > 0 && highCount >= MIN_STRUCTURE_COUNT) {
    if (currentPrice > lastHigh.price) {
      structureBreak = 'BEAR_BROKEN';
    }
  } else if (direction === 'RANGING') {
    structureBreak = 'UNCLEAR';
  }

  const interpretation = buildInterpretation(
    direction, highPattern, lowPattern, highCount, lowCount,
    structureBreak, lastHigh, lastLow,
  );

  return {
    direction,
    lastHigh: lastHigh.price,
    lastLow: lastLow.price,
    highPattern,
    lowPattern,
    highCount,
    lowCount,
    structureBreak,
    interpretation,
  };
}

function buildInterpretation(
  direction: TrendDirection,
  highPattern: TrendStructureDto['highPattern'],
  lowPattern: TrendStructureDto['lowPattern'],
  highCount: number,
  lowCount: number,
  structureBreak: TrendStructureDto['structureBreak'],
  lastHigh: { price: number } | undefined,
  lastLow: { price: number } | undefined,
): string {
  const parts: string[] = [];

  if (direction === 'BULLISH') {
    parts.push('上涨结构');
  } else if (direction === 'BEARISH') {
    parts.push('下跌结构');
  } else {
    parts.push('结构不明');
  }

  if (highPattern !== 'EQUIV') {
    const hpText = highPattern === 'HH' ? '更高高点' : '更低高点';
    parts.push(hpText + (highCount > 1 ? '×' + highCount : ''));
  }
  if (lowPattern !== 'EQUIV') {
    const lpText = lowPattern === 'HL' ? '更高低点' : '更低低点';
    parts.push(lpText + (lowCount > 1 ? '×' + lowCount : ''));
  }

  if (structureBreak === 'BULL_BROKEN') {
    parts.push('下跌破前低，上涨结构可能终结');
  } else if (structureBreak === 'BEAR_BROKEN') {
    parts.push('上涨破前高，下跌结构可能终结');
  }

  if (lastHigh && lastLow) {
    parts.push('波段高 ' + lastHigh.price.toFixed(2) + ' / 低 ' + lastLow.price.toFixed(2));
  }

  return parts.join('，');
}
