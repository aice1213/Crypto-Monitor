import { describe, it, expect } from 'vitest';
import type { FundingByExchange } from '@crypto-monitor/shared';
import {
  aggregateLiquidations,
  annualize,
  buildLiquiditySeries,
  getFomcSnapshot,
  getMacroCalendar,
  lastDecisionAsOf,
  parseFredCsv,
  PROBABILITY_SNAPSHOT_AT,
  topLiquidationLevels,
  weightFunding,
} from './macro.js';
import type { GateLiqOrder } from './gateio.js';

const liq = (orderSize: number, fillPrice: number): GateLiqOrder => ({
  time: 1_700_000_000,
  size: orderSize,
  orderSize,
  orderPrice: fillPrice,
  fillPrice,
});

describe('annualize（按各交易所实际结算周期年化）', () => {
  it('8 小时结算 => 每日 3 次', () => {
    expect(annualize(0.0001, 8)).toBeCloseTo(0.0001 * 3 * 365, 12);
  });

  it('4 小时结算 => 每日 6 次（原实现一律按 8 小时，会低估一半）', () => {
    expect(annualize(0.0001, 4)).toBeCloseTo(0.0001 * 6 * 365, 12);
  });

  it('周期非法时退回 8 小时，不产生 NaN/Infinity', () => {
    expect(annualize(0.0001, 0)).toBeCloseTo(0.0001 * 3 * 365, 12);
    expect(Number.isFinite(annualize(0.0001, NaN))).toBe(true);
  });
});

describe('weightFunding（审查项 F38：加权必须真的是加权）', () => {
  const e = (over: Partial<FundingByExchange>): FundingByExchange => ({
    exchange: 'X',
    fundingRate: 0,
    annualizedRate: 0,
    openInterest: 0,
    settlementHours: 8,
    ts: 0,
    ok: true,
    ...over,
  });

  it('有持仓量时按 OI 加权，并标记 weightedByOpenInterest=true', () => {
    const r = weightFunding([
      e({ exchange: 'A', fundingRate: 0.0001, annualizedRate: 0.1, openInterest: 100 }),
      e({ exchange: 'B', fundingRate: 0.0003, annualizedRate: 0.3, openInterest: 300 }),
    ]);
    expect(r.weightedByOpenInterest).toBe(true);
    expect(r.weightedFundingRate).toBeCloseTo((0.0001 * 100 + 0.0003 * 300) / 400, 12);
    expect(r.weightedAnnualizedRate).toBeCloseTo((0.1 * 100 + 0.3 * 300) / 400, 12);
  });

  it('全部缺 OI 时退化为算术平均，且**如实标记**为非加权', () => {
    const r = weightFunding([
      e({ exchange: 'A', fundingRate: 0.0001, annualizedRate: 0.1 }),
      e({ exchange: 'B', fundingRate: 0.0003, annualizedRate: 0.3 }),
    ]);
    expect(r.weightedByOpenInterest).toBe(false);
    expect(r.weightedFundingRate).toBeCloseTo(0.0002, 12);
    expect(r.weightedAnnualizedRate).toBeCloseTo(0.2, 12);
  });

  it('只用取数成功的交易所参与加权', () => {
    const r = weightFunding([
      e({ exchange: 'A', fundingRate: 0.0002, annualizedRate: 0.2, openInterest: 100 }),
      e({ exchange: 'B', ok: false, error: 'boom' }),
    ]);
    expect(r.availableCount).toBe(1);
    expect(r.weightedFundingRate).toBeCloseTo(0.0002, 12);
  });

  it('部分有 OI 时只对这部分加权（不把 0 权重混进来拉低结果）', () => {
    const r = weightFunding([
      e({ exchange: 'A', fundingRate: 0.0004, annualizedRate: 0.4, openInterest: 1000 }),
      e({ exchange: 'B', fundingRate: 0.0001, annualizedRate: 0.1, openInterest: 0 }),
    ]);
    expect(r.weightedByOpenInterest).toBe(true);
    expect(r.weightedFundingRate).toBeCloseTo(0.0004, 12);
  });

  it('全部失败时返回 0 且 availableCount=0', () => {
    const r = weightFunding([e({ ok: false }), e({ ok: false })]);
    expect(r.availableCount).toBe(0);
    expect(r.weightedFundingRate).toBe(0);
  });
});

