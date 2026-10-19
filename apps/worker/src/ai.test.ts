import { describe, it, expect, vi } from 'vitest';
import type { IndicatorSnapshotDto } from '@crypto-monitor/shared';
import { buildPrompt, consumeDailyQuota, generateStrategy, parseAiTrend } from './ai.js';

function snapshot(over: Partial<IndicatorSnapshotDto> = {}): IndicatorSnapshotDto {
  return {
    ema7: 105,
    ema25: 100,
    ema50: 98,
    ema99: 95,
    ema200: 90,
    emaStructure: 'BULLISH',
    rsi14: 58.5,
    rsiZone: 'NEUTRAL',
    macd: { dif: 1.2, dea: 0.8, hist: 0.8, signal: 'NO_SIGNAL', signalAge: null },
    obv: { value: 100, ma20: 90, flow: 'INFLOW', volumeRatio: 1.1, volumeAvg20ChangePct: 10 },
    trend: { score: 55, direction: 'BULLISH' },
    support: [98, 95, 90],
    resistance: [102, 105, 110],
    patterns: [],
    marketState: { state: 'NARROW_RANGE', interpretation: '区间收窄，等待方向选择' },
    maStrategy: { trendFilter: 'LONG_ONLY', retestCount: 1, nearEma50: false, signalStatus: 'WAITING', interpretation: '🟡 第1次回踩 EMA50，回踩次数不足2次，价值区未确认' },
    plan: null,
    dataQuality: 'FULL',
    ...over,
  };
}

const ticker = { last: 101, change24h: 0.012 };

describe('parseAiTrend（审查项 F31）', () => {
  it('解析结构化首行的方向', () => {
    expect(parseAiTrend('方向: 看多\n**结论**：...')).toBe('BULLISH');
    expect(parseAiTrend('方向: 看空\n**结论**：...')).toBe('BEARISH');
    expect(parseAiTrend('方向: 观望\n**结论**：...')).toBe('RANGING');
  });

  it('支持全角冒号与近义词', () => {
    expect(parseAiTrend('方向：偏多')).toBe('BULLISH');
    expect(parseAiTrend('方向：偏空')).toBe('BEARISH');
    expect(parseAiTrend('方向：中性')).toBe('RANGING');
  });

  it('正文里出现的"看多"不会被误当成方向', () => {
    expect(parseAiTrend('**结论**：当前更适合看多')).toBeNull();
    expect(parseAiTrend('若价格站上看多则追')).toBeNull();
  });

  it('缺少方向行时返回 null', () => {
    expect(parseAiTrend('')).toBeNull();
    expect(parseAiTrend('**结论**：观望')).toBeNull();
  });
});

describe('buildPrompt', () => {
  it('要求模型单独给出可解析的方向行', () => {
    const p = buildPrompt('BTC_USDT', '15m', ticker, snapshot());
    expect(p).toContain('方向: 看多');
    expect(p).toContain('只能写 看多、看空、观望 三者之一');
  });

  it('MACD 信号带上新鲜度（审查项 F19）', () => {
    const fresh = buildPrompt('S', '15m', ticker, snapshot({ macd: { dif: 1, dea: 0, hist: 1, signal: 'GOLDEN_CROSS', signalAge: 0 } }));
    expect(fresh).toContain('（当根交叉）');

    const recent = buildPrompt('S', '15m', ticker, snapshot({ macd: { dif: 1, dea: 0, hist: 1, signal: 'GOLDEN_CROSS', signalAge: 2 } }));
    expect(recent).toContain('近 2 根内，非当根');

    const none = buildPrompt('S', '15m', ticker, snapshot());
    expect(none).toContain('信号 NO_SIGNAL');
    expect(none).not.toContain('交叉）');
  });

  it('plan 为 null 时明确告知模型"无计划"', () => {
    expect(buildPrompt('S', '15m', ticker, snapshot())).toContain('不满足盈亏比要求，无计划');
  });
});

