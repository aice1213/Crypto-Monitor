/**
 * 缓存层：内存缓存 + KV（dev.md 3.2）
 */
interface CacheEntry<T> {
  data: T;
  ts: number;
  ttlMs: number;
}

const memoryStore = new Map<string, CacheEntry<unknown>>();

function nowMs() {
  return Date.now();
}

export function getMemory<T>(key: string): T | null {
  const entry = memoryStore.get(key) as CacheEntry<T> | undefined;
  if (!entry) return null;
  if (nowMs() - entry.ts > entry.ttlMs) {
    memoryStore.delete(key);
    return null;
  }
  return entry.data;
}

export function setMemory<T>(key: string, data: T, ttlMs: number) {
  memoryStore.set(key, { data, ts: nowMs(), ttlMs });
}

export async function getKV<T>(
  kv: KVNamespace | undefined,
  key: string,
): Promise<T | null> {
  if (!kv) return null;
  try {
    const raw = await kv.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function setKV<T>(
  kv: KVNamespace | undefined,
  key: string,
  data: T,
  ttlSec: number,
) {
  if (!kv) return;
  try {
    await kv.put(key, JSON.stringify(data), { expirationTtl: ttlSec });
  } catch {
    // ignore
  }
}

export async function getCached<T>(
  kv: KVNamespace | undefined,
  key: string,
  memoryTtlMs: number,
): Promise<T | null> {
  const mem = getMemory<T>(key);
  if (mem !== null) return mem;
  const kvData = await getKV<T>(kv, key);
  if (kvData !== null) {
    setMemory(key, kvData, memoryTtlMs);
    return kvData;
  }
  return null;
}

const staleStore = new Map<string, CacheEntry<unknown>>();

export function setStale<T>(key: string, data: T) {
  staleStore.set(key, { data, ts: nowMs(), ttlMs: 60_000 });
}

export function getStale<T>(
  key: string,
  toleranceMs = 60_000,
): { data: T; stale: true } | null {
  const entry = staleStore.get(key) as CacheEntry<T> | undefined;
  if (!entry) return null;
  if (nowMs() - entry.ts > toleranceMs) {
    staleStore.delete(key);
    return null;
  }
  return { data: entry.data, stale: true };
}
