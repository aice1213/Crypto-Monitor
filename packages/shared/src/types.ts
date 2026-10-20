/**
 * 统一响应信封
 */
export interface ApiEnvelope<T> {
  code: number;
  data: T;
  msg?: string;
  ts: number;
}

export interface TickerDto {
  symbol: string;
  last: number;
  change24h: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  ts: number;
  stale?: boolean;
}

export interface CandleDto {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type EmaStructure = 'BULLISH' | 'BEARISH' | 'MIXED';
export type RsiZone = 'OVERBOUGHT' | 'OVERSOLD' | 'NEUTRAL';
export type MacdSignal = 'GOLDEN_CROSS' | 'DEATH_CROSS' | 'NO_SIGNAL';
export type ObvFlow = 'INFLOW' | 'OUTFLOW' | 'BALANCED';
export type TrendDirection = 'BULLISH' | 'BEARISH' | 'RANGING';
export type DataQuality = 'FULL' | 'GAPS_FILLED' | 'INSUFFICIENT';
export type MarketState = 'TREND_UP' | 'TREND_DOWN' | 'WIDE_RANGE' | 'NARROW_RANGE';

/* ===== 价格行为形态 ===== */

export type PatternType = 'PINBAR' | 'INSIDE_BAR' | 'FAKEY';

export type PatternDirection = 'BULLISH' | 'BEARISH';

export type PatternQuality = 'HIGH' | 'MEDIUM' | 'LOW';

/** 策略分类：反转（关键位拒绝）vs 突破（形态破位顺势） */
export type PatternStrategy = 'REVERSAL' | 'BREAKOUT';

export interface PatternSignal {
  type: PatternType;
  direction: PatternDirection;
  /** 形态强度：0~1，影线/突破幅度相对 ATR 的比例 */
  strength: number;
  /** 共振质量：HIGH(3) / MEDIUM(2) / LOW(0-1)，基于趋势+关键位+强度 */
  quality: PatternQuality;
  /** 共振评分：0~3，趋势一致+1、关键位+1、强度+1 */
  score: number;
  /** 形态完成时所在 K 线的 0-based 下标 */
  index: number;
  /** K 线开盘时间（秒），供图表定位使用 */
  time: number;
  /** 事件区 ID：同一价格区域聚集的信号共享同一 ID（间距 < ATR） */
  eventZoneId: string | null;
  /** 形态是否失效：看涨后跌破低点 / 看跌后涨破高点 = 失败，信号方向反转 */
  failed: boolean;
  /** 策略分类：REVERSAL（关键位拒绝）/ BREAKOUT（形态破位） */
  strategy: PatternStrategy;
  /** 突破触发价位：挂止损单的价位，null = 不适用 */
  breakoutLevel: number | null;
  /** 50%回调限价进场价（仅 REVERSAL 策略针形K线），null = 不适用 */
  retracementEntry: number | null;
}

export interface PatternContext {
  trend: TrendDirection;
  support: number[];
  resistance: number[];
}

export interface MarketStateDto {
  state: MarketState;
  /** 解读文案 */
  interpretation: string;
}

/* ===== 趋势结构（HH/HL/LH/LL 波段分析） ===== */

/** 趋势结构破坏信号 */
export type TrendBreakSignal = 'INTACT' | 'BULL_BROKEN' | 'BEAR_BROKEN' | 'UNCLEAR';

/** 趋势结构分析结果 */
export interface TrendStructureDto {
  /** 结构方向：基于最近波段高点/低点关系 */
  direction: TrendDirection;
  /** 最近波段高点价格 */
  lastHigh: number | null;
  /** 最近波段低点价格 */
  lastLow: number | null;
  /** 波段高点模式：HH（更高高点）/ LH（更低高点）/ EQUIV（持平） */
  highPattern: 'HH' | 'LH' | 'EQUIV';
  /** 波段低点模式：HL（更高低点）/ LL（更低低点）/ EQUIV（持平） */
  lowPattern: 'HL' | 'LL' | 'EQUIV';
  /** 连续 HH 计数（从最近一次 HH 开始计数） */
  highCount: number;
  /** 连续 HL 计数（从最近一次 HL 开始计数） */
  lowCount: number;
  /** 趋势结构是否破坏 */
  structureBreak: TrendBreakSignal;
  /** 结构解读文案 */
  interpretation: string;
}

/** 均线策略信号状态 */
export type MaSignalStatus = 'READY' | 'WAITING' | 'AWAY' | 'INVALID';

export interface MaStrategyDto {
  /** 趋势过滤：价格与 EMA200 的关系 */
  trendFilter: 'LONG_ONLY' | 'SHORT_ONLY' | 'NONE';
  /** 回踩次数：最近 N 根内价格触及 EMA50 的次数 */
  retestCount: number;
  /** 是否处于 EMA50 价值区间 */
  nearEma50: boolean;
  /** 入场信号状态 */
  signalStatus: MaSignalStatus;
  /** 策略解读文案 */
  interpretation: string;
}

export interface MacdResult {
  dif: number;
  dea: number;
  hist: number;
  signal: MacdSignal;
  /**
   * 距最近一次交叉的根数。
   * - `0`   ：交叉发生在**当根** K 线（真实信号）
   * - `1~3` ：处于保留期内的"近期信号"，dev.md 4.1 规定仅用于 UI 弱化显示
   * - `null`：无信号
   *
   * `signal` 字段本身无法区分"当根交叉"与"3 根内保留"，评分与文案必须依赖本字段弱化。
   */
  signalAge: number | null;
}

export interface ObvResult {
  value: number;
  ma20: number;
  flow: ObvFlow;
  volumeRatio: number;
  volumeAvg20ChangePct: number;
}

export interface TrendResult {
  score: number;
  direction: TrendDirection;
}

export interface TradePlan {
  entryLow: number;
  entryHigh: number;
  tp1: number;
  tp2: number;
  sl: number;
  rrRatio: number;
  side: 'LONG' | 'SHORT';
  reason: string;
}

export interface IndicatorSnapshotDto {
  ema7: number;
  ema25: number;
  ema50: number;
  ema99: number;
  ema200: number;
  emaStructure: EmaStructure;
  rsi14: number;
  rsiZone: RsiZone;
  macd: MacdResult;
  obv: ObvResult;
  trend: TrendResult;
  support: number[];
  resistance: number[];
  /** 最近出现的形态信号（按时间倒序，最新在前） */
  patterns: PatternSignal[];
  /** 市场状态分类（趋势/震荡/窄幅随机） */
  marketState: MarketStateDto;
  /** 趋势结构分析（HH/HL/LH/LL 波段高低点结构） */
  trendStructure: TrendStructureDto;
  /** 均线交易策略（EMA200趋势 + EMA50价值区间回踩） */
  maStrategy: MaStrategyDto;
  plan: TradePlan | null;
  dataQuality: DataQuality;
}

export interface AlertSnapshotDto {
  fundingRate: number;
  fundingSignal: 'LONG_HEAVY' | 'SHORT_HEAVY' | 'NEUTRAL';
  longShortRatio: number;
  volumePriceDivergence: 'BULLISH_DIVERGENCE' | 'BEARISH_DIVERGENCE' | 'NONE';
  multiTfConflict: boolean;
  multiTfState: 'BULL_ALIGN' | 'BEAR_ALIGN' | 'RANGE_ALIGN' | 'CONFLICT' | 'INSUFFICIENT';
  extremeAlert: 'OVERBOUGHT' | 'OVERSOLD' | null;
  dataQuality: DataQuality;
}

/** AI 输出方向与规则引擎的一致性 */
export type AiConsensus = 'ALIGNED' | 'DIVERGED' | 'UNKNOWN';

/** AI 降级原因 */
export type AiDegradedReason =
  | 'AI_DISABLED'
  | 'QUOTA_EXHAUSTED'
  | 'AI_UNAVAILABLE'
  | 'PARSE_FAILED';

export interface AiStrategyDto {
  symbol: string;
  summary: string;
  signals: {
    /**
     * AI **自己**给出的方向（从模型输出的结构化首行解析得到）。
     * 早期实现直接复制规则引擎的 `trend.direction`，导致该字段在结构上永不可能分歧，
     * 一致性校验形同虚设（审查项 F31）。
     */
    trend: TrendDirection;
    confidence: 'HIGH' | 'MEDIUM' | 'LOW';
    /** AI 方向与规则引擎是否一致；无法解析 AI 方向时为 UNKNOWN */
    consensus: AiConsensus;
    /** 规则引擎方向，供 UI 对照展示 */
    engineTrend: TrendDirection;
  };
  disclaimer: string;
  generatedAt: number;
  model: string;
  /** 是否走了降级路径（规则引擎文本 / AI 不可用 / 额度用尽 / 解析失败） */
  degraded: boolean;
  degradedReason?: AiDegradedReason;
}

export interface FundingRateDto {
  symbol: string;
  fundingRate: number;
  ts: number;
}

export interface ContractStatsDto {
  symbol: string;
  longShortRatio: number;
  ts: number;
}

/* ===== 宏观看板类型 ===== */

/** FOMC 利率概率分布项 */
export interface FomcRateProbability {
  /** 目标利率区间下限，如 5.25 */
  rateFloor: number;
  /** 目标利率区间上限，如 5.50 */
  rateCeil: number;
  /** 该区间的概率（0-100） */
  probability: number;
}

/** FOMC 快照 */
export interface FomcSnapshot {
  /** 下一次 FOMC 决议时间（ISO） */
  nextMeeting: string;
  /** 会议名称，如 "2026年9月FOMC" */
  meetingName: string;
  /** 当前联邦基金利率区间下限 */
  currentRateFloor: number;
  /** 当前联邦基金利率区间上限 */
  currentRateCeil: number;
  /** 上次决议结果：加息/降息/按兵不动 */
  lastDecision: 'HIKE' | 'CUT' | 'HOLD' | 'PENDING';
  /** 上次决议变动基点（如 +25 / -25 / 0） */
  lastDecisionBps: number;
  /** 利率概率分布（人工录入快照） */
  probabilities: FomcRateProbability[];
  /** 概率快照录入时间（ISO） */
  snapshotUpdatedAt: string;
  /** 数据来源说明 */
  source: string;
}

/** 宏观日历事件等级 */
export type MacroEventLevel = 'S' | 'A' | 'B';
/** 宏观日历事件紧迫度 */
export type MacroEventUrgency = 'RED' | 'YELLOW' | 'GRAY';

/** 宏观日历事件 */
export interface MacroCalendarEvent {
  id: string;
  /** 事件时间（ISO） */
  time: string;
  /** 事件标题 */
  title: string;
  /** 事件类型 */
  category: 'FED' | 'CPI' | 'EMPLOYMENT' | 'GDP' | 'ECB' | 'BOJ' | 'CRYPTO' | 'OTHER';
  /** 等级 */
  level: MacroEventLevel;
  /** 紧迫度（由倒计时动态计算） */
  urgency: MacroEventUrgency;
  /** 前值 */
  previous?: string;
  /** 预期值 */
  forecast?: string;
  /** 实际值 */
  actual?: string;
  /** 备注 */
  note?: string;
}

/** 宏观日历数据 */
export interface MacroCalendarData {
  events: MacroCalendarEvent[];
  /** 数据更新时间 */
  updatedAt: number;
}

/** 单交易所资金费率 */
export interface FundingByExchange {
  exchange: string;
  /** 当期资金费率（小数） */
  fundingRate: number;
  /** 年化费率（小数），按该交易所**实际**结算周期折算 */
  annualizedRate: number;
  /** 持仓量 OI（USDT）；取不到时为 0 */
  openInterest: number;
  /** 结算周期（小时），用于年化与透明度 */
  settlementHours: number;
  ts: number;
  /** 该交易所是否取数成功 */
  ok: boolean;
  /** 取数失败原因（ok=false 时） */
  error?: string;
}

/** 宏观资金费率数据（多交易所加权） */
export interface MacroFundingData {
  symbol: string;
  /** 各交易所明细 */
  exchanges: FundingByExchange[];
  /** 加权平均当期费率 */
  weightedFundingRate: number;
  /** 加权平均年化费率 */
  weightedAnnualizedRate: number;
  ts: number;
  /** 是否真的按持仓量加权；所有交易所 OI 都缺失时为 false（退化为算术平均） */
  weightedByOpenInterest: boolean;
  /** 成功取到数据的交易所数量 */
  availableCount: number;
}

/** 清算热力图格子 */
export interface LiquidationCell {
  /** 价格桶中心价 */
  price: number;
  /**
   * 多单强平名义金额（USDT）。
   * 依据 Gate.io 强平订单的方向约定：`order_size < 0` 为卖出委托 => 多头仓位被强平。
   */
  longLiquidationUsd: number;
  /** 空单强平名义金额（USDT）；`order_size > 0` 为买入委托 => 空头仓位被强平 */
  shortLiquidationUsd: number;
}

/** 清算热力图 */
export interface LiquidationHeatmap {
  symbol: string;
  cells: LiquidationCell[];
  /** 累计最大的3个价位 */
  topLevels: { price: number; totalUsd: number }[];
  /** 本次统计窗口的起始时间 */
  collectedSince: number;
  ts: number;
  /** 精度与口径说明 */
  disclaimer: string;
  /** 数据源，如 `Gate.io /futures/usdt/liq_orders` */
  source: string;
  /** 是否为真实成交的强平订单；false 时 cells 为空，UI 必须显示"暂不可用" */
  live: boolean;
  /** 统计窗口（小时）。Gate.io 单次查询上限 1 小时 */
  windowHours: number;
  /** 窗口内强平订单笔数（用于判断样本厚薄） */
  sampleCount: number;
  /** 窗口内强平总名义金额（USDT） */
  totalUsd: number;
  /** live=false 时的原因 */
  reason?: string;
}

/** 净流动性单日数据点 */
export interface LiquidityPoint {
  /** 日期 YYYY-MM-DD */
  date: string;
  /** 总资产 WALCL（十亿美元） */
  walcl: number;
  /** TGA 财政部一般账户（十亿美元） */
  tga: number;
  /** ON RRP 逆回购（十亿美元） */
  rrp: number;
  /** 净流动性 = WALCL - TGA - RRP（十亿美元） */
  netLiquidity: number;
}

/** 净流动性数据 */
export interface LiquidityData {
  /** 当前净流动性（十亿美元） */
  current: number;
  /** 与对照观测日相比的变动（十亿美元） */
  weeklyChange: number;
  /** 解读：扩张/平稳/收缩 */
  regime: 'EXPANSION' | 'NEUTRAL' | 'CONTRACTION';
  /** 历史序列（最近约6个月） */
  history: LiquidityPoint[];
  /** 数据更新时间 */
  updatedAt: number;
  /** 数据来源 */
  source: string;
  /** 是否来自实时数据源（false 时 history 为空，UI 必须显示"暂不可用"） */
  live: boolean;
  /** 最新观测日 */
  asOf?: string;
  /** 对照观测日（约 7 天前） */
  comparedTo?: string;
  /** live=false 时的原因 */
  reason?: string;
}
