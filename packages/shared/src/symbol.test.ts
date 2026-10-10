import { describe, it, expect } from 'vitest';
import { isValidSymbol, normalizeAndValidate, normalizeSymbol } from './symbol.js';

describe('normalizeSymbol 基本归一（dev.md 2.1）', () => {
  it('缺省后缀补 USDT', () => {
    expect(normalizeSymbol('btc')).toBe('BTC_USDT');
    expect(normalizeSymbol('BTC')).toBe('BTC_USDT');
    expect(normalizeSymbol('sol')).toBe('SOL_USDT');
  });

  it('紧连写法拆分', () => {
    expect(normalizeSymbol('btcusdt')).toBe('BTC_USDT');
    expect(normalizeSymbol('BTCUSDT')).toBe('BTC_USDT');
    expect(normalizeSymbol('ethusdt')).toBe('ETH_USDT');
  });

  it('各种分隔符都能吃下', () => {
    expect(normalizeSymbol('btc_usdt')).toBe('BTC_USDT');
    expect(normalizeSymbol('BTC-USDT')).toBe('BTC_USDT');
    expect(normalizeSymbol('btc usdt')).toBe('BTC_USDT');
  });

  it('全角转半角', () => {
    expect(normalizeSymbol('ＢＴＣ')).toBe('BTC_USDT');
    expect(normalizeSymbol('ｂｔｃｕｓｄｔ')).toBe('BTC_USDT');
  });

  it('中文别名', () => {
    expect(normalizeSymbol('比特币')).toBe('BTC_USDT');
    expect(normalizeSymbol('大饼')).toBe('BTC_USDT');
    expect(normalizeSymbol('以太坊')).toBe('ETH_USDT');
    expect(normalizeSymbol('以太')).toBe('ETH_USDT');
    expect(normalizeSymbol('狗狗币')).toBe('DOGE_USDT');
  });

  it('首尾空白被裁剪', () => {
    expect(normalizeSymbol('  btc  ')).toBe('BTC_USDT');
  });
});

describe('normalizeSymbol 分隔符与括号剥离', () => {
  // 回归：stripSeparators 的字符类里 `[`/`]` 若不加 \u 转义，
  // `]` 会提前闭合字符类，正则静默失效、分隔符一个都去不掉。
  it('方括号被剥离', () => {
    expect(normalizeSymbol('BTC[USDT]')).toBe('BTC_USDT');
    expect(normalizeSymbol('[BTC]')).toBe('BTC_USDT');
  });

  it('圆括号与中文括号被剥离', () => {
    expect(normalizeSymbol('BTC(USDT)')).toBe('BTC_USDT');
    expect(normalizeSymbol('BTC（USDT）')).toBe('BTC_USDT');
    expect(normalizeSymbol('【BTC】')).toBe('BTC_USDT');
  });

  it('中文标点与斜杠被剥离', () => {
    expect(normalizeSymbol('BTC，USDT')).toBe('BTC_USDT');
    expect(normalizeSymbol('BTC/USDT')).toBe('BTC_USDT');
    expect(normalizeSymbol('BTC、USDT')).toBe('BTC_USDT');
  });

  it('混合分隔符仍能得到干净结果', () => {
    expect(normalizeSymbol(' btc /【usdt】 ')).toBe('BTC_USDT');
  });
});

describe('normalizeSymbol 后缀处理', () => {
  it('USD 后缀保留', () => {
    expect(normalizeSymbol('btcusd')).toBe('BTC_USD');
  });

  it('USDT 优先于 USD 匹配', () => {
    // 'BTCUSDT' 若先匹配 USD，会得到 'BTCUS_USDT' 之类的错误结果
    expect(normalizeSymbol('BTCUSDT')).toBe('BTC_USDT');
  });

  it('_PERP 后缀被保留（与校验正则一致）', () => {
    expect(normalizeSymbol('BTC_PERP')).toBe('BTC_PERP');
    expect(normalizeSymbol('btc-perp')).toBe('BTC_PERP');
  });

  it('PERP 长度不足时不误判', () => {
    expect(normalizeSymbol('PERP')).toBe('PERP_USDT');
  });
});

describe('isValidSymbol / normalizeAndValidate', () => {
  it('接受标准形式', () => {
    for (const s of ['BTC_USDT', 'ETH_USDT', 'BTC_USD', 'BTC_PERP', '1000PEPE_USDT']) {
      expect(isValidSymbol(s), s).toBe(true);
    }
  });

  it('拒绝非法形式', () => {
    for (const s of ['', 'BTC', 'BTC_USDT_', '_USDT', 'B_USDT', 'BTC-EUR', 'btc_usdt', '!!!']) {
      expect(isValidSymbol(s), s).toBe(false);
    }
  });

  it('常见用户输入经归一后均合法', () => {
    for (const raw of ['btc', 'BTC', 'btcusdt', 'BTC-USDT', '比特币', 'ＢＴＣ', ' btc_usdt ']) {
      const r = normalizeAndValidate(raw);
      expect(r.valid, `${raw} -> ${r.symbol}`).toBe(true);
      expect(r.symbol).toBe('BTC_USDT');
    }
  });

  it('无意义输入返回 valid=false', () => {
    expect(normalizeAndValidate('!!!').valid).toBe(false);
    expect(normalizeAndValidate('   ').valid).toBe(false);
  });

  it('全是分隔符时不panic且判为非法', () => {
    expect(() => normalizeAndValidate('___---   ')).not.toThrow();
    expect(normalizeAndValidate('___---   ').valid).toBe(false);
  });
});
