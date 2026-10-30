/**
 * Cron 兜底触发（开发交付文档 §3.3）
 *
 * 页面关闭场景：Cron 每分钟扫描启用标的，与 KV `last_check_price:{symbol}`
 * 比较价格变动，用动态阈值判定，命中走 handleTrigger（triggerType='CRON_FALLBACK'）。
 *
 * UI 与文档明示：页面关闭时精度降为分钟级，且无法执行成交量/方向过滤（仅做价格变动判定）。
 */
import type { PushCondition, PushTriggerRequest } from '@crypto-monitor/shared';
import { handleTrigger, type TriggerDeps } from './lib/trigger.js';
import { computeRecommendation } from './lib/threshold.js';
import type { KvLike } from './lib/cooldown.js';
import { resolveConditionFromD1, resolveChannelsFromD1 } from './pushRoute.js';
import { getMemory, setMemory } from './cache.js';

/** Cron 兜底依赖 */
export interface CronFallbackDeps {
  d1: D1Database;
  kv: KvLike;
  encKey: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface TargetRow {
  id: string;
  symbol: string;
  exchange: string;
  enabled: number;
  conditions_json: string;
}

/**
 * 每分钟 Cron 兜底扫描。
 * @returns 命中并触发的次数（含冷却/门控拦截，供日志）
 */
export async function runCronFallback(deps: CronFallbackDeps): Promise<{ scanned: number; triggered: number }> {
  const now = deps.now ? deps.now() : Date.now();
  const res = await deps.d1
    .prepare('SELECT id, symbol, exchange, enabled, conditions_json FROM push_targets WHERE enabled = 1')
    .all<TargetRow>();
  const rows = res.results ?? [];

  let scanned = 0;
  let triggered = 0;

  for (const row of rows) {
    // 解析条件
    let condition: PushCondition;
    try {
      condition = JSON.parse(row.conditions_json) as PushCondition;
    } catch {
      continue;
    }
    if (!condition) continue;

    // 拉取当前价（Gate.io ticker）
    let lastPrice: number;
    try {
      const t = await fetchTickerWith(deps.fetchImpl ?? fetch, row.symbol);
      lastPrice = t;
    } catch {
      continue; // ticker 失败跳过
    }

    // 上次检查价
    const lastKey = `last_check_price:${row.symbol}`;
    const prevPrice = getMemory<number>(lastKey) ?? (await readKVNumber(deps.kv, lastKey));

    if (prevPrice != null && prevPrice > 0) {
      const changePercent = ((lastPrice - prevPrice) / prevPrice) * 100;
      // 动态阈值（§3.3：使用该标的动态阈值）
      const threshold = await resolveDynamicThreshold(row.symbol, condition);
      if (Math.abs(changePercent) >= threshold) {
        // 命中：走 handleTrigger（CRON_FALLBACK，仅价格变动判定）
        const req: PushTriggerRequest = {
          symbol: row.symbol,
          price: lastPrice,
          changePercent,
          thresholdUsed: threshold,
          keyPrice: condition.keyPrice,
          triggerMode: condition.mode,
          triggerType: 'CRON_FALLBACK',
          clientTs: now,
        };
        const triggerDeps: TriggerDeps = {
          kv: deps.kv,
          d1: deps.d1,
          memoryGet: getMemory,
          memorySet: setMemory,
          resolveCondition: (id) => resolveConditionFromD1(deps.d1, id),
          resolveChannels: (id) => resolveChannelsFromD1(deps.d1, deps.encKey, id),
          writeLog: async () => {}, // Cron 日志由 trigger 内部通过 resolveChannels 流程写；此处简化
          enabled: () => true,
        };
        const outcome = await handleTrigger(req, row.id, triggerDeps);
        if (outcome.status === 'SENT' || outcome.status === 'SKIPPED_COOLING') triggered++;
        scanned++;
      }
    }

    // 更新 last_check_price（写 KV）
    await deps.kv.put(lastKey, String(lastPrice), { expirationTtl: 7 * 86400 });
    setMemory(lastKey, lastPrice, 60_000);
  }

  return { scanned, triggered };
}

/** 动态阈值：优先 AUTO 推荐值，否则 MANUAL/默认 */
async function resolveDynamicThreshold(
  symbol: string,
  condition: PushCondition,
): Promise<number> {
  if (condition.thresholdMode === 'MANUAL' && condition.manualThreshold != null) {
    return condition.manualThreshold;
  }
  if (condition.autoThreshold != null) {
    return condition.autoThreshold;
  }
  // 无缓存推荐值：用 computeRecommendation（简化：无 K 线时走默认）
  const rec = computeRecommendation({ symbol, isBtc: symbol === 'BTC_USDT' });
  return rec.recommendedThreshold;
}

/** 轻量 ticker 拉取（只取 last） */
async function fetchTickerWith(fetchImpl: typeof fetch, symbol: string): Promise<number> {
  const res = await fetchImpl(
    `https://api.gateio.ws/api/v4/futures/usdt/tickers?contract=${encodeURIComponent(symbol)}`,
    { headers: { Accept: 'application/json' } },
  );
  if (!res.ok) throw new Error(`ticker ${res.status}`);
  const rows = (await res.json()) as { last: string }[];
  const last = parseFloat(rows[0]?.last ?? '');
  if (!Number.isFinite(last) || last <= 0) throw new Error('ticker last invalid');
  return last;
}

async function readKVNumber(kv: KvLike, key: string): Promise<number | null> {
  try {
    const raw = await kv.get(key);
    if (!raw) return null;
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
