export const DEFAULT_SYMBOLS = [
  'BTC_USDT',
  'ETH_USDT',
  'SOL_USDT',
  'BNB_USDT',
  'XRP_USDT',
  'DOGE_USDT',
] as const;

export const WATCHLIST_LIMIT = 20;
export const POLLING_INTERVAL_MS = 3000;
export const AI_CACHE_TTL_SEC = 60;
export const AI_REGEN_COOLDOWN_MS = 60_000;

export const AI_DISCLAIMER =
  '本内容仅供学习参考，不构成投资建议；加密货币交易风险极高，请自行决策、控制风险。';

export const RSI_OVERBOUGHT = 70;
export const RSI_OVERSOLD = 30;

export const SCORE_BULLISH_THRESHOLD = 40;
export const SCORE_BEARISH_THRESHOLD = -40;

/**
 * 综合评分中 RSI 极值的权重。
 * RSI 超买/超卖衡量"位置"而非"方向"，与 EMA/MACD/OBV 同权重会让强趋势被扣成"震荡"
 * （实测 BTC 15m：EMA 多头 +30、OBV 流入 +25、RSI 73.5 超买 −20 => 35 分 < 40 被判 RANGING）。
 * 故降为弱权重，方向由结构、动能、量能三者主导。
 */
export const SCORE_RSI_WEIGHT = 10;

/**
 * MACD 交叉在综合评分中的权重。
 * - `SCORE_MACD_WEIGHT`：交叉**发生当根**（`signalAge === 0`）计满权重。
 * - `SCORE_MACD_RECENT_WEIGHT`：dev.md 4.1 要求"之后 3 根内保留近期信号**用于 UI 弱化显示**"，
 *   既然只是 UI 呈现，就不该在评分里与当根交叉等价，否则同一个交叉会在 4 根 K 线里持续投满票。
 */
export const SCORE_MACD_WEIGHT = 25;
export const SCORE_MACD_RECENT_WEIGHT = 10;

export const MIN_RR_RATIO = 1.5;
export const INSUFFICIENT_CANDLE_COUNT = 30;

/** 交易计划基础止损：进场区远端 1.5%（dev.md 4.3） */
export const BASE_SL_PCT = 0.015;
/**
 * 止损最宽限制。dev.md 4.3 允许止损为躲开"次近关键位"而放宽，
 * 但若无上限，次近关键位越远止损越宽、盈亏比越低，会把合格计划判死
 * （实测 support=[98,88] 时止损被推到 10% 外，真实 RR 6.82 的机会被拒）。
 */
export const MAX_SL_PCT = 0.03;

/**
 * 允许向 Gate.io 请求的 K 线周期白名单。
 *
 * 必须与 `packages/indicators` 的 `intervalSeconds()` 登记表保持一致：
 * 未登记的周期会被当作 900 秒（15m），使该周期的每根 K 线都被误判为"缺口"。
 * 原先这里只有 `1m/5m/15m`，而 Home 页需要 `1h` 做多周期对比。
 */
export const SUPPORTED_INTERVALS = ['1m', '5m', '15m', '30m', '1h', '4h', '8h', '1d'] as const;
export type CandleInterval = (typeof SUPPORTED_INTERVALS)[number];

/** 周期是否在白名单内（用于 worker 侧入参校验，避免把任意字符串透传给上游） */
export function isSupportedInterval(interval: string): interval is CandleInterval {
  return (SUPPORTED_INTERVALS as readonly string[]).includes(interval);
}

export const FUNDING_RATE_CROWDED_THRESHOLD = 0.0005;
export const LONG_SHORT_RATIO_HIGH = 2;
export const LONG_SHORT_RATIO_LOW = 0.5;

export const LS_WATCHLIST_KEY = 'crypto.watchlist.v1';

/* ===== 宏观看板常量 ===== */

/** 净流动性解读阈值（十亿美元） */
export const LIQUIDITY_EXPANSION_THRESHOLD = 50;
export const LIQUIDITY_CONTRACTION_THRESHOLD = -50;

/** 宏观事件类型展示名 */
export const MACRO_EVENT_CATEGORY_LABEL: Record<string, string> = {
  FED: '美联储',
  CPI: 'CPI通胀',
  EMPLOYMENT: '就业',
  GDP: 'GDP',
  ECB: '欧央行',
  BOJ: '日央行',
  CRYPTO: '加密事件',
  OTHER: '其他',
};
