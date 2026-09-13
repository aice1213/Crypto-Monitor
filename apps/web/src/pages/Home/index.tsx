import { useState, useCallback } from 'react';
import {
  DEFAULT_SYMBOLS,
  normalizeAndValidate,
  WATCHLIST_LIMIT,
} from '@crypto-monitor/shared';
import { useWatchlistStore } from '../../store/watchlist';
import { usePolling } from '../../hooks/usePolling';
import { api } from '../../lib/api';
import { buildAlert } from '../../lib/alert';
import { MonitorCard } from '../../components/Card/MonitorCard';

export function Home() {
  const symbols = useWatchlistStore((s) => s.symbols);
  const tickers = useWatchlistStore((s) => s.tickers);
  const alerts = useWatchlistStore((s) => s.alerts);
  const snapshots = useWatchlistStore((s) => s.snapshots);
  const priceFlash = useWatchlistStore((s) => s.priceFlash);
  const addSymbol = useWatchlistStore((s) => s.addSymbol);
  const removeSymbol = useWatchlistStore((s) => s.removeSymbol);
  const setTicker = useWatchlistStore((s) => s.setTicker);
  const setAlert = useWatchlistStore((s) => s.setAlert);
  const setSnapshot = useWatchlistStore((s) => s.setSnapshot);

  const [input, setInput] = useState('');
  const [error, setError] = useState('');

  const pollTickers = useCallback(async () => {
    // 高频：只拉 ticker（轻量）
    await Promise.all(
      symbols.map(async (symbol) => {
        try {
          const ticker = await api.getTicker(symbol).catch(() => null);
          if (ticker) setTicker(symbol, ticker);
        } catch {
          // ignore
        }
      }),
    );
  }, [symbols, setTicker]);

  const pollHeavy = useCallback(async () => {
    // 低频：拉 candles + funding + stats（重量级）
    await Promise.all(
      symbols.map(async (symbol) => {
        try {
          const [candles15m, candles1h, funding, stats] = await Promise.all([
            api.getCandles(symbol, '15m').catch(() => null),
            api.getCandles(symbol, '1h').catch(() => null),
            api.getFunding(symbol).catch(() => null),
            api.getStats(symbol).catch(() => null),
          ]);

          if (candles15m) {
            setSnapshot(symbol, candles15m.snapshot);
            const alert = buildAlert({
              snapshot15m: candles15m.snapshot,
              snapshot1h: candles1h?.snapshot,
              funding: funding ?? undefined,
              stats: stats ?? undefined,
            });
            setAlert(symbol, alert);
          }
        } catch {
          // ignore
        }
      }),
    );
  }, [symbols, setAlert, setSnapshot]);

  usePolling(pollTickers, 3000); // ticker 3s
  usePolling(pollHeavy, 15000); // 指标 15s

  const handleAdd = async () => {
    setError('');
    const { symbol, valid } = normalizeAndValidate(input);
    if (!valid) {
      setError('无效的交易对符号');
      return;
    }
    if (symbols.includes(symbol)) {
      setError('该标的已在监控列表');
      return;
    }
    if (symbols.length >= WATCHLIST_LIMIT) {
      setError(`监控列表已达上限 ${WATCHLIST_LIMIT} 个`);
      return;
    }
    try {
      const { exists } = await api.checkContract(symbol);
      if (!exists) {
        setError('合约不存在或未上市');
        return;
      }
    } catch {
      // 预检失败不阻断
    }
    addSymbol(symbol);
    setInput('');
  };

  return (
    <div className="min-h-screen bg-bg text-text p-4">
      <header className="max-w-7xl mx-auto mb-4">
        <h1 className="text-2xl font-bold text-white mb-1">
          加密货币实时监控与 AI 策略分析
        </h1>
        <p className="text-gray-500 text-xs mb-4">
          数据来源：Gate.io USDT 永续合约 · 仅供学习参考，不构成投资建议
        </p>

        <div className="flex flex-wrap gap-2 items-center mb-3">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            placeholder="输入标的，如 BTC、ETHUSDT、BTC_USDT"
            className="bg-card border border-cardborder rounded px-3 py-1.5 text-sm text-white placeholder-gray-500 outline-none focus:border-gold flex-1 min-w-[200px]"
          />
          <button
            onClick={handleAdd}
            className="px-4 py-1.5 bg-gold text-black rounded text-sm font-medium hover:brightness-110"
          >
            添加
          </button>
          {error && <span className="text-down text-xs">{error}</span>}
        </div>

        <div className="flex flex-wrap gap-2">
          {DEFAULT_SYMBOLS.filter((s) => !symbols.includes(s)).map((s) => (
            <button
              key={s}
              onClick={() => addSymbol(s)}
              className="px-2 py-1 text-xs border border-gold/40 text-gold/80 rounded hover:bg-gold/10"
            >
              + {s}
            </button>
          ))}
          <span className="text-gray-600 text-xs self-center">
            {symbols.length}/{WATCHLIST_LIMIT}
          </span>
        </div>
      </header>

      <main className="max-w-7xl mx-auto">
        {symbols.length === 0 ? (
          <div className="text-center text-gray-500 py-20">暂无监控标的，请在上方添加</div>
        ) : (
          <div
            className="grid gap-3"
            style={{
              gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            }}
          >
            {symbols.map((symbol) => (
              <MonitorCard
                key={symbol}
                symbol={symbol}
                ticker={tickers[symbol]}
                alert={alerts[symbol]}
                snapshot={snapshots[symbol]}
                flash={priceFlash[symbol]}
                onRemove={removeSymbol}
              />
            ))}
          </div>
        )}
      </main>

      <footer className="max-w-7xl mx-auto mt-8 text-center text-gray-600 text-xs">
        本内容仅供学习参考，不构成投资建议；加密货币交易风险极高，请自行决策、控制风险。
      </footer>
    </div>
  );
}
