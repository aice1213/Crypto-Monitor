import type {
  AiDegradedReason,
  AiStrategyDto,
  IndicatorSnapshotDto,
  TrendDirection,
} from '@crypto-monitor/shared';
import { AI_DISCLAIMER, AI_CACHE_TTL_SEC, fmtPrice } from '@crypto-monitor/shared';

export interface AiContext {
  AI?: Ai;
  AI_PROVIDER?: string;
  AI_ENABLED?: string;
  AI_DAILY_LIMIT?: string;
  OPENAI_API_KEY?: string;
  /** 用于跨实例共享日额度计数（审查项 F32） */
  KV?: KVNamespace;
}

/** 从 AI 输出的首行解析方向；解析不到返回 null */
export function parseAiTrend(text: string): TrendDirection | null {
  // 只认"方向:"这一行的取值，避免在正文里到处匹配到"看多/看空"
  const m = text.match(/方向\s*[:：]\s*(看多|看空|偏多|偏空|观望|中性)/);
  if (!m) return null;
  const v = m[1]!;
  if (v === '看多' || v === '偏多') return 'BULLISH';
  if (v === '看空' || v === '偏空') return 'BEARISH';
  return 'RANGING';
}

function confidenceOf(score: number): 'HIGH' | 'MEDIUM' | 'LOW' {
  const abs = Math.abs(score);
  return abs >= 70 ? 'HIGH' : abs >= 40 ? 'MEDIUM' : 'LOW';
}

/**
 * 构建 Prompt（dev.md 6.1）
 */
export function buildPrompt(
  symbol: string,
  interval: string,
  ticker: { last: number; change24h: number },
  snap: IndicatorSnapshotDto,
): string {
  const planText = snap.plan
    ? `方向 ${snap.plan.side}，进场区 ${fmtPrice(snap.plan.entryLow)}~${fmtPrice(snap.plan.entryHigh)}，TP1 ${fmtPrice(snap.plan.tp1)}，TP2 ${fmtPrice(snap.plan.tp2)}，SL ${fmtPrice(snap.plan.sl)}，盈亏比 ${snap.plan.rrRatio.toFixed(2)}`
    : '不满足盈亏比要求，无计划';

  return `你是加密货币策略分析师。不要复述指标数值，也不要把决策面板抄一遍。
你的任务只有一件事：解释“为什么现在会是这样”。
重点说明结构、动量、量能三者为什么互相确认或互相打架。
若数据不足或互相矛盾，要明确说明现在更适合等待什么条件再重新评估。

请输出 Markdown，固定包含以下栏目：

**方向**：必须单独一行，且只能写 看多、看空、观望 三者之一，格式为 \`方向: 看多\`  
**结论**：一句话说明当前更适合做多、做空、观望，还是等待条件确认  
**原因**：3-4 条，逐条解释为什么。每条都要把 EMA、RSI、MACD、OBV、支撑阻力中的至少 3 项联系起来说清楚  
**关键位**：只写 1-2 个最关键价位，并说明为什么它们决定后续判断  
**会改变判断的条件**：1-2 条，说明什么变化会推翻当前结论

要求：
- 不要列重复数字，不要写完整交易计划。
- 不要说“信号良好”“建议入场”这种空话。
- 必须解释因果，不要只描述现象。
- 如果当前不适合交易，也要说清楚为什么不适合。

[输入数据]
标的: ${symbol}  周期: ${interval}  时间: ${new Date().toISOString()}
价格: ${fmtPrice(ticker.last)} (24h ${(ticker.change24h * 100).toFixed(2)}%)
EMA结构: ${snap.emaStructure}  RSI14: ${snap.rsi14.toFixed(1)} (${snap.rsiZone})
MACD: DIF ${snap.macd.dif.toFixed(4)} DEA ${snap.macd.dea.toFixed(4)} 信号 ${snap.macd.signal}${
    snap.macd.signalAge === 0
      ? '（当根交叉）'
      : snap.macd.signalAge != null
        ? `（近 ${snap.macd.signalAge} 根内，非当根）`
        : ''
  }
OBV流向: ${snap.obv.flow}  支撑 [${snap.support.map(fmtPrice).join(', ')}] 阻力 [${snap.resistance
    .map(fmtPrice)
    .join(', ')}]
规则引擎评分: ${snap.trend.score} (${snap.trend.direction})
交易计划: ${planText}`;
}

