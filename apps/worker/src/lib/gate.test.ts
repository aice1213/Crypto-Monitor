import { describe, it, expect } from 'vitest';
import {
  evaluateGate,
  windowChangePercent,
  windowDirection,
  keyBreak,
  keyConfirmBand,
  volumeConfirm,
  type GateInput,
} from './gate.js';

/**
 * gate.ts 单元测试（开发交付文档 §3.2、§12 验收 #7/#8/#9）
 *
 * 验收：
 * - #7 AND 逻辑：仅价格穿越关键位但未达确认带 → 不触发（DUAL_CONFIRM/KEY_CONFIRM）
 * - #8 成交量过滤：量 < 1.5×均量 → 不触发
 * - #9 方向一致性：向下插针不触发做多方向预警
 */

function baseInput(overrides: Partial<GateInput> = {}): GateInput {
  return {
    mode: 'PERCENT_ONLY',
    priceStart: 100,
    priceEnd: 101,
    keyPrice: null,
    keyPriceThreshold: 0.3,
    thresholdUsed: 0.5,
    volumeConfirm: true,
    volumeMultiplier: 1.5,
    lastVolume: 200,
    avgVolume: 100,
    directionConsistency: true,
    ...overrides,
  };
}

describe('windowChangePercent / windowDirection', () => {
  it('上涨：+1%', () => {
    expect(windowChangePercent(100, 101)).toBeCloseTo(1.0);
    expect(windowDirection(1)).toBe('UP');
  });
  it('下跌：-1%', () => {
    expect(windowChangePercent(100, 99)).toBeCloseTo(-1.0);
    expect(windowDirection(-1)).toBe('DOWN');
  });
  it('持平：FLAT', () => {
    expect(windowDirection(0)).toBe('FLAT');
  });
});

describe('keyBreak / keyConfirmBand', () => {
  it('价格从下方穿到上方 → brokeUp', () => {
    expect(keyBreak(99, 101, 100)).toEqual({ brokeUp: true, brokeDown: false });
  });
  it('价格从上方穿到下方 → brokeDown', () => {
    expect(keyBreak(101, 99, 100)).toEqual({ brokeUp: false, brokeDown: true });
  });
  it('未穿越（全程上方）→ 均 false', () => {
    expect(keyBreak(101, 102, 100)).toEqual({ brokeUp: false, brokeDown: false });
  });
  it('未穿越（全程下方）→ 均 false', () => {
    expect(keyBreak(99, 98, 100)).toEqual({ brokeUp: false, brokeDown: false });
  });
  it('无关键位 → 均 false', () => {
    expect(keyBreak(99, 101, null)).toEqual({ brokeUp: false, brokeDown: false });
  });
  it('确认带：偏离 0.5% ≥ 0.3% → true', () => {
    expect(keyConfirmBand(100.5, 100, 0.3)).toBe(true);
  });
  it('确认带：偏离 0.2% < 0.3% → false', () => {
    expect(keyConfirmBand(100.2, 100, 0.3)).toBe(false);
  });
});

describe('volumeConfirm（§3.2 附加过滤）', () => {
  it('量 ≥ 1.5×均量 → true', () => {
    expect(volumeConfirm(150, 100, 1.5)).toBe(true);
  });
  it('量 < 1.5×均量 → false', () => {
    expect(volumeConfirm(149, 100, 1.5)).toBe(false);
  });
  it('缺数据 → false（保守，不误报）', () => {
    expect(volumeConfirm(undefined, 100, 1.5)).toBe(false);
    expect(volumeConfirm(200, undefined, 1.5)).toBe(false);
  });
});

describe('模式 A PERCENT_ONLY（§3.2）', () => {
  it('窗口涨跌幅 ≥ 阈值 → 通过', () => {
    const r = evaluateGate(baseInput({ mode: 'PERCENT_ONLY', priceStart: 100, priceEnd: 101, thresholdUsed: 0.5 }));
    expect(r.passed).toBe(true);
    expect(r.changePercent).toBeCloseTo(1.0);
  });
  it('窗口涨跌幅 < 阈值 → 不通过', () => {
    const r = evaluateGate(baseInput({ mode: 'PERCENT_ONLY', priceStart: 100, priceEnd: 100.3, thresholdUsed: 0.5 }));
    expect(r.passed).toBe(false);
    expect(r.reason).toContain('阈值');
  });
});

