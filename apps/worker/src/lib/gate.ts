/**
 * 两级门控判定（开发交付文档 §3.2）
 *
 * 纯函数：不依赖 KV/D1/fetch，输入全部注入，便于单测。
 *
 * 门控逻辑（§3.2）：
 * - 模式 A PERCENT_ONLY：窗口涨跌幅 ≥ thresholdUsed
 * - 模式 B KEY_CONFIRM：价格突破关键位（方向匹配）AND 偏离确认带 ≥ keyPriceThreshold
 * - 模式 C DUAL_CONFIRM：窗口涨跌幅 ≥ thresholdUsed AND 价格突破关键位（方向匹配）
 *
 * 附加过滤（默认开启）：
 * - 成交量确认：窗口最后一根 K 线量 ≥ 前 N 根均量 × volumeMultiplier
 * - 方向一致性：窗口涨跌幅方向与关键位突破方向同向
 */
import type { TriggerMode } from '@crypto-monitor/shared';

/** 门控输入（来自前端上报 / Cron 兜底） */
export interface GateInput {
  mode: TriggerMode;
  /** 窗口起止价 */
  priceStart: number;
  priceEnd: number;
  /** 窗口涨跌幅（%），可由调用方预计算或由 (end-start)/start*100 */
  changePercent?: number;
  /** 关键位（可选） */
  keyPrice: number | null;
  /** 关键位确认带（%） */
  keyPriceThreshold: number;
  /** 窗口涨跌幅阈值（%） */
  thresholdUsed: number;
  /** 成交量确认开关 */
  volumeConfirm: boolean;
  /** 成交量倍数（默认 1.5） */
  volumeMultiplier: number;
  /** 窗口最后一根 K 线成交量 */
  lastVolume?: number;
  /** 前 N 根均量（N=20） */
  avgVolume?: number;
  /** 方向一致性开关 */
  directionConsistency: boolean;
}

export interface GateResult {
  /** 是否通过门控 */
  passed: boolean;
  /** 失败原因（passed=false 时） */
  reason?: string;
  /** 窗口涨跌幅（%） */
  changePercent: number;
  /** 是否向上突破关键位 */
  brokeUp?: boolean;
  /** 是否向下突破关键位 */
  brokeDown?: boolean;
}

/** 计算窗口涨跌幅（%） */
export function windowChangePercent(priceStart: number, priceEnd: number): number {
  if (priceStart <= 0) return 0;
  return ((priceEnd - priceStart) / priceStart) * 100;
}

/** 窗口方向：'UP' | 'DOWN' | 'FLAT' */
export function windowDirection(changePercent: number): 'UP' | 'DOWN' | 'FLAT' {
  if (changePercent > 0) return 'UP';
  if (changePercent < 0) return 'DOWN';
  return 'FLAT';
}

/**
 * 关键位穿越判定（§3.2 模式 B：price_t 突破 keyPrice）。
 *
 * 突破 = 窗口内价格从关键位一侧穿到另一侧（严格穿越语义，验收 #7）。
 * 仅判当前价方位会误报（价格原本就在关键位下方的标的会永远 brokeDown）。
 *
 * @param priceStart 窗口起始价
 * @param priceEnd 窗口结束价（当前价）
 * @param keyPrice 关键位
 * @returns brokeUp（从下方/平价穿到上方）、brokeDown（从上方/平价穿到下方）。无关键位时均 false。
 */
export function keyBreak(
  priceStart: number,
  priceEnd: number,
  keyPrice: number | null,
): { brokeUp: boolean; brokeDown: boolean } {
  if (keyPrice == null || keyPrice <= 0) return { brokeUp: false, brokeDown: false };
  const startUp = priceStart > keyPrice;
  const endUp = priceEnd > keyPrice;
  // 穿越：起始与结束分居两侧（或起始恰在关键位）
  const brokeUp = !startUp && endUp;
  const brokeDown = startUp && !endUp;
  return { brokeUp, brokeDown };
}

