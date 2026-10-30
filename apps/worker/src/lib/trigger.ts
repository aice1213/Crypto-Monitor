/**
 * 推送触发处理核心（开发交付文档 §3、§5、§6.3）
 *
 * handleTrigger 编排：冷静期 → 幂等 → 门控复核 → 发送通道 → 日志。
 * 依赖全部注入（KV/D1/fetch/memory），便于单测验收 #1/#7/#8/#9。
 */
import type { PushCondition, PushLogDto, PushTriggerRequest } from '@crypto-monitor/shared';
import { PUSH_RETRY_BACKOFF_SEC } from '@crypto-monitor/shared';
import { evaluateGate, type GateInput } from './gate.js';
import { isCooling, writeCooldown, checkAndSetIdempotent } from './cooldown.js';
import type { KvLike } from './cooldown.js';
import {
  sendToChannel,
  buildDingTalkBody,
  buildFeishuBody,
  isSignatureError,
  type RuntimeChannel,
} from './channels.js';

/** 触发结果（供 API 返回） */
export type TriggerOutcome =
  | { code: 0; status: 'SENT'; logId: string; message: string }
  | { code: 0; status: 'SKIPPED_COOLING'; message: string }
  | { code: 0; status: 'SKIPPED_DUPLICATE'; message: string }
  | { code: 0; status: 'SKIPPED_GATE'; message: string; reason?: string }
  | { code: 0; status: 'FAILED'; message: string; errorCode?: string }
  | { code: 400; status: 'INVALID'; message: string };

/** 依赖注入容器 */
export interface TriggerDeps {
  kv?: KvLike;
  d1?: D1Database;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** 内存缓存（冷静期/幂等） */
  memoryGet: <T>(key: string) => T | null;
  memorySet: (key: string, data: unknown, ttlMs: number) => void;
  /** 通道解密后的运行时配置（由调用方从 D1 读取并解密） */
  resolveChannels: (targetId: string) => Promise<RuntimeChannel[]>;
  /** 读取标的条件（由调用方从 D1 读取） */
  resolveCondition: (targetId: string) => Promise<PushCondition | null>;
  /** 写日志（KV 或 D1，由调用方实现） */
  writeLog: (log: PushLogDto) => Promise<void>;
  /** 门控复核所需数据（成交量等，由调用方提供） */
  gateExtra?: (req: PushTriggerRequest, condition: PushCondition) => Promise<Partial<GateInput>>;
  /** 全局开关 */
  enabled?: () => boolean;
  /** 通道发送退避（测试注入 [0,0,0] 避免真实等待；默认 1s/3s/9s） */
  backoffSec?: number[];
}

/** 生成简单 ID（无 crypto.randomUUID 时回退） */
export function genId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 处理一次推送触发（§3.2 前端上报 / §3.3 Cron 兜底共用）。
 *
 * 流程：全局开关 → 条件读取 → 冷静期 → 幂等 → 门控复核 → 发送 → 写冷静期 → 日志。
 */
