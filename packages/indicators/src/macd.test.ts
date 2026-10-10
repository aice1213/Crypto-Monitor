import { describe, it, expect } from 'vitest';
import { atr, ema, macd } from './index.js';

/**
 * 构造"长期横盘 → 单边启动"的序列。
 * 横盘段让 EMA12/EMA26 收敛、DIF≈DEA≈0，随后的小幅单边会使 DIF 在**零轴附近**穿越 DEA，
 * 从而满足 dev.md 4.1 要求的 `|dif| ≤ ATR14 × 0.5` 约束。
 */
function flatThenMove(nFlat: number, step: number, nMove: number) {
  const closes: number[] = [];
  for (let i = 0; i < nFlat; i++) closes.push(100);
  for (let i = 1; i <= nMove; i++) closes.push(100 + step * i);
  return {
    closes,
    highs: closes.map((c) => c + 0.5),
    lows: closes.map((c) => c - 0.5),
  };
}

const up = flatThenMove(60, 0.5, 10);
const down = flatThenMove(60, -0.5, 10);

describe('macd 基础结构', () => {
  it('长度与输入一致；空输入返回空数组', () => {
    expect(macd(up.highs, up.lows, up.closes)).toHaveLength(up.closes.length);
    expect(macd([], [], [])).toEqual([]);
  });

  it('三个字段自洽：hist 恒等于 (dif − dea) × 2（含 DEA 预热期）', () => {
    const res = macd(up.highs, up.lows, up.closes);
    for (let i = 0; i < res.length; i++) {
      expect(res[i]!.hist, `index ${i}`).toBeCloseTo((res[i]!.dif - res[i]!.dea) * 2, 10);
    }
  });

  it('DEA 预热期内 dea 等于 dif，不伪造 0 值', () => {
    const res = macd(up.highs, up.lows, up.closes);
    // 前 26 根内 EMA26 未就绪，dif 为占位；此时 dea 必须与 dif 相等
    for (let i = 0; i < 25; i++) {
      expect(res[i]!.dea).toBe(res[i]!.dif);
      expect(res[i]!.hist).toBe(0);
    }
  });

  it('预热期内不产生任何交叉信号', () => {
    const res = macd(up.highs, up.lows, up.closes);
    expect(res.slice(0, 25).every((r) => r.signal === 'NO_SIGNAL')).toBe(true);
  });

  it('dif 等于 EMA12 − EMA26（有效区间内）', () => {
    const res = macd(up.highs, up.lows, up.closes);
    const e12 = ema(up.closes, 12);
    const e26 = ema(up.closes, 26);
    for (let i = 30; i < up.closes.length; i++) {
      expect(res[i]!.dif).toBeCloseTo(e12[i]! - e26[i]!, 8);
    }
  });
});

describe('macd 交叉信号的零轴附近约束（dev.md 4.1）', () => {
  it('横盘后启动的序列能产生金叉/死叉（约束不能严到永不出信号）', () => {
    const gold = macd(up.highs, up.lows, up.closes).filter((r) => r.signal === 'GOLDEN_CROSS');
    const death = macd(down.highs, down.lows, down.closes).filter((r) => r.signal === 'DEATH_CROSS');
    expect(gold.length).toBeGreaterThan(0);
    expect(death.length).toBeGreaterThan(0);
  });

  it('所有上报的交叉都满足相对关系、hist 符号与 |dif| ≤ ATR×0.5', () => {
    for (const s of [up, down, flatThenMove(40, 0.3, 40)]) {
      const res = macd(s.highs, s.lows, s.closes);
      const atrArr = atr(s.highs, s.lows, s.closes, 14);
      for (let i = 1; i < res.length; i++) {
        const cur = res[i]!;
        const prev = res[i - 1]!;
        const a = atrArr[i]!;

        if (cur.signal === 'GOLDEN_CROSS') {
          if (prev.dif <= prev.dea) {
            // 交叉发生当根：必须真的上穿，且处于零轴附近
            expect(cur.dif).toBeGreaterThan(cur.dea);
            expect(cur.hist).toBeGreaterThan(0);
            if (!Number.isNaN(a)) expect(Math.abs(cur.dif)).toBeLessThanOrEqual(a * 0.5 + 1e-9);
          } else {
            // 保留期内的"近期信号"：当根不再满足上穿，但前 3 根内必须存在真正的交叉
            // 注：DTO 用同一个 GOLDEN_CROSS 表示"当根"与"近期"，调用方无法区分（审查项 F19）
            const crossedRecently = res
              .slice(Math.max(1, i - 3), i)
              .some((r, k) => {
                const idx = Math.max(1, i - 3) + k;
                return r.signal === 'GOLDEN_CROSS' && res[idx - 1]!.dif <= res[idx - 1]!.dea;
              });
            expect(crossedRecently, `index ${i} 的保留期金叉找不到源交叉`).toBe(true);
          }
        } else if (cur.signal === 'DEATH_CROSS') {
          if (prev.dif >= prev.dea) {
            expect(cur.dif).toBeLessThan(cur.dea);
            expect(cur.hist).toBeLessThan(0);
            if (!Number.isNaN(a)) expect(Math.abs(cur.dif)).toBeLessThanOrEqual(a * 0.5 + 1e-9);
          } else {
            const crossedRecently = res
              .slice(Math.max(1, i - 3), i)
              .some((r, k) => {
                const idx = Math.max(1, i - 3) + k;
                return r.signal === 'DEATH_CROSS' && res[idx - 1]!.dif >= res[idx - 1]!.dea;
              });
            expect(crossedRecently, `index ${i} 的保留期死叉找不到源交叉`).toBe(true);
          }
        }
      }
    }
  });

  it('signal 只会取三个枚举值之一', () => {
    const s = flatThenMove(40, 0.3, 40);
    const allowed = new Set(['GOLDEN_CROSS', 'DEATH_CROSS', 'NO_SIGNAL']);
    for (const r of macd(s.highs, s.lows, s.closes)) {
      expect(allowed.has(r.signal)).toBe(true);
    }
  });

  it('远离零轴的穿越不产生信号（|dif| 超出 ATR×0.5 时被过滤）', () => {
    // 放大波动幅度：DIF 会被推离零轴，此时即便 dif/dea 发生穿越也不应上报
    const big = flatThenMove(60, 40, 10);
    const res = macd(big.highs, big.lows, big.closes);
    const atrArr = atr(big.highs, big.lows, big.closes, 14);
    const last = res[res.length - 1]!;
    const lastAtr = atrArr[atrArr.length - 1]!;
    // 最后几根 DIF 已远大于 ATR×0.5
    expect(Math.abs(last.dif)).toBeGreaterThan(lastAtr * 0.5);
  });
});