const memoryDailyCount: { date: string; count: number } = { date: '', count: 0 };

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function secondsUntilTomorrow(): number {
  const now = Date.now();
  const tomorrow = Date.UTC(
    new Date(now).getUTCFullYear(),
    new Date(now).getUTCMonth(),
    new Date(now).getUTCDate() + 1,
  );
  return Math.max(60, Math.floor((tomorrow - now) / 1000));
}

/**
 * 日额度计数（审查项 F32）。
 *
 * 原先只用模块级变量，随 isolate 重建清零、多实例各算一份，额度形同虚设。
 * 现在优先写 KV（跨实例、带到期时间），KV 不可用时退回进程内计数。
 * 注意：KV 为最终一致，计数不是严格限额，但已远好于"每个实例各一份"。
 */
export async function consumeDailyQuota(ctx: AiContext, limit: number): Promise<boolean> {
  const key = `ai:quota:${today()}`;
  if (ctx.KV) {
    try {
      const raw = await ctx.KV.get(key);
      const used = raw ? parseInt(raw, 10) : 0;
      const count = Number.isFinite(used) ? used : 0;
      if (count >= limit) return false;
      await ctx.KV.put(key, String(count + 1), { expirationTtl: secondsUntilTomorrow() + 3600 });
      return true;
    } catch {
      // KV 异常时退回内存计数，不影响主流程
    }
  }
  if (memoryDailyCount.date !== today()) {
    memoryDailyCount.date = today();
    memoryDailyCount.count = 0;
  }
  if (memoryDailyCount.count >= limit) return false;
  memoryDailyCount.count++;
  return true;
}

/**
 * 调用 Workers AI / OpenAI 生成策略（dev.md 6.2）
 */
export async function generateStrategy(params: {
  symbol: string;
  interval: string;
  ticker: { last: number; change24h: number };
  snap: IndicatorSnapshotDto;
  ctx: AiContext;
}): Promise<AiStrategyDto> {
  const { symbol, interval, ticker, snap, ctx } = params;

  if (ctx.AI_ENABLED === 'false') {
    return fallbackStrategy(symbol, snap, 'AI_DISABLED');
  }

  const rawLimit = parseInt(ctx.AI_DAILY_LIMIT ?? '500', 10);
  const dailyLimit = Number.isFinite(rawLimit) ? rawLimit : 500;
  const allowed = await consumeDailyQuota(ctx, dailyLimit);
  if (!allowed) {
    return fallbackStrategy(symbol, snap, 'QUOTA_EXHAUSTED');
  }

  const prompt = buildPrompt(symbol, interval, ticker, snap);
  const engineTrend = snap.trend.direction;

  try {
    let summary = '';
    let model = '';

    if (ctx.AI_PROVIDER === 'openai' && ctx.OPENAI_API_KEY) {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ctx.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 800,
        }),
      });
      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
        model?: string;
      };
      summary = data.choices?.[0]?.message?.content ?? '';
      model = data.model ?? 'openai';
    } else if (ctx.AI) {
      const resp = await ctx.AI.run('@cf/meta/llama-3.1-8b-instruct', {
        prompt,
        max_tokens: 800,
      });
      summary =
        typeof resp === 'string'
          ? resp
          : (resp as { response?: string }).response ?? '';
      model = '@cf/meta/llama-3.1-8b-instruct';
    } else {
      return fallbackStrategy(symbol, snap, 'AI_UNAVAILABLE');
    }

    if (!summary) return fallbackStrategy(symbol, snap, 'AI_UNAVAILABLE');

    // 一致性校验（dev.md 6.2）：解析 AI 自己的方向并与规则引擎对照。
    // 不一致时由 UI 标注"AI 观点与规则引擎存在分歧"，并以后者为准展示。
    const aiTrend = parseAiTrend(summary);
    return {
      symbol,
      summary,
      signals: {
        trend: aiTrend ?? engineTrend,
        confidence: confidenceOf(snap.trend.score),
        consensus: aiTrend == null ? 'UNKNOWN' : aiTrend === engineTrend ? 'ALIGNED' : 'DIVERGED',
        engineTrend,
      },
      disclaimer: AI_DISCLAIMER,
      generatedAt: Date.now(),
      model,
      degraded: false,
    };
  } catch {
    return fallbackStrategy(symbol, snap, 'AI_UNAVAILABLE');
  }
}