describe('模式 B KEY_CONFIRM（§3.2，推荐默认）', () => {
  it('突破关键位 + 达确认带 → 通过', () => {
    const r = evaluateGate(
      baseInput({ mode: 'KEY_CONFIRM', priceStart: 99, priceEnd: 100.5, keyPrice: 100, keyPriceThreshold: 0.3, volumeConfirm: false }),
    );
    expect(r.passed).toBe(true);
  });
  it('突破但未达确认带 → 不通过（验收 #7 前半）', () => {
    const r = evaluateGate(
      baseInput({ mode: 'KEY_CONFIRM', priceStart: 99, priceEnd: 100.2, keyPrice: 100, keyPriceThreshold: 0.3, volumeConfirm: false }),
    );
    expect(r.passed).toBe(false);
    expect(r.reason).toContain('确认带');
  });
  it('未突破关键位（全程下方）→ 不通过', () => {
    const r = evaluateGate(
      baseInput({ mode: 'KEY_CONFIRM', priceStart: 98, priceEnd: 99.8, keyPrice: 100, keyPriceThreshold: 0.3, volumeConfirm: false }),
    );
    expect(r.passed).toBe(false);
    expect(r.reason).toContain('关键位');
  });
  it('无关键位 → 不通过', () => {
    const r = evaluateGate(
      baseInput({ mode: 'KEY_CONFIRM', priceStart: 100, priceEnd: 101, keyPrice: null, volumeConfirm: false }),
    );
    expect(r.passed).toBe(false);
  });
});

describe('模式 C DUAL_CONFIRM（§3.2，验收 #7 后半）', () => {
  it('窗口涨跌幅达标 + 突破关键位 → 通过', () => {
    const r = evaluateGate(
      baseInput({ mode: 'DUAL_CONFIRM', priceStart: 99, priceEnd: 101, keyPrice: 100, thresholdUsed: 0.5, volumeConfirm: false }),
    );
    expect(r.passed).toBe(true);
  });
  it('仅窗口涨跌幅达标但未破关键位 → 不通过（验收 #7）', () => {
    const r = evaluateGate(
      baseInput({ mode: 'DUAL_CONFIRM', priceStart: 100, priceEnd: 101, keyPrice: 105, thresholdUsed: 0.5, volumeConfirm: false }),
    );
    expect(r.passed).toBe(false);
    expect(r.reason).toContain('关键位');
  });
  it('仅破关键位但窗口涨跌幅不足 → 不通过（验收 #7）', () => {
    const r = evaluateGate(
      baseInput({ mode: 'DUAL_CONFIRM', priceStart: 99.9, priceEnd: 100.1, keyPrice: 100, thresholdUsed: 0.5, volumeConfirm: false }),
    );
    expect(r.passed).toBe(false);
    expect(r.reason).toContain('阈值');
  });
});

describe('附加过滤（§3.2）', () => {
  it('成交量不足 → 不通过（验收 #8）', () => {
    const r = evaluateGate(
      baseInput({ mode: 'PERCENT_ONLY', priceStart: 100, priceEnd: 101, thresholdUsed: 0.5, volumeConfirm: true, lastVolume: 100, avgVolume: 100 }),
    );
    expect(r.passed).toBe(false);
    expect(r.reason).toContain('成交量');
  });
  it('方向一致性：向下插针后收回上方 → 不触发做多（验收 #9）', () => {
    // 价格从 102 上方插到 99（跌破 100）又收回到 100.5，首尾均在 100 上方 → 未穿越 → 不触发
    const r = evaluateGate(
      baseInput({ mode: 'KEY_CONFIRM', priceStart: 102, priceEnd: 100.5, keyPrice: 100, keyPriceThreshold: 0.3, volumeConfirm: false }),
    );
    expect(r.passed).toBe(false);
    expect(r.reason).toContain('关键位'); // 首尾未穿越，视为未突破
  });
  it('方向一致性：真实跌破（首尾穿越向下）→ 触发做空，方向一致', () => {
    const r = evaluateGate(
      baseInput({ mode: 'KEY_CONFIRM', priceStart: 102, priceEnd: 99, keyPrice: 100, keyPriceThreshold: 0.3, volumeConfirm: false }),
    );
    // 从 102 穿到 99 = brokeDown 穿越，方向 DOWN 一致 → 通过
    expect(r.passed).toBe(true);
    expect(r.brokeDown).toBe(true);
  });
  it('方向一致性关闭时：行为一致（穿越语义不依赖开关）', () => {
    const r = evaluateGate(
      baseInput({ mode: 'KEY_CONFIRM', priceStart: 99, priceEnd: 100.5, keyPrice: 100, keyPriceThreshold: 0.3, volumeConfirm: false, directionConsistency: false }),
    );
    expect(r.passed).toBe(true);
  });
  it('PERCENT_ONLY 不检查方向一致性（纯幅度）', () => {
    const r = evaluateGate(
      baseInput({ mode: 'PERCENT_ONLY', priceStart: 100, priceEnd: 99, thresholdUsed: 0.5, volumeConfirm: false }),
    );
    expect(r.passed).toBe(true); // 下跌 -1% 也触发，纯幅度
  });
});
