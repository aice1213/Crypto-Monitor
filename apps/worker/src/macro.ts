import type {
  FomcSnapshot,
  FundingByExchange,
  LiquidationCell,
  LiquidationHeatmap,
  LiquidityData,
  LiquidityPoint,
  MacroCalendarData,
  MacroCalendarEvent,
  MacroFundingData,
} from '@crypto-monitor/shared';
import { fetchContractMeta, fetchLiquidationOrders, type GateLiqOrder } from './gateio.js';

/**
 * 拉上游时的超时时间。
 *
 * 交易所接口与 FRED 分开设置：交易所接口要求快（用户直接看），
 * 而 FRED 的 CSV 端点从边缘节点访问明显更慢（实测在 workerd 里 8s 会超时，
 * 同样的 URL 在普通 Node 环境约 1.2s 返回），且该结果会被缓存 1 小时，
 * 因此给 FRED 更长的容忍时间。
 */
const EXCHANGE_TIMEOUT_MS = 8000;
const FRED_TIMEOUT_MS = 25_000;

async function fetchJson<T>(url: string, timeoutMs = EXCHANGE_TIMEOUT_MS): Promise<T> {
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function fetchText(url: string, timeoutMs = EXCHANGE_TIMEOUT_MS): Promise<string> {
  const res = await fetch(url, {
    headers: { Accept: 'text/csv', 'User-Agent': 'crypto-monitor/1.0' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/* ==================== 1. FOMC 快照（人工维护，时间语义必须诚实） ==================== */

/**
 * FOMC 会议日程（随美联储官方日历人工更新）。
 * `PROBABILITY_SNAPSHOT_AT` 是**概率分布被人工录入的时间**，是一个固定常量——
 * 早期实现把它写成 `new Date().toISOString()`（请求时间），会让 UI 误以为"刚刚更新过"。
 */
export const PROBABILITY_SNAPSHOT_AT = '2026-09-13T00:00:00Z';

const FOMC_MEETINGS: { date: string; name: string }[] = [
  { date: '2026-09-16T18:00:00Z', name: '2026年9月FOMC' },
  { date: '2026-11-04T18:00:00Z', name: '2026年11月FOMC' },
  { date: '2026-12-16T19:00:00Z', name: '2026年12月FOMC' },
  { date: '2027-01-27T19:00:00Z', name: '2027年1月FOMC' },
  { date: '2027-03-17T18:00:00Z', name: '2027年3月FOMC' },
];

/** 已发生的决议（人工维护，用于推导"上次决议"而不是硬编码一个常量） */
const PAST_DECISIONS: { date: string; decision: 'HIKE' | 'CUT' | 'HOLD'; bps: number }[] = [
  { date: '2026-07-29T18:00:00Z', decision: 'HOLD', bps: 0 },
  { date: '2026-06-17T18:00:00Z', decision: 'HIKE', bps: 25 },
  { date: '2026-04-29T18:00:00Z', decision: 'HIKE', bps: 25 },
];

/** 从已发生决议列表中取最近一次（按会议时间倒序） */
export function lastDecisionAsOf(
  nowMs: number,
  decisions: typeof PAST_DECISIONS = PAST_DECISIONS,
): { decision: 'HIKE' | 'CUT' | 'HOLD' | 'PENDING'; bps: number } {
  const past = decisions
    .filter((d) => new Date(d.date).getTime() <= nowMs)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const latest = past[0];
  return latest ? { decision: latest.decision, bps: latest.bps } : { decision: 'PENDING', bps: 0 };
}

export function getFomcSnapshot(): FomcSnapshot {
  const now = Date.now();
  const upcoming = FOMC_MEETINGS.find((m) => new Date(m.date).getTime() > now);
  const last = lastDecisionAsOf(now);

  // 利率概率分布（人工快照，重要节点前从 CME FedWatch 录入更新）
  const probabilities = [
    { rateFloor: 4.25, rateCeil: 4.5, probability: 10 },
    { rateFloor: 4.5, rateCeil: 4.75, probability: 35 },
    { rateFloor: 4.75, rateCeil: 5.0, probability: 40 },
    { rateFloor: 5.0, rateCeil: 5.25, probability: 12 },
    { rateFloor: 5.25, rateCeil: 5.5, probability: 3 },
  ];

  return {
    nextMeeting: upcoming?.date ?? FOMC_MEETINGS[0]!.date,
    meetingName: upcoming?.name ?? FOMC_MEETINGS[0]!.name,
    currentRateFloor: 4.25,
    currentRateCeil: 4.5,
    lastDecision: last.decision,
    lastDecisionBps: last.bps,
    probabilities,
    // 固定常量：真实的"人工录入时间"，而不是请求时间
    snapshotUpdatedAt: PROBABILITY_SNAPSHOT_AT,
    source: 'CME FedWatch（人工录入快照，需定期更新）· 仅供参考',
  };
}

/* ==================== 2. 14天宏观日历（人工维护事件库） ==================== */

const MACRO_EVENTS: Omit<MacroCalendarEvent, 'urgency'>[] = [
  {
    id: 'fed-nov-2026',
    time: '2026-11-04T18:00:00Z',
    title: '美联储FOMC利率决议',
    category: 'FED',
    level: 'S',
    note: '点阵图与鲍威尔记者会',
  },
  {
    id: 'cpi-oct-2026',
    time: '2026-10-14T12:30:00Z',
    title: '美国9月CPI数据',
    category: 'CPI',
    level: 'A',
  },
  {
    id: 'nfp-oct-2026',
    time: '2026-10-02T12:30:00Z',
    title: '美国9月非农就业',
    category: 'EMPLOYMENT',
    level: 'A',
  },
  {
    id: 'nfp-nov-2026',
    time: '2026-11-06T13:30:00Z',
    title: '美国10月非农就业',
    category: 'EMPLOYMENT',
    level: 'A',
  },
  {
    id: 'gdp-q3-2026',
    time: '2026-10-29T12:30:00Z',
    title: '美国Q3 GDP初值',
    category: 'GDP',
    level: 'A',
  },
  {
    id: 'ecb-oct-2026',
    time: '2026-10-23T12:15:00Z',
    title: '欧央行利率决议',
    category: 'ECB',
    level: 'A',
  },
  {
    id: 'boj-oct-2026',
    time: '2026-10-31T03:00:00Z',
    title: '日本央行利率决议',
    category: 'BOJ',
    level: 'B',
  },
  {
    id: 'fed-dec-2026',
    time: '2026-12-16T19:00:00Z',
    title: '美联储FOMC利率决议',
    category: 'FED',
    level: 'S',
  },
  {
    id: 'sec-eth-etf',
    time: '2026-10-15T00:00:00Z',
    title: 'SEC以太坊ETF裁决截止',
    category: 'CRYPTO',
    level: 'S',
    note: '关注现货ETH ETF审批进展',
  },
  {
    id: 'btc-halving',
    time: '2028-04-20T00:00:00Z',
    title: '比特币第五次减半',
    category: 'CRYPTO',
    level: 'S',
    note: '区块奖励减半事件',
  },
];

export function getMacroCalendar(nowMs = Date.now()): MacroCalendarData {
  const fourteenDays = 14 * 24 * 60 * 60 * 1000;

  const events: MacroCalendarEvent[] = MACRO_EVENTS.map((e) => {
    const diffMs = new Date(e.time).getTime() - nowMs;
    let urgency: MacroCalendarEvent['urgency'] = 'GRAY';
    if (diffMs < 0) urgency = 'GRAY';
    else if (diffMs < 24 * 60 * 60 * 1000) urgency = 'RED';
    else if (diffMs < 3 * 24 * 60 * 60 * 1000) urgency = 'YELLOW';
    return { ...e, urgency };
  })
    .filter((e) => {
      const t = new Date(e.time).getTime();
      return t > nowMs - 7 * 24 * 60 * 60 * 1000 && t < nowMs + fourteenDays;
    })
    .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

  return { events, updatedAt: nowMs };
}

/* ==================== 3. 多交易所资金费率（真实持仓量加权） ==================== */

/** 把交易所返回的费率按**各自实际的结算周期**年化 */
export function annualize(rate: number, settlementHours: number): number {
  const h = Number.isFinite(settlementHours) && settlementHours > 0 ? settlementHours : 8;
  return rate * (24 / h) * 365;
}

/**
 * 按持仓量加权。
 *
 * 修复要点（审查项 F38）：原实现里所有交易所 `openInterest` 恒为 0，
 * 于是永远走"简单平均"分支，但字段名与 UI 都写着"加权"。
 * 现在：
 * - 加权只用**取数成功且 OI 有效**的交易所；
 * - 全部 OI 缺失时退化为算术平均，并把 `weightedByOpenInterest` 置为 false，让 UI 如实标注。
 */
export function weightFunding(exchanges: FundingByExchange[]): {
  weightedFundingRate: number;
  weightedAnnualizedRate: number;
  weightedByOpenInterest: boolean;
  availableCount: number;
} {
  const ok = exchanges.filter((e) => e.ok);
  const availableCount = ok.length;
  if (availableCount === 0) {
    return { weightedFundingRate: 0, weightedAnnualizedRate: 0, weightedByOpenInterest: false, availableCount: 0 };
  }

  const withOi = ok.filter((e) => Number.isFinite(e.openInterest) && e.openInterest > 0);
  const totalOi = withOi.reduce((s, e) => s + e.openInterest, 0);
  const weightedByOpenInterest = totalOi > 0;

  if (weightedByOpenInterest) {
    return {
      weightedFundingRate: withOi.reduce((s, e) => s + e.fundingRate * e.openInterest, 0) / totalOi,
      weightedAnnualizedRate: withOi.reduce((s, e) => s + e.annualizedRate * e.openInterest, 0) / totalOi,
      weightedByOpenInterest: true,
      availableCount,
    };
  }

  return {
    weightedFundingRate: ok.reduce((s, e) => s + e.fundingRate, 0) / availableCount,
    weightedAnnualizedRate: ok.reduce((s, e) => s + e.annualizedRate, 0) / availableCount,
    weightedByOpenInterest: false,
    availableCount,
  };
}

async function safeFunding(
  exchange: string,
  load: () => Promise<{ fundingRate: number; openInterest: number; settlementHours: number }>,
): Promise<FundingByExchange> {
  const ts = Date.now();
  try {
    const d = await load();
    return {
      exchange,
      fundingRate: d.fundingRate,
      annualizedRate: annualize(d.fundingRate, d.settlementHours),
      openInterest: d.openInterest,
      settlementHours: d.settlementHours,
      ts,
      ok: true,
    };
  } catch (e) {
    return {
      exchange,
      fundingRate: 0,
      annualizedRate: 0,
      openInterest: 0,
      settlementHours: 8,
      ts,
      ok: false,
      error: e instanceof Error ? e.message : 'unknown',
    };
  }
}

export async function getMacroFunding(symbol: string, base: string): Promise<MacroFundingData> {
  const binanceSymbol = symbol.replace('_USDT', 'USDT').replace('_', '');
  const okxSymbol = symbol.replace('_USDT', '-USDT-SWAP');

  const exchanges = await Promise.all([
    // Gate.io：费率、结算周期、持仓量全部来自同一个合约对象
    safeFunding('Gate.io', async () => {
      const meta = await fetchContractMeta(symbol, base);
      return {
        fundingRate: meta.fundingRate,
        openInterest: meta.openInterestUsd,
        settlementHours: meta.fundingIntervalHours,
      };
    }),

    // Binance
    safeFunding('Binance', async () => {
      const [premium, oi] = await Promise.all([
        fetchJson<{ lastFundingRate?: string }>(
          `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${encodeURIComponent(binanceSymbol)}`,
        ),
        fetchJson<{ openInterest?: string; markPrice?: string }>(
          `https://fapi.binance.com/fapi/v1/openInterest?symbol=${encodeURIComponent(binanceSymbol)}`,
        ),
      ]);
      const rate = Number(premium.lastFundingRate);
      if (!Number.isFinite(rate)) throw new Error('malformed');
      const qty = Number(oi.openInterest);
      const mark = Number(oi.markPrice);
      return {
        fundingRate: rate,
        // openInterest 接口不返回 markPrice，按张数×标记价折算；取不到标记价则 OI 记为 0
        openInterest: Number.isFinite(qty) && Number.isFinite(mark) ? qty * mark : 0,
        settlementHours: 8,
      };
    }),

    // OKX
    safeFunding('OKX', async () => {
      const [fr, oi] = await Promise.all([
        fetchJson<{ data?: { fundingRate?: string; fundingTime?: string; nextFundingTime?: string }[] }>(
          `https://www.okx.com/api/v5/public/funding-rate?instId=${encodeURIComponent(okxSymbol)}`,
        ),
        fetchJson<{ data?: { oiUsd?: string; oiCcy?: string }[] }>(
          `https://www.okx.com/api/v5/public/open-interest?instId=${encodeURIComponent(okxSymbol)}`,
        ),
      ]);
      const row = fr.data?.[0];
      const rate = Number(row?.fundingRate);
      if (!Number.isFinite(rate)) throw new Error('malformed');
      // OKX 相邻两期时间差即结算周期
      const t0 = Number(row?.fundingTime);
      const t1 = Number(row?.nextFundingTime);
      const hours = Number.isFinite(t0) && Number.isFinite(t1) && t1 > t0 ? (t1 - t0) / 3600000 : 8;
      const oiUsd = Number(oi.data?.[0]?.oiUsd);
      return { fundingRate: rate, openInterest: Number.isFinite(oiUsd) ? oiUsd : 0, settlementHours: hours };
    }),
  ]);

  const agg = weightFunding(exchanges);
  return { symbol, exchanges, ...agg, ts: Date.now() };
}

/* ==================== 4. 清算热力图（真实强平订单） ==================== */

/** 价格桶宽度（相对现价的百分比） */
const LIQ_BUCKET_PCT = 0.001;

/**
 * 把强平订单聚合成价格热力。
 *
 * 方向约定（Gate.io 官方 SDK `FuturesLiqOrder`）：`size` 为仓位张数（带方向），
 * `order_size` 为强平委托张数 —— 负数为卖出委托，即**多头被强平**；正数为买入委托，即**空头被强平**。
 * 名义金额 = |order_size| × quanto_multiplier × fill_price。
 */
export function aggregateLiquidations(
  orders: GateLiqOrder[],
  quantoMultiplier: number,
  bucketPct = LIQ_BUCKET_PCT,
): { cells: LiquidationCell[]; sampleCount: number; totalUsd: number } {
  const valid = orders.filter(
    (o) =>
      Number.isFinite(o.orderSize) &&
      Number.isFinite(o.fillPrice) &&
      o.fillPrice > 0 &&
      o.orderSize !== 0,
  );
  if (valid.length === 0 || !Number.isFinite(quantoMultiplier) || quantoMultiplier <= 0) {
    return { cells: [], sampleCount: valid.length, totalUsd: 0 };
  }

  const reference = valid.reduce((s, o) => s + o.fillPrice, 0) / valid.length;
  const bucketSize = Math.max(reference * bucketPct, Number.EPSILON);

  const buckets = new Map<number, { long: number; short: number; count: number }>();
  let totalUsd = 0;
  for (const o of valid) {
    const usd = Math.abs(o.orderSize) * quantoMultiplier * o.fillPrice;
    totalUsd += usd;
    const idx = Math.round(o.fillPrice / bucketSize);
    const cell = buckets.get(idx) ?? { long: 0, short: 0, count: 0 };
    // order_size < 0 => 卖出委托 => 多头强平
    if (o.orderSize < 0) cell.long += usd;
    else cell.short += usd;
    cell.count++;
    buckets.set(idx, cell);
  }

  const cells: LiquidationCell[] = [...buckets.entries()]
    .map(([idx, v]) => ({
      price: Math.round(idx * bucketSize * 100) / 100,
      longLiquidationUsd: Math.round(v.long),
      shortLiquidationUsd: Math.round(v.short),
    }))
    .sort((a, b) => a.price - b.price);

  return { cells, sampleCount: valid.length, totalUsd: Math.round(totalUsd) };
}

export function topLiquidationLevels(
  cells: LiquidationCell[],
  n = 3,
): { price: number; totalUsd: number }[] {
  return [...cells]
    .map((c) => ({ price: c.price, totalUsd: c.longLiquidationUsd + c.shortLiquidationUsd }))
    .sort((a, b) => b.totalUsd - a.totalUsd)
    .slice(0, n);
}

/**
 * 清算热力图。
 *
 * 修复要点（审查项 F38）：原实现用 `Math.random()` 生成占位格子，且把横轴中心硬编码为
 * BTC=76000（实际价格约 83000），却带有"累计最大价位"等看起来像真实统计的字段。
 * 现在只使用 Gate.io 真实成交的强平订单；取不到数据时返回 `live: false` 且 `cells` 为空，
 * 由 UI 明确显示"暂不可用"，绝不编造。
 */
export async function getLiquidationHeatmap(
  symbol: string,
  base: string,
  windowHours = 1,
): Promise<LiquidationHeatmap> {
  const nowSec = Math.floor(Date.now() / 1000);
  const collectedSince = (nowSec - windowHours * 3600) * 1000;
  const baseMeta = {
    symbol,
    collectedSince,
    ts: Date.now(),
    windowHours,
    source: 'Gate.io /futures/usdt/liq_orders',
    disclaimer:
      '数据来源为 Gate.io 单一交易所的真实强平成交订单（单次查询上限 1 小时）。' +
      '样本仅覆盖该交易所，不代表全市场强平规模。',
  };

  try {
    const [orders, meta] = await Promise.all([
      fetchLiquidationOrders(symbol, base, windowHours, nowSec),
      fetchContractMeta(symbol, base),
    ]);
    const { cells, sampleCount, totalUsd } = aggregateLiquidations(orders, meta.quantoMultiplier);
    return {
      ...baseMeta,
      cells,
      topLevels: topLiquidationLevels(cells),
      live: true,
      sampleCount,
      totalUsd,
    };
  } catch (e) {
    return {
      ...baseMeta,
      cells: [],
      topLevels: [],
      live: false,
      sampleCount: 0,
      totalUsd: 0,
      reason: e instanceof Error ? e.message : 'unknown',
    };
  }
}

/* ==================== 5. 净流动性（FRED 实时数据） ==================== */

/** FRED 序列：id + 单位换算到"十亿美元"的系数 */
export const FRED_SERIES = {
  /** 美联储总资产，单位：百万美元 */
  walcl: { id: 'WALCL', scaleToBillions: 1 / 1000 },
  /** 财政部一般账户，单位：百万美元 */
  tga: { id: 'WTREGEN', scaleToBillions: 1 / 1000 },
  /** 隔夜逆回购，单位：十亿美元 */
  rrp: { id: 'RRPONTSYD', scaleToBillions: 1 },
} as const;

/**
 * 解析 FRED 的 CSV（`observation_date,SERIES`）。
 * 缺失值在 FRED 里写作 `.`，必须跳过而不是当成 0。
 */
export function parseFredCsv(text: string): { date: string; value: number }[] {
  const out: { date: string; value: number }[] = [];
  const lines = text.trim().split('\n');
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    const [date, raw] = line.split(',');
    if (!date || raw == null) continue;
    const value = Number(raw.trim());
    if (!Number.isFinite(value)) continue; // '.' 缺失值
    out.push({ date: date.trim(), value });
  }
  return out;
}

/** 取 `date` 当天或之前最近的一个观测值（RRP 是日频、WALCL 是周频，必须按日期对齐） */
function valueOnOrBefore(
  series: { date: string; value: number }[],
  date: string,
): { date: string; value: number } | null {
  let best: { date: string; value: number } | null = null;
  for (const p of series) {
    if (p.date <= date && (!best || p.date > best.date)) best = p;
  }
  return best;
}

/**
 * 组装净流动性序列。
 *
 * - 单位统一换算为"十亿美元"（WALCL/WTREGEN 原始单位为百万美元，RRP 已是十亿美元）。
 * - 以 WALCL 的观测日为骨架，按日期取 TGA / RRP 的最近值。
 * - `weeklyChange` 与**约 7 天前**的观测点相比，并回传 `comparedTo` 让 UI 如实标注；
 *   原实现取 `history[length-3]`（半月频样本下实际跨度 26 天）却标成"较上周"。
 */
export function buildLiquiditySeries(
  raw: {
    walcl: { date: string; value: number }[];
    tga: { date: string; value: number }[];
    rrp: { date: string; value: number }[];
  },
  opts: { scale: { walcl: number; tga: number; rrp: number }; maxPoints?: number; maxChangeDays?: number } = {
    scale: { walcl: 1 / 1000, tga: 1 / 1000, rrp: 1 },
  },
): {
  history: LiquidityPoint[];
  current: number;
  weeklyChange: number;
  asOf: string;
  comparedTo: string;
  regime: LiquidityData['regime'];
} {
  const maxPoints = opts.maxPoints ?? 30;
  const maxChangeDays = opts.maxChangeDays ?? 7;

  const sorted = [...raw.walcl].sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-maxPoints);
  const history: LiquidityPoint[] = [];
  for (const w of sorted) {
    const tga = valueOnOrBefore(raw.tga, w.date);
    const rrp = valueOnOrBefore(raw.rrp, w.date);
    if (!tga || !rrp) continue;
    const walclB = w.value * opts.scale.walcl;
    const tgaB = tga.value * opts.scale.tga;
    const rrpB = rrp.value * opts.scale.rrp;
    history.push({
      date: w.date,
      walcl: Math.round(walclB * 100) / 100,
      tga: Math.round(tgaB * 100) / 100,
      rrp: Math.round(rrpB * 100) / 100,
      netLiquidity: Math.round((walclB - tgaB - rrpB) * 100) / 100,
    });
  }

  if (history.length === 0) {
    return { history: [], current: 0, weeklyChange: 0, asOf: '', comparedTo: '', regime: 'NEUTRAL' };
  }

  const latest = history[history.length - 1]!;
  // 找"距最新观测日不超过 maxChangeDays 且尽量接近 7 天前"的那个观测点
  const cutoff = new Date(new Date(`${latest.date}T00:00:00Z`).getTime() - maxChangeDays * 86400_000)
    .toISOString()
    .slice(0, 10);
  const older = [...history].reverse().find((p) => p.date <= cutoff) ?? history[0]!;

  const weeklyChange = Math.round((latest.netLiquidity - older.netLiquidity) * 100) / 100;
  const regime: LiquidityData['regime'] =
    weeklyChange > 50 ? 'EXPANSION' : weeklyChange < -50 ? 'CONTRACTION' : 'NEUTRAL';

  return {
    history,
    current: latest.netLiquidity,
    weeklyChange,
    asOf: latest.date,
    comparedTo: older.date,
    regime,
  };
}

/** 拉取单个 FRED 序列的**原始值**（不做单位换算，换算统一交给 buildLiquiditySeries） */
async function fredSeries(key: keyof typeof FRED_SERIES, days = 200): Promise<{ date: string; value: number }[]> {
  const { id } = FRED_SERIES[key];
  const cosd = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  // FRED 的 CSV 下载端点无需 API Key
  const text = await fetchText(
    `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${cosd}`,
    FRED_TIMEOUT_MS,
  );
  return parseFredCsv(text);
}

/**
 * 净流动性（WALCL − TGA − RRP）。
 *
 * 修复要点（审查项 F38）：原实现返回一段硬编码的示例序列，却在 UI 上标注为
 * "FRED (WALCL/WTREGEN/RRPONTSYD) · 示例数据，部署 Cron 后自动更新"，
 * 且把相差 26 天的两点标成"较上周变动"。现在实时拉取 FRED（无需 Key 的 CSV 端点）。
 */
export async function getLiquidityData(): Promise<LiquidityData> {
  const base = {
    updatedAt: Date.now(),
    source: 'FRED（WALCL / WTREGEN / RRPONTSYD，单位已统一为十亿美元）',
  };
  try {
    const [walcl, tga, rrp] = await Promise.all([
      fredSeries('walcl'),
      fredSeries('tga'),
      fredSeries('rrp'),
    ]);
    if (walcl.length === 0) throw new Error('FRED 返回为空');

    const series = buildLiquiditySeries(
      { walcl, tga, rrp },
      {
        // 单位换算：WALCL / WTREGEN 原始单位为百万美元，RRPONTSYD 已是十亿美元
        scale: {
          walcl: FRED_SERIES.walcl.scaleToBillions,
          tga: FRED_SERIES.tga.scaleToBillions,
          rrp: FRED_SERIES.rrp.scaleToBillions,
        },
      },
    );
    if (series.history.length === 0) throw new Error('序列无法对齐');

    return { ...base, ...series, live: true };
  } catch (e) {
    return {
      ...base,
      current: 0,
      weeklyChange: 0,
      regime: 'NEUTRAL',
      history: [],
      live: false,
      reason: e instanceof Error ? e.message : 'unknown',
    };
  }
}
