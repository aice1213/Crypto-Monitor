import { create } from 'zustand';
import { DEFAULT_SYMBOLS, LS_WATCHLIST_KEY, WATCHLIST_LIMIT } from '@crypto-monitor/shared';
import type { TickerDto, AlertSnapshotDto, IndicatorSnapshotDto } from '@crypto-monitor/shared';

interface WatchlistState {
  symbols: string[];
  tickers: Record<string, TickerDto>;
  alerts: Record<string, AlertSnapshotDto>;
  snapshots: Record<string, IndicatorSnapshotDto>;
  priceFlash: Record<string, 'up' | 'down' | null>;
  addSymbol: (symbol: string) => boolean;
  removeSymbol: (symbol: string) => void;
  setTicker: (symbol: string, ticker: TickerDto) => void;
  setAlert: (symbol: string, alert: AlertSnapshotDto) => void;
  setSnapshot: (symbol: string, snapshot: IndicatorSnapshotDto) => void;
}

function loadWatchlist(): string[] {
  try {
    const raw = localStorage.getItem(LS_WATCHLIST_KEY);
    if (raw) {
      const arr = JSON.parse(raw) as string[];
      if (Array.isArray(arr) && arr.length > 0) return arr;
    }
  } catch {
    // ignore
  }
  return [...DEFAULT_SYMBOLS];
}

export const useWatchlistStore = create<WatchlistState>((set, get) => ({
  symbols: loadWatchlist(),
  tickers: {},
  alerts: {},
  snapshots: {},
  priceFlash: {},

  addSymbol: (symbol: string) => {
    const { symbols } = get();
    if (symbols.includes(symbol)) return false;
    if (symbols.length >= WATCHLIST_LIMIT) return false;
    const next = [...symbols, symbol];
    try {
      localStorage.setItem(LS_WATCHLIST_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
    set({ symbols: next });
    return true;
  },

  removeSymbol: (symbol: string) => {
    const next = get().symbols.filter((s) => s !== symbol);
    try {
      localStorage.setItem(LS_WATCHLIST_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
    set({ symbols: next });
  },

  setTicker: (symbol, ticker) => {
    const prev = get().tickers[symbol];
    let flash: 'up' | 'down' | null = null;
    if (prev && ticker.last !== prev.last) {
      flash = ticker.last > prev.last ? 'up' : 'down';
    }
    set((s) => ({
      tickers: { ...s.tickers, [symbol]: ticker },
      priceFlash: flash ? { ...s.priceFlash, [symbol]: flash } : s.priceFlash,
    }));
    if (flash) {
      setTimeout(() => {
        set((s) => {
          const next = { ...s.priceFlash };
          delete next[symbol];
          return { priceFlash: next };
        });
      }, 500);
    }
  },

  setAlert: (symbol, alert) =>
    set((s) => ({ alerts: { ...s.alerts, [symbol]: alert } })),

  setSnapshot: (symbol, snapshot) =>
    set((s) => ({ snapshots: { ...s.snapshots, [symbol]: snapshot } })),
}));
