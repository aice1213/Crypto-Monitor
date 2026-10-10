import { describe, it, expect } from 'vitest';
import type { CandleDto } from '@crypto-monitor/shared';
import { assessDataQuality } from './index.js';

function mk(times: number[], closes: number[], volumes?: number[]): CandleDto[] {
  return times.map((t, i) => ({
    time: t,
    open: closes[i]!,
    high: closes[i]! + 1,
    low: closes[i]! - 1,
    close: closes[i]!,
    volume: volumes?.[i] ?? 1000,
  }));
}

/** 连续 15m K 线 */
function continuous(n: number, closeAt: (i: number) => number = () => 100): CandleDto[] {
  return mk(
    Array.from({ length: n }, (_, i) => 1_700_000_000 + i * 900),
    Array.from({ length: n }, (_, i) => closeAt(i)),
  );
}

describe('assessDataQuality 数据量分级', () => {
  it('少于 30 根 => INSUFFICIENT，且原样返回不预处理', () => {
    const candles = continuous(29);
    const r = assessDataQuality(candles, 900);
    expect(r.dataQuality).toBe('INSUFFICIENT');
    expect(r.candles).toHaveLength(29);
  });

  it('恰好 30 根且无缺口 => FULL', () => {
    expect(assessDataQuality(continuous(30), 900).dataQuality).toBe('FULL');
  });
});

describe('assessDataQuality 缺口', () => {
  it('存在缺口 => GAPS_FILLED', () => {
    const candles = continuous(40);
    // 挖掉一根，制造一个缺口
    candles.splice(20, 1);
    const r = assessDataQuality(candles, 900);
    expect(r.dataQuality).toBe('GAPS_FILLED');
  });

  it('缺口占比 > 20% => INSUFFICIENT（dev.md 4.4）', () => {
    // 每隔一根就制造一个缺口 => gapRatio 远大于 20%
    const candles = continuous(40).filter((_, i) => i % 2 === 0);
    const r = assessDataQuality(candles, 900);
    expect(r.dataQuality).toBe('INSUFFICIENT');
  });

  it('间隔容差为半个周期，微小抖动不算缺口', () => {
    const candles = continuous(40);
    // 把其中一根时间错开 20 秒（< 450s 容差）
    candles[20] = { ...candles[20]!, time: candles[20]!.time + 20 };
    expect(assessDataQuality(candles, 900).dataQuality).toBe('FULL');
  });
});

describe('assessDataQuality 异常跳变（dev.md 4.4：单根 > 15%）', () => {
  it('超过 15% 的跳变根被中性化：close 回退前收、volume 归零', () => {
    const closes = Array.from({ length: 40 }, () => 100);
    closes[10] = 130; // +30%
    const candles = mk(
      Array.from({ length: 40 }, (_, i) => 1_700_000_000 + i * 900),
      closes,
      Array.from({ length: 40 }, () => 1000),
    );
    const r = assessDataQuality(candles, 900);
    const fixed = r.candles[10]!;
    expect(fixed.close).toBe(100); // 前一根收盘价
    expect(fixed.open).toBe(100);
    expect(fixed.volume).toBe(0);
    // high/low 收敛到与前收的关系，不留下背离自身收盘价的假影线
    expect(fixed.high).toBe(Math.max(100, 130));
    expect(fixed.low).toBe(Math.min(100, 130));
  });

  it('一次异常不连坐恢复根：与已修正的前收比较', () => {
    // 100 → 130（异常）→ 100（恢复）。
    // 若与原始前收 130 比较，恢复根会再被算成 −23% 而连坐；
    // 与修正后的前收 100 比较则涨幅为 0，应保持原值。
    const closes = Array.from({ length: 40 }, () => 100);
    closes[10] = 130;
    const candles = mk(
      Array.from({ length: 40 }, (_, i) => 1_700_000_000 + i * 900),
      closes,
      Array.from({ length: 40 }, () => 1000),
    );
    const r = assessDataQuality(candles, 900);
    expect(r.candles[10]!.volume).toBe(0); // 异常根被中性化
    expect(r.candles[11]!.close).toBe(100); // 恢复根保持原值
    expect(r.candles[11]!.volume).toBe(1000);
  });

  it('恰好 15% 不触发中性化（判定为严格大于）', () => {
    const closes = Array.from({ length: 40 }, () => 100);
    closes[10] = 115;
    const candles = mk(
      Array.from({ length: 40 }, (_, i) => 1_700_000_000 + i * 900),
      closes,
    );
    const r = assessDataQuality(candles, 900);
    expect(r.candles[10]!.close).toBe(115);
    expect(r.candles[10]!.volume).toBe(1000);
  });

  it('不修改入参数组（纯函数）', () => {
    const closes = Array.from({ length: 40 }, () => 100);
    closes[10] = 200;
    const candles = mk(
      Array.from({ length: 40 }, (_, i) => 1_700_000_000 + i * 900),
      closes,
    );
    const snapshot = JSON.stringify(candles);
    assessDataQuality(candles, 900);
    expect(JSON.stringify(candles)).toBe(snapshot);
  });
});
