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

export type PatternType = 'PINBAR' | 'INSIDE_BAR' | 'FAKEY' | 'ENGULFING' | 'FAKE_BREAKOUT';

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
  /** 是否为健康回调：逆势方向且蜡烛实体小（strength<0.3），趋势仍健康，不构成反转信号 */
  counterTrendPullback?: boolean;
}

export interface PatternContext {
  trend: TrendDirection;
  support: number[];
  resistance: number[];
  /** EMA50 当前值 — 用于检测关键位回踩（文档规则2-条件1） */
  ema50?: number;
  /** Fibonacci 回撤关键位数组 — 0.382/0.5/0.618 等（文档规则2-条件3） */
  fibLevels?: number[];
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

/** 波段交易设置类型 */
export type SwingSetup =
  | 'RANGE_LOW'              // 区间震荡：价格在支撑位附近，做多
  | 'RANGE_HIGH'             // 区间震荡：价格在阻力位附近，做空
  | 'TREND_PULLBACK_LONG'    // 顺势抓浪：上涨趋势回踩 EMA50，做多
  | 'TREND_PULLBACK_SHORT'   // 顺势抓浪：下跌趋势反弹 EMA50，做空
  | 'COUNTER_TREND_BEARISH'  // 逆势反转：上涨趋势假突破阻力，做空
  | 'COUNTER_TREND_BULLISH'  // 逆势反转：下跌趋势假突破支撑，做多
  | 'NO_SETUP';             // 无明确设置

export interface SwingStrategyDto {
  /** 当前波段设置类型 */
  setup: SwingSetup;
  /** 方向：做多 / 做空 / 无 */
  direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  /** 设置强度评分：0~100 */
  confidence: number;
  /** 建议止损价位 */
  stopLoss: number | null;
  /** 建议止盈价位 */
  takeProfit: number | null;
  /** 参考价位说明 */
  reference: string;
  /** 策略解读文案 */
  interpretation: string;
  /** 风险提示 */
  riskNote: string;
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

/** 柱体动能强度分级 */
export type MacdMomentumLevel = 'STRONG' | 'MEDIUM' | 'WEAK' | 'EMPTY';

/** 快线与柱体分离方向 */
export type MacdSeparation = 'NONE' | 'BULLISH_SEP' | 'BEARISH_SEP';

/** 柱体动能 + 快线分离综合信号 */
export type MacdAdvancedSignal = 'SHORT' | 'LONG' | 'NONE';

/**
 * MACD 高阶分析：柱体动能强度 + 收缩 + 快线-柱体分离
 *
 * 核心理念（源自《MACD高阶实战心法》）：
 * - MACD 本质是统计均线距离的动能指标，金叉死叉仅仅代表动能衰减，不代表趋势反转
 * - 实战核心信号：大柱体 + 柱体收缩 + 快线与柱体形成分离
 * - 零轴上方红柱缩量 + DIF 下行 = 做空信号
 * - 零轴下方绿柱缩量 + DIF 上行 = 做多信号
 */
export interface MacdAdvancedDto {
  /** 柱体动能强度（基于 |hist| / ATR14 归一化） */
  momentum: MacdMomentumLevel;
  /** 柱体是否在收缩（绝对值连续 N 根递减） */
  contracting: boolean;
  /** 柱体变化率：(hist[current] - hist[current-3]) / ATR14，正值=扩张，负值=收缩 */
  histChangeRate: number;
  /** 快线（DIF）方向 */
  difDirection: 'UP' | 'DOWN' | 'FLAT';
  /** 快线与柱体的分离类型 */
  separation: MacdSeparation;
  /** 零轴位置 */
  zeroAxisPos: 'ABOVE' | 'BELOW' | 'NEAR';
  /** 综合交易信号（柱体收缩 + 分离共振时产生） */
  actionableSignal: MacdAdvancedSignal;
  /** 一句话解读 */
  interpretation: string;
}

/** RSI 背离类型 */
export type RsiDivergenceType = 'BULLISH' | 'BEARISH';

/** RSI 背离信号 */
export interface RsiDivergenceSignal {
  /** 背离方向：看涨（底背离）/ 看跌（顶背离） */
  type: RsiDivergenceType;
  /** 第一个低点/高点所在的 K 线下标 */
  firstIndex: number;
  /** 第一个低点/高点价格 */
  firstPrice: number;
  /** 第一个低点/高点对应的 RSI 值 */
  firstRsi: number;
  /** 第二个低点/高点所在的 K 线下标 */
  secondIndex: number;
  /** 第二个低点/高点价格 */
  secondPrice: number;
  /** 第二个低点/高点对应的 RSI 值 */
  secondRsi: number;
  /** RSI 变动幅度（百分点） */
  rsiDelta: number;
  /** 背离解读文案 */
  interpretation: string;
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

/**
 * 反转入场信号（K线反转精准入场文档）：
 * 三大信号共振 → 精准捕捉趋势反转
 *
 * 核心逻辑（文档第六节）：
 *   1. 趋势走势转弱 — 最后趋势K线实体缩小，动能不足
 *   2. 回调走势变强 — 回调中出现大蜡烛，反向动能介入
 *   3. 趋势架构破坏 — 上升出LL / 下跌出HH，原架构被打破
 *
 * 关键位确认（加分项）：价格在支撑/阻力位附近时确定性翻倍
 */
export interface ReversalEntryDto {
  /** 反转方向：BULLISH（上升趋势破坏→做多入场）/ BEARISH（下跌趋势破坏→做空入场） */
  direction: 'BULLISH' | 'BEARISH';
  /** 原趋势方向 */
  originalTrend: 'UP' | 'DOWN';
  /** 信号1：趋势走势转弱（true = 最后趋势K线实体小于前序均值） */
  trendWeakening: boolean;
  /** 信号2：回调走势变强（true = 回调中出现实体 > 1.5×ATR 的大蜡烛） */
  strongPullback: boolean;
  /** 信号3：趋势架构破坏（true = 上升出LL / 下跌出HH） */
  structureBroken: boolean;
  /** 关键位确认：价格在支撑/阻力位附近（±3%） */
  nearKeyLevel: boolean;
  /** 满足的共振条件数（0~4） */
  resonanceCount: number;
  /** 信号强度：0~1，基于满足条件数和幅度综合计算 */
  strength: number;
  /** 综合信号评级 */
  verdict: 'STRONG_REVERSAL' | 'REVERSAL_WATCH' | 'NO_REVERSAL';
  /** 建议入场价 */
  entryPrice: number | null;
  /** 建议止损价 */
  stopLoss: number | null;
  /** 建议止盈价 */
  takeProfit: number | null;
  /** 一句话解读 */
  interpretation: string;
}

/** 回调健康度评级 */
export type PullbackRating = 'STRONG' | 'HEALTHY' | 'NORMAL' | 'DEEP' | 'BROKEN' | 'UNKNOWN';

/** 趋势健康度分析 */
export interface PullbackHealthDto {
  /** 当前趋势状态 */
  state: 'INSUFFICIENT_DATA' | 'NO_SWING' | 'RANGING' | 'UP' | 'DOWN' | 'FLAT';
  /** 回调健康度评级 */
  rating: PullbackRating;
  /** 回调深度（0~1） */
  pullbackPct: number;
  /** 回调 K 线根数 */
  pullbackBars: number;
  /** 量比：回调段均量 / 趋势段均量 */
  volumeRatio: number;
  /** ATR 归一化斜率 */
  atrSlope: number;
  /** 趋势方向 */
  trendDir: 'UP' | 'DOWN' | 'NONE';
  /** 一句话解读 */
  interpretation: string;
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
  /** RSI 背离信号（顶背离/底背离），null = 无背离 */
  rsiDivergence: RsiDivergenceSignal | null;
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
  /** 波段交易策略（区间震荡 / 顺势抓浪 / 逆势反转） */
  swingStrategy: SwingStrategyDto;
  /** 趋势健康度与回调分析（Fibonacci 分级 + 量价配合 + ATR 斜率） */
  pullbackHealth: PullbackHealthDto;
  /** MACD 高阶分析（柱体动能强度 + 收缩 + 快线-柱体分离） */
  macdAdvanced: MacdAdvancedDto;
  /** 反转入场信号（三大信号共振：趋势转弱 + 回调变强 + 架构破坏 + 关键位） */
  reversalEntry: ReversalEntryDto;
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