export async function handleTrigger(
  req: PushTriggerRequest,
  targetId: string,
  deps: TriggerDeps,
): Promise<TriggerOutcome> {
  const now = deps.now ? deps.now() : Date.now();

  if (deps.enabled && !deps.enabled()) {
    return { code: 0, status: 'SKIPPED_GATE', message: '推送全局关闭（PUSH_ENABLED=false）' };
  }

  const condition = await deps.resolveCondition(targetId);
  if (!condition) {
    return { code: 400, status: 'INVALID', message: '未找到推送标的或已删除' };
  }

  // 冷静期（§5.1）
  if (await isCooling(deps.kv, deps.memoryGet, targetId, now)) {
    return { code: 0, status: 'SKIPPED_COOLING', message: '冷静期 24h 内不重复推送' };
  }

  // 幂等（§5.3）
  const idemOk = await checkAndSetIdempotent(deps.kv, targetId, req.triggerType, now);
  if (!idemOk) {
    return { code: 0, status: 'SKIPPED_DUPLICATE', message: '60s 内已处理过该触发（幂等）' };
  }

  // 门控复核（§3.2，服务端二次确认）
  const baseGate: GateInput = {
    mode: condition.mode,
    priceStart: req.price - (req.changePercent / 100) * req.price, // 由 changePercent 反推 start
    priceEnd: req.price,
    changePercent: req.changePercent,
    keyPrice: condition.keyPrice ?? null,
    keyPriceThreshold: condition.keyPriceThreshold ?? 0.3,
    thresholdUsed: condition.thresholdMode === 'MANUAL' ? (condition.manualThreshold ?? 0.5) : (condition.autoThreshold ?? req.thresholdUsed),
    volumeConfirm: condition.volumeConfirm ?? true,
    volumeMultiplier: condition.volumeMultiplier ?? 1.5,
    directionConsistency: condition.directionConsistency ?? true,
  };
  const gateExtra = deps.gateExtra ? await deps.gateExtra(req, condition) : {};
  const gateResult = evaluateGate({ ...baseGate, ...gateExtra });
  if (!gateResult.passed) {
    return {
      code: 0,
      status: 'SKIPPED_GATE',
      message: `门控未通过：${gateResult.reason ?? 'unknown'}`,
      reason: gateResult.reason,
    };
  }

  // 发送通道（§6）
  const channels = await deps.resolveChannels(targetId);
  if (channels.length === 0) {
    return { code: 400, status: 'INVALID', message: '未配置任何启用通道' };
  }

  const emaState = 'NONE'; // 由调用方在 gateExtra 补充（服务端暂不计算 EMA 结构）
  const trend = 'RANGING';

  let sentAny = false;
  let lastError: string | undefined;
  let lastErrorCode: string | undefined;
  const sentLogs: PushLogDto[] = [];
  // 实际展示阈值应取门控实际使用的阈值
  const displayThreshold =
    condition.thresholdMode === 'MANUAL'
      ? (condition.manualThreshold ?? 0.5)
      : (condition.autoThreshold ?? req.thresholdUsed);

  for (const ch of channels) {
    const data = {
      symbol: req.symbol,
      price: req.price,
      keyPrice: req.keyPrice ?? null,
      changePercent: req.changePercent,
      thresholdUsed: displayThreshold,
      multiplierUsed: req.multiplierUsed ?? null,
      triggerMode: condition.mode,
      emaState,
      trend,
      timeSec: Math.floor(now / 1000),
      keyword: ch.keyword,
    };

    const channelSend =
      ch.type === 'DINGTALK'
        ? buildDingTalkBody(data, ch)
        : buildFeishuBody(data, ch);

    const { url, body } = await channelSend;
    const result = await sendToChannel(
      url,
      body,
      deps.fetchImpl ?? fetch,
      deps.backoffSec ?? PUSH_RETRY_BACKOFF_SEC,
    );

    const logId = genId();
    const log: PushLogDto = {
      id: logId,
      targetId,
      symbol: req.symbol,
      channelType: ch.type,
      channelId: ch.id,
      triggerType: req.triggerType,
      triggerMode: condition.mode,
      price: req.price,
      changePercent: req.changePercent,
      keyPrice: req.keyPrice ?? null,
      thresholdUsed: displayThreshold,
      multiplierUsed: req.multiplierUsed ?? null,
      result: result.ok ? 'SENT' : 'FAILED',
      errorCode: result.errorCode != null ? String(result.errorCode) : undefined,
      errorMsg: result.ok ? undefined : result.errorMsg,
      ts: now,
    };
    sentLogs.push(log);
    await deps.writeLog(log);

    if (result.ok) {
      sentAny = true;
    } else if (isSignatureError(result)) {
      // 签名错误 → 直接失败并提示检查密钥（§6.4）
      lastError = `签名错误（${result.errorCode}），请检查密钥`;
      lastErrorCode = String(result.errorCode);
    } else {
      lastError = result.errorMsg ?? '发送失败';
      lastErrorCode = result.errorCode != null ? String(result.errorCode) : undefined;
    }
  }

  // 至少一个通道成功 → 更新冷静期（§5.1）
  if (sentAny) {
    await writeCooldown(deps.kv, deps.memorySet, targetId, now, genId());
    return {
      code: 0,
      status: 'SENT',
      logId: sentLogs[0]?.id ?? '',
      message: `已推送 ${channels.length} 个通道`,
    };
  }

  return {
    code: 0,
    status: 'FAILED',
    message: lastError ?? '所有通道发送失败',
    errorCode: lastErrorCode,
  };
}
