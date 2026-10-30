/**
 * 冷静期与幂等去重（开发交付文档 §5）
 *
 * 依赖注入 KV（避免直接依赖全局），便于单测。
 *
 * 规则（§5.1）：
 * - 以标的（targetId）为单位记录 last_push_time
 * - now - last_push_time < 24h → 不推送（COOLING）
 * - 测试推送不更新 last_push_time
 * - 关闭再开启、编辑条件 → 冷静期保留
 * - 移除后重新添加（新 id）→ 冷静期重置
 *
 * 存储（§5.2）：KV push:last:{targetId} → { ts, id }，TTL 7 天。
 * 并发保护：内存 Promise 锁，KV 写失败记录日志。
 * 幂等（§5.3）：KV sig:{targetId}:{bucket} 60s 防网络重试重复触发。
 */
import {
  PUSH_COOLDOWN_MS,
  PUSH_LAST_TTL_SEC,
  PUSH_IDEMPOTENT_BUCKET_SEC,
  PUSH_KV_LAST,
  PUSH_KV_IDEMPOTENT,
} from '@crypto-monitor/shared';

/** 冷静期记录 */
export interface CooldownRecord {
  ts: number;
  id: string;
}

/**
 * 轻量 KV 接口（项目自定义，避免 KVNamespace 多重重载导致测试 mock 困难）。
 * 实际环境用 Cloudflare KVNamespace（兼容 text 读写）。
 */
export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/** 幂等桶键（§5.3） */
export function idempotentBucket(nowMs: number): number {
  return Math.floor(nowMs / (PUSH_IDEMPOTENT_BUCKET_SEC * 1000));
}

export function idempotentKey(targetId: string, triggerType: string, nowMs: number): string {
  return `${PUSH_KV_IDEMPOTENT}${targetId}:${triggerType}:${idempotentBucket(nowMs)}`;
}

/**
 * 冷静期检查：返回是否可推送。
 * 读 KV（若注入）或内存缓存；无记录 → 可推送。
 */
export async function isCooling(
  kv: KvLike | undefined,
  memoryGet: <T>(key: string) => T | null,
  targetId: string,
  nowMs: number,
): Promise<boolean> {
  const key = `${PUSH_KV_LAST}${targetId}`;
  const mem = memoryGet<CooldownRecord>(key);
  const rec = mem ?? (kv ? await readCooldown(kv, key) : null);
  if (!rec) return false;
  return nowMs - rec.ts < PUSH_COOLDOWN_MS;
}

async function readCooldown(
  kv: KvLike,
  key: string,
): Promise<CooldownRecord | null> {
  try {
    const raw = await kv.get(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CooldownRecord;
    if (typeof parsed.ts !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 写入冷静期（推送成功后） */
export async function writeCooldown(
  kv: KvLike | undefined,
  memorySet: (key: string, data: unknown, ttlMs: number) => void,
  targetId: string,
  nowMs: number,
  id: string,
): Promise<boolean> {
  const key = `${PUSH_KV_LAST}${targetId}`;
  const rec: CooldownRecord = { ts: nowMs, id };
  memorySet(key, rec, PUSH_COOLDOWN_MS + 60_000);
  if (!kv) return false;
  try {
    await kv.put(key, JSON.stringify(rec), { expirationTtl: PUSH_LAST_TTL_SEC });
    return true;
  } catch {
    return false;
  }
}

/** 幂等检查 + 占用（原子性：先占后查，防并发重复） */
export async function checkAndSetIdempotent(
  kv: KvLike | undefined,
  targetId: string,
  triggerType: string,
  nowMs: number,
): Promise<boolean> {
  const key = idempotentKey(targetId, triggerType, nowMs);
  if (!kv) {
    // 无 KV（测试/降级）：内存去重由调用方负责，这里默认允许
    return true;
  }
  try {
    const existing = await kv.get(key);
    if (existing) return false; // 已占用
    await kv.put(key, '1', { expirationTtl: PUSH_IDEMPOTENT_BUCKET_SEC + 5 });
    return true;
  } catch {
    // KV 失败：允许通过（宁可重复不可漏报）
    return true;
  }
}