/**
 * 关键位确认带判定（§3.2 模式 B）：|price - keyPrice| / keyPrice * 100 ≥ keyPriceThreshold
 */
export function keyConfirmBand(price: number, keyPrice: number | null, bandPct: number): boolean {
  if (keyPrice == null || keyPrice <= 0) return false;
  const dev = (Math.abs(price - keyPrice) / keyPrice) * 100;
  return dev >= bandPct;
}

/**
 * 成交量确认（§3.2 附加过滤）：lastVolume ≥ avgVolume × volumeMultiplier
 */
export function volumeConfirm(
  lastVolume: number | undefined,
  avgVolume: number | undefined,
  multiplier: number,
): boolean {
  if (lastVolume == null || avgVolume == null) return false;
  if (avgVolume <= 0) return false;
  return lastVolume >= avgVolume * multiplier;
}

/**
 * 两级门控主判定（§3.2）。
 */
export function evaluateGate(input: GateInput): GateResult {
  const changePercent =
    input.changePercent ?? windowChangePercent(input.priceStart, input.priceEnd);
  const direction = windowDirection(changePercent);
  const { brokeUp, brokeDown } = keyBreak(input.priceStart, input.priceEnd, input.keyPrice);
  const brokeAny = brokeUp || brokeDown;

  switch (input.mode) {
    case 'PERCENT_ONLY': {
      // 模式 A：仅窗口涨跌幅
      if (Math.abs(changePercent) < input.thresholdUsed) {
        return {
          passed: false,
          reason: `窗口涨跌幅 ${changePercent.toFixed(2)}% < 阈值 ${input.thresholdUsed}%`,
          changePercent,
        };
      }
      break;
    }
    case 'KEY_CONFIRM': {
      // 模式 B：突破关键位 + 确认带
      if (!brokeAny || !input.keyPrice) {
        return {
          passed: false,
          reason: '价格未突破关键位',
          changePercent,
          brokeUp,
          brokeDown,
        };
      }
      if (!keyConfirmBand(input.priceEnd, input.keyPrice, input.keyPriceThreshold)) {
        return {
          passed: false,
          reason: `未达确认带 ±${input.keyPriceThreshold}%`,
          changePercent,
          brokeUp,
          brokeDown,
        };
      }
      break;
    }
    case 'DUAL_CONFIRM': {
      // 模式 C：窗口涨跌幅 + 关键位突破
      if (Math.abs(changePercent) < input.thresholdUsed) {
        return {
          passed: false,
          reason: `窗口涨跌幅 ${changePercent.toFixed(2)}% < 阈值 ${input.thresholdUsed}%`,
          changePercent,
          brokeUp,
          brokeDown,
        };
      }
      if (!brokeAny || !input.keyPrice) {
        return {
          passed: false,
          reason: '价格未突破关键位',
          changePercent,
          brokeUp,
          brokeDown,
        };
      }
      break;
    }
  }

  // 附加过滤：方向一致性（§3.2）
  if (input.directionConsistency && input.mode !== 'PERCENT_ONLY') {
    // 方向一致性：窗口方向与关键位突破方向同向
    if (brokeUp && direction === 'DOWN') {
      return {
        passed: false,
        reason: '方向不一致：向上突破但窗口向下',
        changePercent,
        brokeUp,
        brokeDown,
      };
    }
    if (brokeDown && direction === 'UP') {
      return {
        passed: false,
        reason: '方向不一致：向下突破但窗口向上',
        changePercent,
        brokeUp,
        brokeDown,
      };
    }
  }

  // 附加过滤：成交量确认（§3.2）
  if (input.volumeConfirm) {
    if (!volumeConfirm(input.lastVolume, input.avgVolume, input.volumeMultiplier)) {
      return {
        passed: false,
        reason: '成交量不足确认',
        changePercent,
        brokeUp,
        brokeDown,
      };
    }
  }

  return { passed: true, changePercent, brokeUp, brokeDown };
}