describe('generateStrategy：一致性校验（审查项 F31）', () => {
  const ctx = (run: (m: string, o: unknown) => Promise<unknown>) =>
    ({ AI: { run } as unknown as Ai, AI_DAILY_LIMIT: '100' });

  it('AI 方向与规则引擎一致时 consensus=ALIGNED，且 trend 取 AI 自己的方向', async () => {
    const r = await generateStrategy({
      symbol: 'BTC_USDT',
      interval: '15m',
      ticker,
      snap: snapshot({ trend: { score: 55, direction: 'BULLISH' } }),
      ctx: ctx(async () => ({ response: '方向: 看多\n**结论**：偏多。' })),
    });
    expect(r.signals.consensus).toBe('ALIGNED');
    expect(r.signals.trend).toBe('BULLISH');
    expect(r.signals.engineTrend).toBe('BULLISH');
    expect(r.degraded).toBe(false);
    expect(r.model).not.toBe('rule-engine-fallback');
  });

  it('AI 方向与规则引擎相反时 consensus=DIVERGED（修复前该字段恒为一致）', async () => {
    const r = await generateStrategy({
      symbol: 'BTC_USDT',
      interval: '15m',
      ticker,
      snap: snapshot({ trend: { score: 55, direction: 'BULLISH' } }),
      ctx: ctx(async () => ({ response: '方向: 看空\n**结论**：转弱。' })),
    });
    expect(r.signals.consensus).toBe('DIVERGED');
    expect(r.signals.trend).toBe('BEARISH');
    expect(r.signals.engineTrend).toBe('BULLISH');
  });

  it('AI 未给出方向行时 consensus=UNKNOWN 且回退为规则引擎方向', async () => {
    const r = await generateStrategy({
      symbol: 'BTC_USDT',
      interval: '15m',
      ticker,
      snap: snapshot({ trend: { score: -55, direction: 'BEARISH' } }),
      ctx: ctx(async () => ({ response: '**结论**：看不清。' })),
    });
    expect(r.signals.consensus).toBe('UNKNOWN');
    expect(r.signals.trend).toBe('BEARISH');
  });

  it('AI 抛错时降级为规则引擎文本，且标记原因', async () => {
    const r = await generateStrategy({
      symbol: 'BTC_USDT',
      interval: '15m',
      ticker,
      snap: snapshot(),
      ctx: ctx(async () => {
        throw new Error('boom');
      }),
    });
    expect(r.degraded).toBe(true);
    expect(r.degradedReason).toBe('AI_UNAVAILABLE');
    expect(r.model).toBe('rule-engine-fallback');
  });

  it('AI 返回空文本时降级', async () => {
    const r = await generateStrategy({
      symbol: 'BTC_USDT',
      interval: '15m',
      ticker,
      snap: snapshot(),
      ctx: ctx(async () => ''),
    });
    expect(r.degraded).toBe(true);
  });

  it('没有 AI 绑定时降级', async () => {
    const r = await generateStrategy({
      symbol: 'BTC_USDT',
      interval: '15m',
      ticker,
      snap: snapshot(),
      ctx: { AI_DAILY_LIMIT: '100' },
    });
    expect(r.degraded).toBe(true);
    expect(r.degradedReason).toBe('AI_UNAVAILABLE');
  });

  it('AI_ENABLED=false 时直接降级且不调用模型', async () => {
    const run = vi.fn();
    const r = await generateStrategy({
      symbol: 'BTC_USDT',
      interval: '15m',
      ticker,
      snap: snapshot(),
      ctx: { AI: { run } as unknown as Ai, AI_ENABLED: 'false' },
    });
    expect(r.degradedReason).toBe('AI_DISABLED');
    expect(run).not.toHaveBeenCalled();
  });
});