describe('aggregateLiquidations（真实强平订单聚合）', () => {
  const MULT = 0.0001;

  it('order_size<0 计入多单强平，>0 计入空单强平', () => {
    // 负委托（卖出）=> 多头被强平；正委托（买入）=> 空头被强平
    const { cells, sampleCount, totalUsd } = aggregateLiquidations(
      [liq(-100, 80000), liq(50, 80000)],
      MULT,
      0.001,
    );
    expect(sampleCount).toBe(2);
    // 100 张 × 0.0001 × 80000 = 800 USDT；50 张 = 400 USDT
    expect(totalUsd).toBe(1200);
    const cell = cells.find((c) => Math.abs(c.price - 80000) < 1)!;
    expect(cell.longLiquidationUsd).toBe(800);
    expect(cell.shortLiquidationUsd).toBe(400);
  });

  it('相邻价位按桶宽聚合成一格', () => {
    // 桶宽 = 80000 × 0.1% = 80；79990 与 80050 落在同一桶
    const { cells } = aggregateLiquidations([liq(-10, 79990), liq(-10, 80050)], MULT, 0.001);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.longLiquidationUsd).toBeCloseTo(160, 0);
  });

  it('相差超过桶宽的价位分成两格，并按价格升序输出', () => {
    const { cells } = aggregateLiquidations([liq(-10, 81000), liq(-10, 79000)], MULT, 0.001);
    expect(cells).toHaveLength(2);
    expect(cells[0]!.price).toBeLessThan(cells[1]!.price);
  });

  it('过滤无效条目：价位非正、数量为 0', () => {
    const { cells, sampleCount } = aggregateLiquidations(
      [liq(-10, 0), liq(0, 80000), liq(-10, 80000)],
      MULT,
      0.001,
    );
    expect(sampleCount).toBe(1);
    expect(cells).toHaveLength(1);
  });

  it('quanto_multiplier 缺失时返回空结果而不是编造数字', () => {
    const r = aggregateLiquidations([liq(-10, 80000)], 0, 0.001);
    expect(r.cells).toEqual([]);
    expect(r.totalUsd).toBe(0);
  });

  it('空输入返回空结果', () => {
    expect(aggregateLiquidations([], MULT).cells).toEqual([]);
  });

  it('topLiquidationLevels 按总额降序取前 N', () => {
    const cells = [
      { price: 1, longLiquidationUsd: 10, shortLiquidationUsd: 0 },
      { price: 2, longLiquidationUsd: 100, shortLiquidationUsd: 50 },
      { price: 3, longLiquidationUsd: 20, shortLiquidationUsd: 0 },
    ];
    expect(topLiquidationLevels(cells, 2).map((l) => l.price)).toEqual([2, 3]);
    expect(topLiquidationLevels(cells, 2)[0]!.totalUsd).toBe(150);
  });
});

describe('parseFredCsv', () => {
  it('解析观察日与数值', () => {
    const csv = 'observation_date,WALCL\n2026-10-07,6747560\n2026-09-30,6700000\n';
    expect(parseFredCsv(csv)).toEqual([
      { date: '2026-10-07', value: 6747560 },
      { date: '2026-09-30', value: 6700000 },
    ]);
  });

  it("缺失值 '.' 必须跳过，不能当成 0", () => {
    const csv = 'observation_date,RRPONTSYD\n2026-10-08,0.335\n2026-10-09,.\n';
    expect(parseFredCsv(csv)).toEqual([{ date: '2026-10-08', value: 0.335 }]);
  });

  it('空行与表头异常不抛错', () => {
    expect(parseFredCsv('h\n\n2026-01-01,5\n')).toEqual([{ date: '2026-01-01', value: 5 }]);
    expect(parseFredCsv('')).toEqual([]);
  });
});

describe('buildLiquiditySeries（单位换算 + 对照日语义）', () => {
  const scale = { walcl: 1 / 1000, tga: 1 / 1000, rrp: 1 };

  it('WALCL/TGA 从百万美元换算为十亿美元，RRP 已是十亿美元', () => {
    const r = buildLiquiditySeries(
      {
        walcl: [{ date: '2026-10-07', value: 6_747_560 }],
        tga: [{ date: '2026-10-07', value: 880_253 }],
        rrp: [{ date: '2026-10-07', value: 0.335 }],
      },
      { scale },
    );
    expect(r.history).toHaveLength(1);
    // 6747.56 - 880.253 - 0.335 = 5866.972
    expect(r.history[0]!.netLiquidity).toBeCloseTo(5866.97, 1);
    expect(r.current).toBeCloseTo(5866.97, 1);
  });

  it('weeklyChange 与约 7 天前的观测点比较，并回传真实对照日', () => {
    const walcl = Array.from({ length: 4 }, (_, i) => ({
      // 每周三一个观测点
      date: `2026-09-${[16, 23, 30].concat([7]).map((d, k) => (k === 3 ? '10' : String(d).padStart(2, '0')))[i]}`,
      value: 6_700_000 + i * 10_000,
    }));
    const r = buildLiquiditySeries(
      { walcl, tga: [{ date: '2026-09-01', value: 0 }], rrp: [{ date: '2026-09-01', value: 0 }] },
      { scale },
    );
    // 不是取 history[length-3]，而是取距今 ≥7 天的最近一点
    expect(r.asOf).not.toBe(r.comparedTo);
    expect(r.comparedTo < r.asOf).toBe(true);
  });

  it('对照点相距不足 7 天时也能给出结果（数据稀疏场景不崩）', () => {
    const r = buildLiquiditySeries(
      {
        walcl: [
          { date: '2026-10-01', value: 6_700_000 },
          { date: '2026-10-03', value: 6_710_000 },
        ],
        tga: [{ date: '2026-10-01', value: 0 }],
        rrp: [{ date: '2026-10-01', value: 0 }],
      },
      { scale },
    );
    expect(r.history).toHaveLength(2);
    expect(Number.isFinite(r.weeklyChange)).toBe(true);
  });

  it('RRP 缺当日值时按日期取最近一个不晚于该日的观测（对齐日频与周频）', () => {
    const r = buildLiquiditySeries(
      {
        walcl: [{ date: '2026-10-07', value: 6_700_000 }],
        tga: [{ date: '2026-10-06', value: 800_000 }],
        rrp: [{ date: '2026-10-05', value: 1 }],
      },
      { scale },
    );
    expect(r.history).toHaveLength(1);
    expect(r.history[0]!.rrp).toBeCloseTo(1, 6);
  });

  it('完全无法对齐时返回空序列（由上层标记 live=false）', () => {
    const r = buildLiquiditySeries({ walcl: [], tga: [], rrp: [] }, { scale });
    expect(r.history).toEqual([]);
    expect(r.asOf).toBe('');
  });

  it('regime 阈值 ±50（十亿美元）', () => {
    const mk = (delta: number) =>
      buildLiquiditySeries(
        {
          walcl: [
            { date: '2026-09-30', value: 6_700_000 },
            { date: '2026-10-07', value: 6_700_000 + delta * 1000 },
          ],
          tga: [{ date: '2026-09-30', value: 0 }],
          rrp: [{ date: '2026-09-30', value: 0 }],
        },
        { scale },
      ).regime;
    expect(mk(100)).toBe('EXPANSION');
    expect(mk(0)).toBe('NEUTRAL');
    expect(mk(-100)).toBe('CONTRACTION');
    expect(mk(40)).toBe('NEUTRAL');
  });
});

