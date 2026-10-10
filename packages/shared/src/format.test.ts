import { describe, it, expect } from 'vitest';
import { fmtPrice, formatBeijingFromIso, formatBeijingShort, formatBeijingTime, toUnixSeconds } from './format.js';

describe('fmtPrice 精度分级', () => {
  it('>= 1 保留 2 位小数', () => {
    expect(fmtPrice(83274.5)).toBe('83274.50');
    expect(fmtPrice(1)).toBe('1.00');
  });

  it('0.01 ~ 1 保留 4 位小数', () => {
    expect(fmtPrice(0.0851)).toBe('0.0851');
    expect(fmtPrice(0.5)).toBe('0.5000');
  });

  it('< 0.01 保留 6 位小数', () => {
    expect(fmtPrice(0.00001234)).toBe('0.000012');
    expect(fmtPrice(0.009)).toBe('0.009000');
  });

  it('负数按绝对值分级', () => {
    expect(fmtPrice(-83274.5)).toBe('-83274.50');
    expect(fmtPrice(-0.005)).toBe('-0.005000');
  });

  it('0 走 6 位分支', () => {
    expect(fmtPrice(0)).toBe('0.000000');
  });
});

describe('toUnixSeconds', () => {
  it('秒保持原值，毫秒换算为秒', () => {
    expect(toUnixSeconds(1_700_000_000)).toBe(1_700_000_000);
    expect(toUnixSeconds(1_700_000_000_000)).toBe(1_700_000_000);
  });
});

describe('formatBeijingTime', () => {
  it('按 UTC+8 输出 YYYY-MM-DD HH:mm:ss', () => {
    // 2026-10-09T12:00:00Z => 北京时间 2026-10-09 20:00:00
    expect(formatBeijingTime(Date.UTC(2026, 9, 9, 12, 0, 0) / 1000)).toBe('2026-10-09 20:00:00');
  });

  it('同时接受秒与毫秒，结果一致', () => {
    const sec = Date.UTC(2026, 9, 9, 12, 0, 0) / 1000;
    expect(formatBeijingTime(sec)).toBe(formatBeijingTime(sec * 1000));
  });

  it('跨日正确进位', () => {
    // 2026-10-09T17:30:00Z => 北京时间次日 01:30:00
    expect(formatBeijingTime(Date.UTC(2026, 9, 9, 17, 30, 0) / 1000)).toBe('2026-10-10 01:30:00');
  });

  it('不依赖运行环境时区（固定偏移）', () => {
    // 同一天 UTC 00:00 换算后应是北京时间 08:00
    expect(formatBeijingTime(Date.UTC(2026, 0, 1, 0, 0, 0) / 1000)).toBe('2026-01-01 08:00:00');
  });
});

describe('formatBeijingShort / formatBeijingFromIso', () => {
  it('短格式为 MM-DD HH:mm', () => {
    expect(formatBeijingShort(Date.UTC(2026, 9, 9, 12, 34, 0) / 1000)).toBe('10-09 20:34');
  });

  it('ISO 字符串走同一套规则', () => {
    expect(formatBeijingFromIso('2026-10-09T12:34:00Z')).toBe('10-09 20:34');
  });

  it('非法 ISO 原样返回，不抛错', () => {
    expect(formatBeijingFromIso('not-a-date')).toBe('not-a-date');
  });
});
