import { describe, it, expect } from 'vitest';
import { obv } from './index.js';

describe('obv 累加规则（dev.md 4.1）', () => {
  it('obv += sign(close − prevClose) × volume，首根为 0', () => {
    // closes: 10 → 11 → 10 → 12 ; volumes: 1,2,3,4
    // obv:      0 → +2 → −3 → +4  => [0, 2, -1, 3]
    const r = obv([10, 11, 10, 12], [1, 2, 3, 4]);
    expect(r.map((x) => x.value)).toEqual([0, 2, -1, 3]);
  });

  it('平盘（close 不变）不改变 obv', () => {
    const r = obv([10, 10, 10, 10], [5, 5, 5, 5]);
    expect(r.map((x) => x.value)).toEqual([0, 0, 0, 0]);
  });

  it('长度与输入一致；空输入返回空数组', () => {
    expect(obv([1, 2, 3], [1, 1, 1])).toHaveLength(3);
    expect(obv([], [])).toEqual([]);
  });

  it('数据不足 20 根时 ma20 未就绪，flow 一律 BALANCED 且 ma20 回退为 obv 自身', () => {
    const r = obv([10, 11, 12], [1, 1, 1]);
    expect(r.every((x) => x.flow === 'BALANCED')).toBe(true);
    expect(r[2]!.ma20).toBe(r[2]!.value);
  });
});

describe('obv 流入/流出需要 obv 与 MA20 的关系与 5 周期斜率同号', () => {
  it('持续放量上涨 => INFLOW', () => {
    const closes = Array.from({ length: 25 }, (_, i) => 100 + i);
    const volumes = Array.from({ length: 25 }, () => 10);
    const r = obv(closes, volumes);
    expect(r[r.length - 1]!.flow).toBe('INFLOW');
  });

  it('持续放量下跌 => OUTFLOW', () => {
    const closes = Array.from({ length: 25 }, (_, i) => 100 - i);
    const volumes = Array.from({ length: 25 }, () => 10);
    const r = obv(closes, volumes);
    expect(r[r.length - 1]!.flow).toBe('OUTFLOW');
  });

  it('obv 高于 MA20 但斜率转负时不判为流入（需同号）', () => {
    // 先长时间上涨把 obv 推高，再连续下跌使斜率转负
    const closes: number[] = [];
    for (let i = 0; i < 30; i++) closes.push(100 + i);
    for (let i = 0; i < 6; i++) closes.push(130 - i * 5);
    const volumes = closes.map(() => 10);
    const r = obv(closes, volumes);
    const last = r[r.length - 1]!;
    expect(last.value).toBeGreaterThan(last.ma20);
    expect(last.flow).not.toBe('INFLOW');
  });
});

describe('obv 量能指标', () => {
  it('volumeRatio = 当前成交量 / 近 20 根均量', () => {
    const closes = Array.from({ length: 4 }, (_, i) => 100 + i);
    const volumes = [1, 2, 3, 4];
    const r = obv(closes, volumes);
    // 第 4 根：窗口为全部 4 根，均量 = 2.5，当前 = 4
    expect(r[3]!.volumeRatio).toBeCloseTo(4 / 2.5, 10);
  });

  it('volumeAvg20ChangePct 是**成交量**相对均量的变化率', () => {
    const closes = Array.from({ length: 4 }, (_, i) => 100 + i);
    const volumes = [1, 2, 3, 4];
    const r = obv(closes, volumes);
    expect(r[3]!.volumeAvg20ChangePct).toBeCloseTo(((4 - 2.5) / 2.5) * 100, 10);
  });

  it('已收盘数据下量比应接近 1 量级；未收盘时将显著偏离（回归背景说明）', () => {
    // 20 根等量 + 一根等量，ratio 应接近 1
    const closes = Array.from({ length: 21 }, (_, i) => 100 + i);
    const volumes = Array.from({ length: 21 }, () => 100);
    const r = obv(closes, volumes);
    expect(r[20]!.volumeRatio).toBeCloseTo(1, 10);
  });
});