describe('FOMC 快照（审查项 F38：时间语义必须诚实）', () => {
  it('snapshotUpdatedAt 是固定的录入时间，不是请求时间', () => {
    const a = getFomcSnapshot();
    const b = getFomcSnapshot();
    expect(a.snapshotUpdatedAt).toBe(PROBABILITY_SNAPSHOT_AT);
    expect(b.snapshotUpdatedAt).toBe(PROBABILITY_SNAPSHOT_AT);
    // 与当前时间差距应远超一次请求间隔
    expect(Math.abs(Date.now() - Date.parse(a.snapshotUpdatedAt))).toBeGreaterThan(60_000);
  });

  it('nextMeeting 取未来最近一次会议', () => {
    const snap = getFomcSnapshot();
    expect(Date.parse(snap.nextMeeting)).toBeGreaterThan(Date.now());
  });

  it('概率分布之和为 100', () => {
    const sum = getFomcSnapshot().probabilities.reduce((s, p) => s + p.probability, 0);
    expect(sum).toBe(100);
  });

  it('lastDecision 由已发生决议列表推导，而不是硬编码', () => {
    const decisions = [
      { date: '2026-01-01T00:00:00Z', decision: 'HOLD' as const, bps: 0 },
      { date: '2026-06-01T00:00:00Z', decision: 'CUT' as const, bps: 25 },
    ];
    const at = (iso: string) => lastDecisionAsOf(Date.parse(iso), decisions);

    expect(at('2025-12-31T00:00:00Z').decision).toBe('PENDING');
    expect(at('2026-03-01T00:00:00Z').decision).toBe('HOLD');
    expect(at('2026-07-01T00:00:00Z')).toEqual({ decision: 'CUT', bps: 25 });
  });

  it('当前快照的 lastDecision 与恒定日期一致（不会随请求时间漂移）', () => {
    const a = getFomcSnapshot();
    const b = getFomcSnapshot();
    expect(a.lastDecision).toBe(b.lastDecision);
    expect(a.lastDecisionBps).toBe(b.lastDecisionBps);
  });
});

describe('宏观日历', () => {
  it('只返回过去 7 天到未来 14 天的事件，并按时间升序', () => {
    const now = Date.parse('2026-10-09T00:00:00Z');
    const data = getMacroCalendar(now);
    for (const e of data.events) {
      const t = Date.parse(e.time);
      expect(t).toBeGreaterThan(now - 7 * 86400_000);
      expect(t).toBeLessThan(now + 14 * 86400_000);
    }
    const times = data.events.map((e) => Date.parse(e.time));
    expect(times.every((t, i) => i === 0 || times[i - 1]! <= t)).toBe(true);
  });

  it('24 小时内为 RED、3 天内为 YELLOW、更远为 GRAY', () => {
    const now = Date.parse('2026-11-04T00:00:00Z');
    const data = getMacroCalendar(now);
    const fed = data.events.find((e) => e.id === 'fed-nov-2026');
    expect(fed?.urgency).toBe('RED');
    const nfp = data.events.find((e) => e.id === 'nfp-nov-2026');
    expect(nfp?.urgency).toBe('YELLOW');
  });

  it('已过期事件不进入列表', () => {
    const now = Date.parse('2027-06-01T00:00:00Z');
    expect(getMacroCalendar(now).events).toHaveLength(0);
  });
});
