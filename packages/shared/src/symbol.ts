/**
 * Symbol 规范化（dev.md 2.1）
 */
const SYMBOL_REGEX = /^[A-Z0-9]{2,20}_(PERP|USDT|USD)$/;

export function normalizeSymbol(input: string): string {
  let s = input.trim().toUpperCase().replace(/\s+/g, '');

  if (!s.includes('_') && !s.includes('-')) {
    if (s.endsWith('USDT')) {
      s = `${s.slice(0, -4)}_USDT`;
    } else if (s.endsWith('USD')) {
      s = `${s.slice(0, -3)}_USD`;
    } else if (/^[A-Z]+$/.test(s)) {
      s = `${s}_USDT`;
    }
  }

  s = s.replace(/-/g, '_').replace(/\s+/g, '_');

  return s;
}

export function isValidSymbol(symbol: string): boolean {
  return SYMBOL_REGEX.test(symbol);
}

export function normalizeAndValidate(input: string): { symbol: string; valid: boolean } {
  const symbol = normalizeSymbol(input);
  return { symbol, valid: isValidSymbol(symbol) };
}
