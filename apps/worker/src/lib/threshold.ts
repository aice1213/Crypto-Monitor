/**
 * 波动率自适应阈值计算（开发交付文档 §4）
 *
 * 纯函数模块：不依赖 KV/D1，所有数据由调用方传入，便于 RV 对拍测试。
 *
 * 阈值公式（§4.5）：threshold = base × clip(RV20(symbol) / RV20(BTC), 0.8, 4.0)
 *
 * 降级链（§4.7）：日线 RV → 4h RV → 1h RV → 分类兜底 → 默认值。
 * 关键：降级时 symbol 与 BTC 必须用**同一周期**计算 RV，年化因子才能抵消。
 *
 * 注意（P0 评估问题#1）：文档 §4.7 未指定 4h/1h 年化因子，这里补齐为
 * 4h → √(365×6)=√2190，1h → √(365×24)=√8760，与日线 √365 同源（加密 7×24）。
 */
import type { CandleDto, ThresholdRecommendationDto, ThresholdSource, VolatilityClass } from '@crypto-monitor/shared';
import {
  PUSH_BASE_MIN,
  PUSH_BASE_MAX,
  PUSH_BASE_FACTOR,
  PUSH_BTC_TYPICAL_DAILY_VOL,
  PUSH_MULTIPLIER_MIN,
  PUSH_MULTIPLIER_MAX,
  PUSH_KEY_BASE,
  PUSH_CLASS_FALLBACK,
  PUSH_DEFAULT_THRESHOLD,
  PUSH_RV_LOOKBACK,
  PUSH_ANNUALIZATION_DAILY,
  PUSH_ANNUALIZATION_4H,
  PUSH_ANNUALIZATION_1H,
} from '@crypto-monitor/shared';

/** 基准标的（multiplier 的分母） */
export const BTC_SYMBOL = 'BTC_USDT';

/** RV 计算输出 */
export interface RvResult {
  /** 年化已实现波动率（%） */
  rv20: number;
  /** 实际使用的收益样本数 */
  count: number;
  /** 使用的年化因子 */
  annualFactor: number;
}

/**
 * 计算 20 日已实现波动率（%）。
 *
 * 口径（§4.2）：取日线收盘价，对数收益 rt = ln(Pt/Pt-1)，20 日滚动样本标准差
 * （除以 n-1），年化 RV = σ × annualFactor。加密 7×24，日线 annualFactor = √365。
 *
 * @param candles 已按时间升序排序的 K 线
 * @param annualFactor 年化因子（日线 √365 / 4h √2190 / 1h √8760）
 * @param window 收益窗口（默认 20），需要 window+1 根 K 线
 */
export function computeRvs(
  candles: CandleDto[],
  annualFactor: number = PUSH_ANNUALIZATION_DAILY,
  window: number = PUSH_RV_LOOKBACK,
): RvResult | null {
  // 需要 window+1 根收盘价才能产生 window 个对数收益
  if (!candles || candles.length < window + 1) return null;

  // 取最近 window+1 根
  const closes = candles.slice(-(window + 1)).map((c) => c.close);
  // 收益序列
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    if (prev <= 0 || closes[i] <= 0) return null; // 非法价，放弃
    rets.push(Math.log(closes[i] / prev));
  }

  const n = rets.length;
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  // 样本标准差（除以 n-1，§4.2）
  const variance = rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1);
  const std = Math.sqrt(variance);

  return { rv20: std * annualFactor * 100, count: n, annualFactor };
}

/** 截断到指定小数位（避免浮点显示噪音） */
function round(v: number, digits = 2): number {
  const p = Math.pow(10, digits);
  return Math.round(v * p) / p;
}

/**
 * base_threshold（§4.3）：base = clamp(BTC 典型日波动 × 0.35, 0.35%, 0.60%)
 */
export function computeBase(btcDailyVol: number = PUSH_BTC_TYPICAL_DAILY_VOL): number {
  const raw = btcDailyVol * PUSH_BASE_FACTOR;
  return round(Math.min(Math.max(raw, PUSH_BASE_MIN), PUSH_BASE_MAX));
}

/**
 * volatility_multiplier（§4.4）：multiplier = clip(RV(symbol)/RV(BTC), 0.8, 4.0)
 */
export function clipMultiplier(ratio: number): number {
  return round(Math.min(Math.max(ratio, PUSH_MULTIPLIER_MIN), PUSH_MULTIPLIER_MAX));
}

