/**
 * Symbol 规范化（dev.md 2.1）
 */
const SYMBOL_REGEX = /^[A-Z0-9]{2,20}_(PERP|USDT|USD)$/;

const ALIASES: Record<string, string> = {
  BTC: 'BTC_USDT',
  比特币: 'BTC_USDT',
  大饼: 'BTC_USDT',
  ETH: 'ETH_USDT',
  以太坊: 'ETH_USDT',
  以太: 'ETH_USDT',
  SOL: 'SOL_USDT',
  索拉纳: 'SOL_USDT',
  索拉: 'SOL_USDT',
  BNB: 'BNB_USDT',
  币安币: 'BNB_USDT',
  XRP: 'XRP_USDT',
  瑞波: 'XRP_USDT',
  ADA: 'ADA_USDT',
  艾达: 'ADA_USDT',
  DOGE: 'DOGE_USDT',
  狗狗币: 'DOGE_USDT',
};

function normalizeFullwidth(input: string): string {
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0);
    if (code === undefined) continue;
    if (code >= 0xff01 && code <= 0xff5e) {
      out += String.fromCodePoint(code - 0xfee0);
    } else if (code === 0x3000) {
      out += ' ';
    } else {
      out += ch;
    }
  }
  return out;
}

function stripSeparators(input: string): string {
  // 注意：`[` 与 `]` 必须写成 \u005B / \u005D。
  // 直接写 `[...[]【】]` 会让 `]` 提前闭合字符类，正则静默失效（已实测：符号规范化不再去除任何分隔符）；
  // 而只去掉 `\[` 的反斜杠又会被 eslint 的 no-useless-escape 误判为可简化。
  return input.replace(/[\s\-_/，。,、.()（）\u005B\u005D【】]+/g, '');
}

export function normalizeSymbol(input: string): string {
  const s = normalizeFullwidth(input).trim();
  const compact = stripSeparators(s);

  if (ALIASES[compact]) {
    return ALIASES[compact];
  }
  if (ALIASES[s]) {
    return ALIASES[s];
  }

  const upper = compact.toUpperCase();
  if (ALIASES[upper]) {
    return ALIASES[upper];
  }

  if (upper.includes('_')) {
    return upper.replace(/-/g, '_');
  }

  if (upper.endsWith('USDT')) {
    const base = upper.slice(0, -4);
    return /^[A-Z0-9]+$/.test(base) ? `${base}_USDT` : upper.replace(/-/g, '_');
  }

  // `_PERP` 也是 dev.md 2.1 认可的合法后缀（校验正则为 ^[A-Z0-9]{2,20}_(PERP|USDT|USD)$），
  // 但分隔符在归一化早期就被剥离，若不显式还原，`BTC_PERP` 会变成 `BTCPERP_USDT`——
  // 归一化永远产不出 `_PERP`，与自己的校验正则不一致。
  if (upper.endsWith('PERP')) {
    const base = upper.slice(0, -4);
    if (/^[A-Z0-9]{2,20}$/.test(base)) return `${base}_PERP`;
  }

  if (upper.endsWith('USD')) {
    const base = upper.slice(0, -3);
    return /^[A-Z0-9]+$/.test(base) ? `${base}_USD` : upper.replace(/-/g, '_');
  }

  if (/^[A-Z0-9]+$/.test(upper)) {
    return `${upper}_USDT`;
  }

  return upper.replace(/-/g, '_');
}

export function isValidSymbol(symbol: string): boolean {
  return SYMBOL_REGEX.test(symbol);
}

export function normalizeAndValidate(input: string): { symbol: string; valid: boolean } {
  const symbol = normalizeSymbol(input);
  return { symbol, valid: isValidSymbol(symbol) };
}
