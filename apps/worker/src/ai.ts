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

  return `你是加密货币量化分析师。仅基于下方给定指标数据推理，禁止臆造未提供的信息；
若数据矛盾或不足，明确说明"信号冲突，建议观望"。
输出 Markdown，固定包含：## 趋势研判 / ## 关键位与量价 / ## 交易计划 / ## 风险提示。
交易计划必须与给定 plan 字段一致，不得另行编造价格。

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
  const planText = snap.plan
    ? `${snap.plan.side} | 进场 ${snap.plan.entryLow.toFixed(2)}~${snap.plan.entryHigh.toFixed(
        2,
      )} | TP1 ${snap.plan.tp1.toFixed(2)} | SL ${snap.plan.sl.toFixed(2)} | RR ${snap.plan.rrRatio.toFixed(2)}`
    : '观望：信号冲突 / 盈亏比不足';

  const header = quotaExhausted
    ? '> AI 额度已用尽，今日展示规则引擎策略\n\n'
    : '';

  const summary = `${header}## 趋势研判
规则引擎评分 **${snap.trend.score}**（${snap.trend.direction}）。EMA 结构 ${snap.emaStructure}，RSI14 ${snap.rsi14.toFixed(
    1,
  )}（${snap.rsiZone}），MACD ${snap.macd.signal}，OBV ${snap.obv.flow}。

## 关键位与量价
支撑位：${snap.support.map((p) => p.toFixed(2)).join(', ')}
阻力位：${snap.resistance.map((p) => p.toFixed(2)).join(', ')}

## 交易计划
${planText}

## 风险提示
加密货币交易风险极高，以上为规则引擎自动生成，仅供参考。`;

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
