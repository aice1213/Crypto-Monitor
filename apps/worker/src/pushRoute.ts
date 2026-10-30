/**
 * 推送路由接入（开发交付文档 §2.3 接口清单、§3.2）
 *
 * /api/push/trigger POST：前端窗口上报入口。
 * 依赖注入 D1 + KV + 解密器，便于单测与未来 D1 绑定。
 *
 * 注：D1 binding（PUSH_D1）需在 wrangler.toml 配置，PUSH_ENC_KEY 需设置为
 * Workers Secret（文档 §13.1）。本模块只做编排，不负责资源创建。
 */
import type { PushCondition, PushTriggerRequest } from '@crypto-monitor/shared';
import { handleTrigger, type TriggerDeps } from './lib/trigger.js';
import { decryptSecret } from './lib/crypto.js';
import type { RuntimeChannel } from './lib/channels.js';
import { getMemory, setMemory } from './cache.js';

/** D1 行（push_targets） */
interface TargetRow {
  id: string;
  symbol: string;
  exchange: string;
  enabled: number;
  conditions_json: string;
}

/** D1 行（push_channels） */
interface ChannelRow {
  id: string;
  type: string;
  group_name: string | null;
  webhook_enc: string;
  sign_enc: string | null;
  keyword: string | null;
  security_type: string;
  enabled: number;
  status: string;
}

/** 推送路由依赖（D1 + KV + 解密密钥） */
export interface PushRouteDeps {
  d1: D1Database;
  kv: KVNamespace;
  pushEncKey: string;
  pushEnabled?: string;
  memoryGet?: <T>(key: string) => T | null;
  memorySet?: (key: string, data: unknown, ttlMs: number) => void;
}

/** 从 D1 读取标的条件（解密 conditions_json） */
export async function resolveConditionFromD1(
  d1: D1Database,
  targetId: string,
): Promise<PushCondition | null> {
  const res = await d1
    .prepare('SELECT id, symbol, exchange, enabled, conditions_json FROM push_targets WHERE id = ?')
    .bind(targetId)
    .first<TargetRow>();
  if (!res) return null;
  if (res.enabled !== 1) return null; // 禁用不触发
  try {
    return JSON.parse(res.conditions_json) as PushCondition;
  } catch {
    return null;
  }
}

/** 从 D1 读取并解密启用通道（通道全局，不区分 targetId） */
export async function resolveChannelsFromD1(
  d1: D1Database,
  encKey: string,
  _targetId?: string,
): Promise<RuntimeChannel[]> {
  const res = await d1
    .prepare(
      `SELECT id, type, group_name, webhook_enc, sign_enc, keyword, security_type, enabled, status
       FROM push_channels WHERE enabled = 1`,
    )
    .all<ChannelRow>();
  const rows = res.results ?? [];
  const channels: RuntimeChannel[] = [];
  for (const row of rows) {
    try {
      const webhook = await decryptSecret(row.webhook_enc, encKey);
      if (!webhook) continue;
      const sign = row.sign_enc ? await decryptSecret(row.sign_enc, encKey) : undefined;
      const channel: RuntimeChannel = {
        id: row.id,
        type: row.type === 'FEISHU' ? 'FEISHU' : 'DINGTALK',
        webhook,
        secret: sign ?? undefined,
        keyword: row.keyword ?? undefined,
        securityType: (row.security_type as 'SIGN' | 'KEYWORD' | 'IP') ?? 'SIGN',
      };
      channels.push(channel);
    } catch {
      // 解密失败跳过（加密损坏或密钥错误）
    }
  }
  return channels;
}

/** 写推送日志（D1 主存 + KV 兜底，文档 §10.2） */
async function writePushLog(
  d1: D1Database,
  kv: KVNamespace | undefined,
  log: { id: string; targetId: string; symbol: string; channelType: string; channelId: string; triggerType: string; triggerMode: string; price: number; changePercent: number; keyPrice: number | null; thresholdUsed: number; multiplierUsed: number | null; result: string; errorCode?: string; errorMsg?: string; ts: number },
): Promise<void> {
  try {
    await d1
      .prepare(
        `INSERT INTO push_logs (id, target_id, symbol, channel_type, channel_id, trigger_type, trigger_mode, price, change_percent, key_price, threshold_used, multiplier_used, result, error_code, error_msg, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        log.id,
        log.targetId,
        log.symbol,
        log.channelType,
        log.channelId,
        log.triggerType,
        log.triggerMode,
        log.price,
        log.changePercent,
        log.keyPrice,
        log.thresholdUsed,
        log.multiplierUsed,
        log.result,
        log.errorCode ?? null,
        log.errorMsg ?? null,
        log.ts,
      )
      .run();
  } catch {
    // D1 写失败：KV 兜底（§10.2），KV 也无则忽略（日志不阻断推送）
    if (!kv) return;
    try {
      const day = new Date(log.ts).toISOString().slice(0, 10).replace(/-/g, '');
      const key = `pushlog:${day}:${log.ts}:${log.id}`;
      await kv.put(key, JSON.stringify(log), { expirationTtl: 7 * 86400 });
    } catch {
      // 忽略
    }
  }
}

/**
 * /api/push/trigger 处理函数。
 * 按 symbol 从 D1 解析 targetId（push_targets UNIQUE(symbol,exchange)，1:1）。
 */
export async function handlePushTrigger(
  req: PushTriggerRequest,
  deps: PushRouteDeps,
): Promise<ReturnType<typeof handleTrigger>> {
  const enabled = deps.pushEnabled !== 'false'; // 默认开启
  const memoryGet = deps.memoryGet ?? getMemory;
  const memorySet = deps.memorySet ?? setMemory;

  // 按 symbol 查 targetId
  const targetRes = await deps.d1
    .prepare('SELECT id FROM push_targets WHERE symbol = ? AND enabled = 1')
    .bind(req.symbol)
    .first<{ id: string }>();
  if (!targetRes) {
    return { code: 400, status: 'INVALID', message: '未找到启用的推送标的' };
  }
  const targetId = targetRes.id;

  const triggerDeps: TriggerDeps = {
    kv: deps.kv,
    d1: deps.d1,
    memoryGet,
    memorySet,
    resolveCondition: (id) => resolveConditionFromD1(deps.d1, id),
    resolveChannels: (id) => resolveChannelsFromD1(deps.d1, deps.pushEncKey, id),
    writeLog: (log) => writePushLog(deps.d1, deps.kv, log),
    enabled: () => enabled,
  };

  return handleTrigger(req, targetId, triggerDeps);
}
