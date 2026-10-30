import type { TriggerMode, VolatilityClass, PushCondition } from './types.js';

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

/* ===== 价格异动通知（推送）常量 ===== */
/* 开发交付文档 V1.1.0：§4 阈值 / §5 冷静期 / §9.2 上限 / §10 KV 键 / §11 限流 */

/** 推送标的上限（文档 §9.2） */
export const PUSH_TARGET_LIMIT = 50;

/** 默认触发模式：关键位确认（文档 §3.2 推荐默认） */
export const PUSH_DEFAULT_MODE: TriggerMode = 'KEY_CONFIRM';

/** 窗口分钟数：默认 5，可配 1-15（文档 §2.2） */
export const PUSH_WINDOW_MINUTES_DEFAULT = 5;
export const PUSH_WINDOW_MINUTES_MIN = 1;
export const PUSH_WINDOW_MINUTES_MAX = 15;

/* ── 阈值（文档 §4）── */

/** base_threshold clamp 区间（%）（文档 §4.3） */
export const PUSH_BASE_MIN = 0.35;
export const PUSH_BASE_MAX = 0.60;
/** base = BTC 典型日波动 × 0.35（文档 §4.3） */
export const PUSH_BASE_FACTOR = 0.35;
/** 当前 BTC 典型日波动（%），文档 §4.3 用 1.19% */
export const PUSH_BTC_TYPICAL_DAILY_VOL = 1.19;

/** multiplier clip 上下限（文档 §4.4） */
export const PUSH_MULTIPLIER_MIN = 0.8;
export const PUSH_MULTIPLIER_MAX = 4.0;

/** 关键位确认带 base_key（%）（文档 §4.6） */
export const PUSH_KEY_BASE = 0.30;

/** 分类兜底阈值（%）（文档 §4.7） */
export const PUSH_CLASS_FALLBACK: Record<VolatilityClass, number> = {
  HIGH: 0.5, // 高价值
  MID: 1.0,  // 中价值
  LOW: 2.0,  // 低价值
};
/** 默认阈值（%）（文档 §4.7） */
export const PUSH_DEFAULT_THRESHOLD = 0.50;

/** 用户覆盖合理性警告边界（文档 §4.9） */
export const PUSH_OVERIDE_LOW_RATIO = 0.5;   // < 推荐 50% → 可能频繁触发
export const PUSH_OVERIDE_HIGH_RATIO = 3.0;  // > 推荐 3 倍 → 可能漏报

/** RV 计算窗口（日） */
export const PUSH_RV_LOOKBACK = 20;
/** 年化因子：日线 √365（加密 7×24）（文档 §4.2） */
export const PUSH_ANNUALIZATION_DAILY = Math.sqrt(365);

/* ── 冷静期与去重（文档 §5）── */

/** 冷静期 24 小时（ms）（文档 §5.1） */
export const PUSH_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** 前端同标的最小上报间隔 10 分钟（ms）（文档 §3.2） */
export const PUSH_CLIENT_REPORT_INTERVAL_MS = 10 * 60 * 1000;
/** 服务端 60 秒幂等键桶（秒）（文档 §5.3） */
export const PUSH_IDEMPOTENT_BUCKET_SEC = 60;

/* ── 限流（文档 §6、§11）── */

/** 钉钉 20 条/分钟 */
export const PUSH_DINGTALK_RATE_PER_MIN = 20;
/** 飞书 100 条/分钟、5 条/秒 */
export const PUSH_FEISHU_RATE_PER_MIN = 100;
export const PUSH_FEISHU_RATE_PER_SEC = 5;
/** 消息合并窗口 60 秒（文档 §6.3） */
export const PUSH_MERGE_WINDOW_SEC = 60;
/** 重试退避 1s/3s/9s（文档 §11） */
export const PUSH_RETRY_BACKOFF_SEC = [1, 3, 9];
/** 连续失败 3 次 → ABNORMAL（文档 §6.4） */
export const PUSH_FAIL_THRESHOLD = 3;

/* ── KV 键前缀（文档 §5.2、§10）── */

/** 冷静期：push:last:{targetId} → { ts, id }，TTL 7 天 */
export const PUSH_KV_LAST = 'push:last:';
/** 幂等键：sig:{targetId}:{bucket} */
export const PUSH_KV_IDEMPOTENT = 'sig:';
/** 推荐阈值缓存：rv:{symbol}:{yyyyMMddHH} → ThresholdRecommendationDto，TTL 1h */
export const PUSH_KV_RV = 'rv:';
/** base 基准：rv:base:current，TTL 8 天 */
export const PUSH_KV_BASE = 'rv:base:current';
/** 日志：pushlog:{yyyyMMdd}:{ts}:{id}，TTL 7 天 */
export const PUSH_KV_LOG = 'pushlog:';
/** 待冲刷队列：pending:{channelId}:{targetId}，TTL 5min */
export const PUSH_KV_PENDING = 'pending:';
/** 限流分钟桶：rate:dingtalk:{channelId}:{minuteBucket} */
export const PUSH_KV_RATE = 'rate:';

/* ── TTL 秒（文档 §4.8、§5.2、§10.2）── */

/** RV 推荐阈值缓存 TTL 1 小时 */
export const PUSH_RV_CACHE_TTL_SEC = 3600;
/** base TTL 8 天 */
export const PUSH_BASE_TTL_SEC = 8 * 24 * 3600;
/** 冷静期 KV TTL 7 天 */
export const PUSH_LAST_TTL_SEC = 7 * 24 * 3600;
/** 日志 KV TTL 7 天 */
export const PUSH_LOG_TTL_SEC = 7 * 24 * 3600;
/** 待冲刷队列 TTL 5 分钟 */
export const PUSH_PENDING_TTL_SEC = 5 * 60;
/** Worker 内存缓存 5 分钟 */
export const PUSH_MEMORY_TTL_SEC = 5 * 60;

/* ── 默认条件工厂（文档 §2.2、§3.2 默认值）── */

/** 生成一份推送标的默认条件配置 */
export function defaultPushConditions(overrides: Partial<PushCondition> = {}): PushCondition {
  return {
    mode: PUSH_DEFAULT_MODE,
    windowMinutes: PUSH_WINDOW_MINUTES_DEFAULT,
    thresholdMode: 'AUTO',
    volumeConfirm: true,
    volumeMultiplier: 1.5,
    directionConsistency: true,
    ...overrides,
  };
}
