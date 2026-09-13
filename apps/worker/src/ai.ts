import type { AiStrategyDto, IndicatorSnapshotDto } from '@crypto-monitor/shared';
import { AI_DISCLAIMER, AI_CACHE_TTL_SEC } from '@crypto-monitor/shared';

export interface AiContext {
  AI?: Ai;
  AI_PROVIDER?: string;
  AI_ENABLED?: string;
  AI_DAILY_LIMIT?: string;
  OPENAI_API_KEY?: string;
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
    ? `方向 ${snap.plan.side}，进场区 ${snap.plan.entryLow.toFixed(2)}~${snap.plan.entryHigh.toFixed(
        2,
      )}，TP1 ${snap.plan.tp1.toFixed(2)}，TP2 ${snap.plan.tp2.toFixed(2)}，SL ${snap.plan.sl.toFixed(
        2,
      )}，盈亏比 ${snap.plan.rrRatio.toFixed(2)}`
    : '不满足盈亏比要求，无计划';

  return `你是加密货币策略分析师，不是指标复读机。不要简单复述输入数据，必须把数据翻译成有参考价值的策略方案。
禁止臆造未提供的信息；若数据冲突或不足，明确说明“信号冲突，建议观望”。

请输出 Markdown，使用交易员速读格式，固定包含以下栏目：

**方向**：LONG / SHORT / RANGING  
**仓位**：试仓 / 标准 / 观望  
**入场**：给出明确的进场区或等待条件  
**止损**：给出明确的失效位  
**止盈**：给出 TP1 / TP2  
**理由**：一句话解释为什么这样判断，必须引用 EMA、RSI、MACD、OBV、支撑阻力中的至少 3 项  
**失效条件**：一句话说明何时撤销策略  
**备选方案**：1-2 条，如突破追入、回踩反抽、突破失败反向  
**风险控制**：一句话给出分批、仓位、风险提示

要求：
- 简洁，像交易员写给交易员的执行单。
- 不要长篇解释，不要重复同一组数字。
- 若存在 plan，必须直接引用并解释其成立条件。
- 若不存在 plan，明确写“观望”，并写出等待什么条件再重评。

[输入数据]
标的: ${symbol}  周期: ${interval}  时间: ${new Date().toISOString()}
价格: ${ticker.last} (24h ${(ticker.change24h * 100).toFixed(2)}%)
EMA结构: ${snap.emaStructure}  RSI14: ${snap.rsi14.toFixed(1)} (${snap.rsiZone})
MACD: DIF ${snap.macd.dif.toFixed(4)} DEA ${snap.macd.dea.toFixed(4)} 信号 ${snap.macd.signal}
OBV流向: ${snap.obv.flow}  支撑 [${snap.support.map((p) => p.toFixed(2)).join(', ')}] 阻力 [${snap.resistance
    .map((p) => p.toFixed(2))
    .join(', ')}]
规则引擎评分: ${snap.trend.score} (${snap.trend.direction})
交易计划: ${planText}`;
}

const dailyCallCount: { date: string; count: number } = { date: '', count: 0 };

function checkDailyLimit(limit: number): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (dailyCallCount.date !== today) {
    dailyCallCount.date = today;
    dailyCallCount.count = 0;
  }
  if (dailyCallCount.count >= limit) return false;
  dailyCallCount.count++;
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
    return fallbackStrategy(symbol, snap);
  }

  const dailyLimit = parseInt(ctx.AI_DAILY_LIMIT ?? '500', 10);
  if (!checkDailyLimit(dailyLimit)) {
    return fallbackStrategy(symbol, snap, true);
  }

  const prompt = buildPrompt(symbol, interval, ticker, snap);

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
      return fallbackStrategy(symbol, snap);
    }

    if (!summary) return fallbackStrategy(symbol, snap);

    return {
      symbol,
      summary,
      signals: {
        trend: snap.trend.direction,
        confidence:
          Math.abs(snap.trend.score) >= 70
            ? 'HIGH'
            : Math.abs(snap.trend.score) >= 40
              ? 'MEDIUM'
              : 'LOW',
      },
      disclaimer: AI_DISCLAIMER,
      generatedAt: Date.now(),
      model,
    };
  } catch {
    return fallbackStrategy(symbol, snap);
  }
}

function fallbackStrategy(
  symbol: string,
  snap: IndicatorSnapshotDto,
  quotaExhausted = false,
): AiStrategyDto {
  const supportLo = snap.support.length ? Math.min(...snap.support) : null;
  const resistanceLo = snap.resistance.length ? Math.min(...snap.resistance) : null;
  const resistanceHi = snap.resistance.length ? Math.max(...snap.resistance) : null;

  const header = quotaExhausted ? '> AI 额度已用尽，今日展示规则引擎策略\n\n' : '';

  const summary = `${header}**方向**：${
    snap.trend.direction === 'BULLISH' ? 'LONG' : snap.trend.direction === 'BEARISH' ? 'SHORT' : 'RANGING'
  }  
**仓位**：${
    Math.abs(snap.trend.score) >= 70 ? '标准' : Math.abs(snap.trend.score) >= 40 ? '试仓' : '观望'
  }  
**入场**：${
    snap.plan
      ? `${snap.plan.entryLow.toFixed(4)}~${snap.plan.entryHigh.toFixed(4)}`
      : `等待价格明确站上 ${resistanceLo?.toFixed(4)} 或跌破 ${supportLo?.toFixed(4)}`
  }  
**止损**：${snap.plan ? snap.plan.sl.toFixed(4) : supportLo?.toFixed(4)}  
**止盈**：${
    snap.plan ? `${snap.plan.tp1.toFixed(4)} / ${snap.plan.tp2.toFixed(4)}` : '暂无'
  }  
**理由**：EMA ${snap.emaStructure}，RSI ${snap.rsi14.toFixed(1)}（${snap.rsiZone}），MACD ${snap.macd.signal}，OBV ${snap.obv.flow}。  
**观察窗口**：${supportLo?.toFixed(4)}~${resistanceHi?.toFixed(4)}。  
**失效条件**：价格跌破 ${supportLo?.toFixed(4)} 或突破 ${resistanceHi?.toFixed(4)} 后重新评估。  
**备选方案**：${
    snap.plan
      ? `若突破 ${resistanceLo?.toFixed(4)} 站稳，可追入；若回踩 ${supportLo?.toFixed(4)} 反弹，可分批介入。`
      : `若突破 ${resistanceLo?.toFixed(4)} 可追多；若回落至 ${supportLo?.toFixed(4)} 可防守。`
  }  
**风险控制**：建议分批试仓，单笔风险控制在 1% 以内，避免一次性重仓。`;

  return {
    symbol,
    summary,
    signals: {
      trend: snap.trend.direction,
      confidence:
        Math.abs(snap.trend.score) >= 70
          ? 'HIGH'
          : Math.abs(snap.trend.score) >= 40
            ? 'MEDIUM'
            : 'LOW',
    },
    disclaimer: AI_DISCLAIMER,
    generatedAt: Date.now(),
    model: 'rule-engine-fallback',
  };
}

export { AI_CACHE_TTL_SEC };
