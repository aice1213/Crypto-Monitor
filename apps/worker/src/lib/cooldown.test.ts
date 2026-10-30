import { describe, it, expect } from 'vitest';
import { isCooling, writeCooldown, checkAndSetIdempotent, idempotentBucket, idempotentKey } from './cooldown.js';
import type { KvLike } from './cooldown.js';

/**
 * cooldown.ts 专项测试（开发交付文档 §5）
 *
 * 幂等：60s 内同 targetId+triggerType 重复 → 拦截（§5.3）
 * 冷静期：24h 窗口、TTL、内存缓存
 */

class MemKV implements KvLike {
  private map = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    this.map.set(key, value);
    void opts;
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

function makeMemory() {
  const store = new Map<string, { data: unknown; ts: number; ttlMs: number }>();
  return {
    get: <T>(key: string): T | null => {
      const e = store.get(key);
      if (!e) return null;
      if (Date.now() - e.ts > e.ttlMs) return null;
      return e.data as T;
    },
    set: (key: string, data: unknown, ttlMs: number) => {
      store.set(key, { data, ts: Date.now(), ttlMs });
    },
  };
}

describe('幂等（§5.3）', () => {
  it('同 bucket 首次允许，第二次拦截', async () => {
    const kv = new MemKV();
    const now = 1_700_000_000_000;
    const ok1 = await checkAndSetIdempotent(kv, 't1', 'CLIENT_WINDOW', now);
    expect(ok1).toBe(true);
    const ok2 = await checkAndSetIdempotent(kv, 't1', 'CLIENT_WINDOW', now);
    expect(ok2).toBe(false);
  });

  it('不同 bucket 各自允许', async () => {
    const kv = new MemKV();
    const ok1 = await checkAndSetIdempotent(kv, 't1', 'CLIENT_WINDOW', 0);
    const ok2 = await checkAndSetIdempotent(kv, 't1', 'CLIENT_WINDOW', 60_000); // 下一 bucket
    expect(ok1).toBe(true);
    expect(ok2).toBe(true);
  });

  it('不同 triggerType 各自允许', async () => {
    const kv = new MemKV();
    const ok1 = await checkAndSetIdempotent(kv, 't1', 'CLIENT_WINDOW', 0);
    const ok2 = await checkAndSetIdempotent(kv, 't1', 'CRON_FALLBACK', 0);
    expect(ok1).toBe(true);
    expect(ok2).toBe(true);
  });

  it('idempotentBucket 60s 分桶', () => {
    expect(idempotentBucket(0)).toBe(0);
    expect(idempotentBucket(59_999)).toBe(0);
    expect(idempotentBucket(60_000)).toBe(1);
  });

  it('idempotentKey 组合', () => {
    expect(idempotentKey('t1', 'CRON_FALLBACK', 120_000)).toBe('sig:t1:CRON_FALLBACK:2');
  });

  it('无 KV（降级）→ 允许（宁可重复不可漏报）', async () => {
    const ok = await checkAndSetIdempotent(undefined, 't1', 'CLIENT_WINDOW', 0);
    expect(ok).toBe(true);
  });
});

describe('冷静期（§5.1）', () => {
  it('写入后 24h 内 cooling，超 24h 后可用', async () => {
    const kv = new MemKV();
    const memory = makeMemory();
    await writeCooldown(kv, memory.set, 't1', 1_000_000, 'id1');
    expect(await isCooling(kv, memory.get, 't1', 1_000_000 + 1000)).toBe(true);
    expect(await isCooling(kv, memory.get, 't1', 1_000_000 + 25 * 3600_000)).toBe(false);
  });

  it('无记录 → 可推送', async () => {
    const kv = new MemKV();
    const memory = makeMemory();
    expect(await isCooling(kv, memory.get, 't2', Date.now())).toBe(false);
  });

  it('KV 写失败 → writeCooldown 返回 false（不阻断，内存已缓存）', async () => {
    const memory = makeMemory();
    const ok = await writeCooldown(undefined, memory.set, 't1', Date.now(), 'id1');
    expect(ok).toBe(false);
    // 内存缓存仍生效
    expect(memory.get('push:last:t1')).not.toBeNull();
  });

  it('无 KV 时 isCooling 走内存缓存', async () => {
    const memory = makeMemory();
    await writeCooldown(undefined, memory.set, 't1', Date.now(), 'id1');
    expect(await isCooling(undefined, memory.get, 't1', Date.now() + 1000)).toBe(true);
  });
});