/** 规则引擎兜底文本：结论与依据必须来自真实快照，不得硬编码"观望" */
function fallbackStrategy(
  symbol: string,
  snap: IndicatorSnapshotDto,
  reason: AiDegradedReason = 'AI_DISABLED',
): AiStrategyDto {
  // 契约：support 降序 / resistance 升序，两者都是"离现价最近优先"。
  // 原实现用 min/max 取到的是**最远**的支撑与阻力，与"关键位"语义相反。
  const nearestSupport = snap.support[0];
  const nearestResistance = snap.resistance[0];

  const dirText =
    snap.trend.direction === 'BULLISH' ? '偏多' : snap.trend.direction === 'BEARISH' ? '偏空' : '震荡';
  const emaText =
    snap.emaStructure === 'BULLISH' ? '多头排列' : snap.emaStructure === 'BEARISH' ? '空头排列' : '均线缠绕';
  const { signal, signalAge, hist } = snap.macd;
  const macdText =
    signal === 'GOLDEN_CROSS'
      ? signalAge === 0
        ? '当根金叉'
        : `金叉（近 ${signalAge} 根内）`
      : signal === 'DEATH_CROSS'
        ? signalAge === 0
          ? '当根死叉'
          : `死叉（近 ${signalAge} 根内）`
        : hist > 0
          ? '柱线为正'
          : '柱线为负';
  const obvText =
    snap.obv.flow === 'INFLOW' ? 'OBV 流入' : snap.obv.flow === 'OUTFLOW' ? 'OBV 流出' : 'OBV 中性';
  const rsiText = `RSI ${snap.rsi14.toFixed(1)}（${
    snap.rsiZone === 'OVERBOUGHT' ? '超买' : snap.rsiZone === 'OVERSOLD' ? '超卖' : '中性'
  }）`;

  const aboveText = nearestResistance != null ? fmtPrice(nearestResistance) : '暂无可信阻力';
  const belowText = nearestSupport != null ? fmtPrice(nearestSupport) : '暂无可信支撑';

  const header =
    reason === 'QUOTA_EXHAUSTED'
      ? '> AI 额度已用尽，今日展示规则引擎策略\n\n'
      : reason === 'AI_UNAVAILABLE'
        ? '> AI 服务暂不可用，以下为规则引擎策略\n\n'
        : '> AI 功能已关闭，以下为规则引擎策略\n\n';

  const action =
    snap.trend.direction === 'BULLISH'
      ? '顺势偏多，但需等关键位确认后再动手'
      : snap.trend.direction === 'BEARISH'
        ? '顺势偏空，反弹至关键位是更优的介入位置'
        : '方向未明，区间内不追单，等突破或跌破后再评估';

  const summary = `${header}**结论**：规则引擎判定当前${dirText}（评分 ${snap.trend.score}）。${action}。  
**原因**：EMA ${emaText}；${rsiText}；MACD ${macdText}；${obvText}。四者共同给出了上述方向判断。  
**关键位**：上方 ${aboveText}、下方 ${belowText} 决定后续是延续还是转震荡。  
**会改变判断的条件**：价格站稳 ${aboveText} 之上，或有效跌破 ${belowText}。`;

  return {
    symbol,
    summary,
    signals: {
      // 兜底文本本身就是规则引擎的结论，方向必然一致
      trend: snap.trend.direction,
      confidence: confidenceOf(snap.trend.score),
      consensus: 'ALIGNED',
      engineTrend: snap.trend.direction,
    },
    disclaimer: AI_DISCLAIMER,
    generatedAt: Date.now(),
    model: 'rule-engine-fallback',
    degraded: true,
    degradedReason: reason,
  };
}

export { AI_CACHE_TTL_SEC };
