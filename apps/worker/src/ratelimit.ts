/**
 * 令牌桶限流 + 请求合并（dev.md 3.2）
 */
class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly rate: number;
  private readonly capacity: number;

  constructor(rate = 10, capacity = 20) {
    this.rate = rate;
    this.capacity = capacity;
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  tryConsume(): boolean {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.rate);
    this.lastRefill = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

// 个人监控工具，放宽限流以适配多标的并发轮询
const bucket = new TokenBucket(10, 20);


export function rateLimit(): boolean {
  return bucket.tryConsume();
}

const inflight = new Map<string, Promise<unknown>>();

export function withDedup<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = fn().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, p);
  return p;
}