/** computeRecommendation 输入（全部由调用方提供，可测） */
export interface RecommendationInput {
  symbol: string;
  /** 该标的本身就是 BTC（multiplier 恒 1.0，不比对自身） */
  isBtc?: boolean;
  /** 日线 K 线（升序） */
  daily?: CandleDto[];
  /** 4h K 线（升序），日线不足时降级 */
  h4?: CandleDto[];
  /** 1h K 线（升序） */
  h1?: CandleDto[];
  /** BTC 基准日线（与 daily 同周期比对） */
  btcDaily?: CandleDto[];
  /** BTC 基准 4h */
  btc4h?: CandleDto[];
  /** BTC 基准 1h */
  btc1h?: CandleDto[];
  /** 当前 base（%）。缺省用 computeBase() 计算（不读 KV，由调用方注入缓存值） */
  baseThreshold?: number;
  /** 分类兜底档位（§4.7），RV 全部不可用时使用 */
  classFallback?: VolatilityClass;
  /** 计算时间戳，缺省 Date.now() */
  now?: number;
}

/**
 * 完整推荐阈值计算（§4.5 公式 + §4.7 降级链）。
 *
 * 优先级：
 * 1. 日线 RV（symbol 与 BTC 均可用）→ source='RV'
 * 2. 4h RV（同周期比对）→ source='RV'
 * 3. 1h RV（同周期比对）→ source='RV'
 * 4. 分类兜底（classFallback 提供时）→ source='CLASS_FALLBACK'
 * 5. 默认 0.50% → source='DEFAULT'
 */
export function computeRecommendation(input: RecommendationInput): ThresholdRecommendationDto {
  const symbol = input.symbol;
  const base = input.baseThreshold ?? computeBase();
  const now = input.now ?? Date.now();

  interface Tier {
    key: 'daily' | 'h4' | 'h1';
    candles?: CandleDto[];
    btcCandles?: CandleDto[];
    factor: number;
  }

  const tiers: Tier[] = [
    { key: 'daily', candles: input.daily, btcCandles: input.btcDaily, factor: PUSH_ANNUALIZATION_DAILY },
    { key: 'h4', candles: input.h4, btcCandles: input.btc4h, factor: PUSH_ANNUALIZATION_4H },
    { key: 'h1', candles: input.h1, btcCandles: input.btc1h, factor: PUSH_ANNUALIZATION_1H },
  ];

  let lastFailNote: string | undefined;

  for (const tier of tiers) {
    if (!tier.candles || tier.candles.length === 0) continue;

    const symRv = computeRvs(tier.candles, tier.factor);
    if (!symRv) {
      lastFailNote = `${tier.key} K线不足 ${PUSH_RV_LOOKBACK + 1} 根`;
      continue;
    }

    // BTC 自身：multiplier = 1.0（不比对自身，避免除零/噪声）
    let btcRv: number;
    if (input.isBtc) {
      btcRv = symRv.rv20;
    } else {
      if (!tier.btcCandles || tier.btcCandles.length === 0) {
        lastFailNote = `${tier.key} 已有但 BTC 基准不可用`;
        continue;
      }
      const b = computeRvs(tier.btcCandles, tier.factor);
      if (!b) {
        lastFailNote = `${tier.key} BTC 基准不足`;
        continue;
      }
      btcRv = b.rv20;
    }

    if (btcRv <= 0) {
      lastFailNote = `${tier.key} BTC RV 非正`;
      continue;
    }

    const multiplier = clipMultiplier(symRv.rv20 / btcRv);
    const recommendedThreshold = round(base * multiplier);
    const keyPriceThreshold = round(PUSH_KEY_BASE * multiplier);
    const source: ThresholdSource = 'RV';

    return {
      symbol,
      baseThreshold: round(base),
      rv20: round(symRv.rv20),
      btcRv20: round(btcRv),
      multiplier,
      recommendedThreshold,
      source,
      keyPriceThreshold,
      computedAt: now,
      note:
        tier.key === 'daily'
          ? undefined
          : `日线不足，${tier.key === 'h4' ? '4h' : '1h'} 降级（年化 ×${round(tier.factor, 1)}）`,
    };
  }

  // 分类兜底（§4.7）
  if (input.classFallback) {
    const t = PUSH_CLASS_FALLBACK[input.classFallback];
    return {
      symbol,
      baseThreshold: round(base),
      rv20: null,
      btcRv20: null,
      multiplier: null,
      recommendedThreshold: t,
      source: 'CLASS_FALLBACK',
      classFallback: input.classFallback,
      keyPriceThreshold: PUSH_KEY_BASE,
      computedAt: now,
      note: lastFailNote ? `${lastFailNote}；分类估算` : '数据不足，分类估算',
    };
  }

  // 默认值（§4.7）
  return {
    symbol,
    baseThreshold: round(base),
    rv20: null,
    btcRv20: null,
    multiplier: null,
    recommendedThreshold: PUSH_DEFAULT_THRESHOLD,
    source: 'DEFAULT',
    keyPriceThreshold: PUSH_KEY_BASE,
    computedAt: now,
    note: lastFailNote ?? '默认值，请手动确认',
  };
}