describe('兜底文案必须来自真实快照（审查项 F29）', () => {
  async function fallback(snap: IndicatorSnapshotDto) {
    return generateStrategy({
      symbol: 'BTC_USDT',
      interval: '15m',
      ticker,
      snap,
      ctx: { AI_DAILY_LIMIT: '100' }, // 无 AI 绑定 => 走兜底
    });
  }

  it('结论跟随规则引擎方向，不再硬编码"观望"', async () => {
    const bull = await fallback(snapshot({ trend: { score: 55, direction: 'BULLISH' } }));
    expect(bull.summary).toContain('偏多');
    expect(bull.summary).not.toContain('当前更适合观望');

    const bear = await fallback(snapshot({ trend: { score: -55, direction: 'BEARISH' } }));
    expect(bear.summary).toContain('偏空');

    const range = await fallback(snapshot({ trend: { score: 0, direction: 'RANGING' } }));
    expect(range.summary).toContain('震荡');
  });

  it('不再声称"动量没有进入极端区"（当 RSI 确实超买时）', async () => {
    const r = await fallback(snapshot({ rsi14: 78.2, rsiZone: 'OVERBOUGHT' }));
    expect(r.summary).not.toContain('没有进入极端区');
    expect(r.summary).toContain('超买');
    expect(r.summary).toContain('78.2');
  });

  it('关键位取最近一级（而不是最远一级）', async () => {
    // 契约：support 降序 / resistance 升序，[0] 为最近
    const r = await fallback(snapshot({ support: [98, 95, 90], resistance: [102, 105, 110] }));
    expect(r.summary).toContain('102.00');
    expect(r.summary).toContain('98.00');
    // 最远的 90 / 110 不得作为"关键位"
    expect(r.summary).not.toContain('110.00');
  });

  it('关键位缺失时给出占位而不是 0.00', async () => {
    const r = await fallback(snapshot({ support: [], resistance: [] }));
    expect(r.summary).toContain('暂无可信阻力');
    expect(r.summary).toContain('暂无可信支撑');
    expect(r.summary).not.toContain('0.000000');
  });

  it('MACD 描述带上新鲜度', async () => {
    const r = await fallback(
      snapshot({ macd: { dif: 1, dea: 0, hist: 1, signal: 'GOLDEN_CROSS', signalAge: 2 } }),
    );
    expect(r.summary).toContain('金叉（近 2 根内）');
  });

  it('兜底时 consensus 为 ALIGNED（文本本就是引擎结论）', async () => {
    const r = await fallback(snapshot());
    expect(r.signals.consensus).toBe('ALIGNED');
    expect(r.signals.trend).toBe(r.signals.engineTrend);
  });
});

describe('日额度计数（审查项 F32）', () => {
  it('KV 可用时跨调用累计并在超限后拒绝', async () => {
    const store = new Map<string, string>();
    const kv = {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
    } as unknown as KVNamespace;

    expect(await consumeDailyQuota({ KV: kv }, 2)).toBe(true);
    expect(await consumeDailyQuota({ KV: kv }, 2)).toBe(true);
    expect(await consumeDailyQuota({ KV: kv }, 2)).toBe(false);
    expect([...store.values()]).toEqual(['2']);
  });

  it('额度耗尽后走兜底并标记 QUOTA_EXHAUSTED', async () => {
    const store = new Map<string, string>([['ai:quota:' + new Date().toISOString().slice(0, 10), '100']]);
    const kv = {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
    } as unknown as KVNamespace;
    const run = vi.fn();
    const r = await generateStrategy({
      symbol: 'BTC_USDT',
      interval: '15m',
      ticker,
      snap: snapshot(),
      ctx: { AI: { run } as unknown as Ai, AI_DAILY_LIMIT: '100', KV: kv },
    });
    expect(r.degradedReason).toBe('QUOTA_EXHAUSTED');
    expect(r.summary).toContain('AI 额度已用尽');
    expect(run).not.toHaveBeenCalled();
  });

  it('KV 抛错时退回进程内计数，不抛异常、不影响主流程', async () => {
    const kv = {
      get: async () => {
        throw new Error('kv down');
      },
      put: async () => undefined,
    } as unknown as KVNamespace;
    // 注意：内存兜底计数器是模块级状态，会被本文件里其它不带 KV 的用例累加，
    // 因此这里用一个不可能触顶的上限，只断言"KV 故障不会让流程失败"。
    await expect(consumeDailyQuota({ KV: kv }, 1_000_000)).resolves.toBe(true);
  });
});
