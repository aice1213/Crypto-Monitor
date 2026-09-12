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

export const MIN_RR_RATIO = 1.5;
export const INSUFFICIENT_CANDLE_COUNT = 30;

export const SUPPORTED_INTERVALS = ['1m', '5m', '15m'] as const;
export type CandleInterval = (typeof SUPPORTED_INTERVALS)[number];

export const FUNDING_RATE_CROWDED_THRESHOLD = 0.0005;
export const LONG_SHORT_RATIO_HIGH = 2;
export const LONG_SHORT_RATIO_LOW = 0.5;

export const LS_WATCHLIST_KEY = 'crypto.watchlist.v1';