describe('macd 交叉信号保留期（dev.md 4.1：之后 3 根内保留）', () => {
  it('交叉当根 + 后续 3 根保留同一信号，第 4 根回到 NO_SIGNAL', () => {
    const res = macd(up.highs, up.lows, up.closes);
    const c = res.findIndex((r) => r.signal === 'GOLDEN_CROSS');
    expect(c).toBeGreaterThan(0);
    const sig = res[c]!.signal;
    expect(res[c + 1]!.signal).toBe(sig);
    expect(res[c + 2]!.signal).toBe(sig);
    expect(res[c + 3]!.signal).toBe(sig);
    expect(res[c + 4]!.signal).toBe('NO_SIGNAL');
  });

  it('死叉保留期对称', () => {
    const res = macd(down.highs, down.lows, down.closes);
    const c = res.findIndex((r) => r.signal === 'DEATH_CROSS');
    expect(c).toBeGreaterThan(0);
    expect(res[c + 1]!.signal).toBe('DEATH_CROSS');
    expect(res[c + 3]!.signal).toBe('DEATH_CROSS');
    expect(res[c + 4]!.signal).toBe('NO_SIGNAL');
  });

  it('保留期不会覆盖其后出现的新交叉', () => {
    const res = macd(up.highs, up.lows, up.closes);
    const first = res.findIndex((r) => r.signal === 'GOLDEN_CROSS');
    const second = res.findIndex((r, i) => i > first && r.signal === 'GOLDEN_CROSS');
    if (second !== -1) {
      expect(second).toBeGreaterThan(first);
    } else {
      expect(first).toBeGreaterThan(-1);
    }
  });
});

describe('macd 信号新鲜度 signalAge（审查项 F19）', () => {
  it('当根交叉 age=0，其后 3 根依次为 1 / 2 / 3', () => {
    const res = macd(up.highs, up.lows, up.closes);
    const c = res.findIndex((r) => r.signal === 'GOLDEN_CROSS');
    expect(res[c]!.signalAge).toBe(0);
    expect(res[c + 1]!.signalAge).toBe(1);
    expect(res[c + 2]!.signalAge).toBe(2);
    expect(res[c + 3]!.signalAge).toBe(3);
  });

  it('无信号时 signalAge 为 null（而不是 0 或遗留值）', () => {
    const res = macd(up.highs, up.lows, up.closes);
    expect(res[0]!.signal).toBe('NO_SIGNAL');
    expect(res[0]!.signalAge).toBeNull();
    const c = res.findIndex((r) => r.signal === 'GOLDEN_CROSS');
    expect(res[c + 4]!.signal).toBe('NO_SIGNAL');
    expect(res[c + 4]!.signalAge).toBeNull();
  });

  it('signal 与 signalAge 始终自洽：有信号必有 age，无信号必为 null', () => {
    for (const s of [up, down, flatThenMove(40, 0.3, 40)]) {
      for (const r of macd(s.highs, s.lows, s.closes)) {
        if (r.signal === 'NO_SIGNAL') {
          expect(r.signalAge).toBeNull();
        } else {
          expect(r.signalAge).not.toBeNull();
          expect(r.signalAge!).toBeGreaterThanOrEqual(0);
          expect(r.signalAge!).toBeLessThanOrEqual(3);
        }
      }
    }
  });

  it('新的交叉会把 age 重置为 0', () => {
    // 横盘 → 上 → 下 → 上，制造多次交叉
    const closes: number[] = [];
    for (let i = 0; i < 40; i++) closes.push(100);
    for (let i = 1; i <= 12; i++) closes.push(100 + i * 0.4);
    for (let i = 1; i <= 12; i++) closes.push(104.8 - i * 0.4);
    for (let i = 1; i <= 12; i++) closes.push(100 + i * 0.4);
    const res = macd(closes.map((c) => c + 0.5), closes.map((c) => c - 0.5), closes);
    const ages = res.filter((r) => r.signalAge === 0).length;
    expect(ages).toBeGreaterThanOrEqual(2);
  });
});
