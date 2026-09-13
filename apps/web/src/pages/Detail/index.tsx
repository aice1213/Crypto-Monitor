import { useEffect, useState, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import type {
  CandleDto,
  IndicatorSnapshotDto,
  AiStrategyDto,
  TickerDto,
} from '@crypto-monitor/shared';
import { AI_REGEN_COOLDOWN_MS, AI_DISCLAIMER, RSI_OVERBOUGHT, RSI_OVERSOLD } from '@crypto-monitor/shared';
import { api } from '../../lib/api';
import { KlineChart } from '../../components/Chart/KlineChart';
import { usePolling } from '../../hooks/usePolling';

function min(nums: number[]): number | undefined {
  return nums.length ? Math.min(...nums) : undefined;
}

function max(nums: number[]): number | undefined {
  return nums.length ? Math.max(...nums) : undefined;
}

export function Detail() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const symbol = params.get('symbol') || 'BTC_USDT';

  const [interval, setInterval] = useState<'1m' | '5m' | '15m'>('15m');
  const [candles, setCandles] = useState<CandleDto[]>([]);
  const [snapshot, setSnapshot] = useState<IndicatorSnapshotDto | null>(null);
  const [ticker, setTicker] = useState<TickerDto | null>(null);
  const [ai, setAi] = useState<AiStrategyDto | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [lastRegen, setLastRegen] = useState(0);

  const loadTicker = useCallback(async () => {
    try {
      const t = await api.getTicker(symbol).catch(() => null);
      if (t) setTicker(t);
    } catch {
      // ignore
    }
  }, [symbol]);

  const loadCandles = useCallback(async () => {
    try {
      const c = await api.getCandles(symbol, interval).catch(() => null);
      if (c) {
        setCandles(c.candles);
        setSnapshot(c.snapshot);
      }
    } catch {
      // ignore
    }
  }, [symbol, interval]);

  usePolling(loadTicker, 3000); // ticker 3s
  usePolling(loadCandles, 15000); // K线+指标 15s

  const generateAi = useCallback(async () => {
    if (!ticker || !snapshot) return;
    if (Date.now() - lastRegen < AI_REGEN_COOLDOWN_MS) return;
    setAiLoading(true);
    setLastRegen(Date.now());
    try {
      const result = await api.getAiStrategy({
        symbol,
        interval,
        ticker: { last: ticker.last, change24h: ticker.change24h },
        snapshot,
      });
      setAi(result);
    } catch {
      // ignore
    } finally {
      setAiLoading(false);
    }
  }, [symbol, interval, ticker, snapshot, lastRegen]);

  useEffect(() => {
    if (ticker && snapshot && !ai) {
      generateAi();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker, snapshot]);

  const regenDisabled = Date.now() - lastRegen < AI_REGEN_COOLDOWN_MS;

  return (
    <div className="min-h-screen bg-bg text-text p-4">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <button onClick={() => navigate('/')} className="text-gold text-sm hover:underline">
            ← 返回监控面板
          </button>
          <h1 className="text-xl font-bold text-white">{symbol}</h1>
          <div className="flex gap-1">
            {(['1m', '5m', '15m'] as const).map((tf) => (
              <button
                key={tf}
                onClick={() => setInterval(tf)}
                className={`px-2 py-1 text-xs rounded ${
                  interval === tf ? 'bg-gold text-black' : 'bg-card text-gray-400 hover:text-white'
                }`}
              >
                {tf}
              </button>
            ))}
          </div>
        </div>

        {ticker && (
          <div className="bg-card border border-cardborder rounded-lg p-3 mb-4 flex gap-6 text-sm flex-wrap">
            <div>
              <span className="text-gray-500">最新价 </span>
              <span className="text-text font-mono font-semibold">
                {ticker.last.toLocaleString()}
              </span>
            </div>
            <div>
              <span className="text-gray-500">24h涨跌 </span>
              <span className={ticker.change24h >= 0 ? 'text-up' : 'text-down'}>
                {ticker.change24h >= 0 ? '+' : ''}
                {(ticker.change24h * 100).toFixed(2)}%
              </span>
            </div>
            <div>
              <span className="text-gray-500">24h高 </span>
              <span className="text-white font-mono">{ticker.high24h.toFixed(4)}</span>
            </div>
            <div>
              <span className="text-gray-500">24h低 </span>
              <span className="text-white font-mono">{ticker.low24h.toFixed(4)}</span>
            </div>
            <div>
              <span className="text-gray-500">24h额 </span>
              <span className="text-white font-mono">{(ticker.volume24h / 1e6).toFixed(1)}M</span>
            </div>
          </div>
        )}

        {candles.length > 0 && snapshot && (
          <div className="bg-card border border-cardborder rounded-lg p-3 mb-4">
            <KlineChart candles={candles} snapshot={snapshot} />
          </div>
        )}

        {snapshot && (
          <div className="bg-card border border-cardborder rounded-lg p-4 mb-4">
            <h2 className="text-white font-semibold mb-3">决策面板</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm mb-3">
              <div>
                <div className="text-gray-500 text-xs">EMA 结构</div>
                <div className="text-white">{snapshot.emaStructure}</div>
              </div>
              <div>
                <div className="text-gray-500 text-xs">RSI(14)</div>
                <div
                  className={
                    snapshot.rsiZone === 'OVERBOUGHT'
                      ? 'text-down'
                      : snapshot.rsiZone === 'OVERSOLD'
                        ? 'text-up'
                        : 'text-white'
                  }
                >
                  {snapshot.rsi14.toFixed(1)} ({snapshot.rsiZone})
                </div>
              </div>
              <div>
                <div className="text-gray-500 text-xs">MACD 信号</div>
                <div
                  className={
                    snapshot.macd.signal === 'GOLDEN_CROSS'
                      ? 'text-up'
                      : snapshot.macd.signal === 'DEATH_CROSS'
                        ? 'text-down'
                        : 'text-white'
                  }
                >
                  {snapshot.macd.signal}
                </div>
              </div>
              <div>
                <div className="text-gray-500 text-xs">综合评分</div>
                <div
                  className={
                    snapshot.trend.direction === 'BULLISH'
                      ? 'text-up'
                      : snapshot.trend.direction === 'BEARISH'
                        ? 'text-down'
                        : 'text-white'
                  }
                >
                  {snapshot.trend.score} / 100 · {snapshot.trend.direction}
                </div>
              </div>
            </div>

            <div className="rounded-lg bg-black/20 border border-cardborder p-3 text-sm mb-4">
              <div className="text-white font-medium mb-1">趋势结构</div>
              <div className="text-gray-300">EMA {snapshot.emaStructure}，短期均线与长期均线未形成一致方向</div>
              <div className="text-gray-500 text-xs mt-1">
                RSI {snapshot.rsi14.toFixed(1)} · {snapshot.rsi14 >= RSI_OVERBOUGHT ? '偏多但接近超买' : snapshot.rsi14 <= RSI_OVERSOLD ? '偏弱且接近超卖' : '中性但未远离警戒区'}
                {'；'}MACD {snapshot.macd.signal}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              <div>
                <div className="text-gray-500 text-xs mb-1">关键价位</div>
                <div className="space-y-2">
                  <div className="text-xs text-gray-300">
                    <span className="text-gray-500">即时支撑：</span>
                    <span className="font-mono">{min(snapshot.support)?.toFixed(4)}–{max(snapshot.support)?.toFixed(4)}</span>
                  </div>
                  <div className="text-xs text-gray-300">
                    <span className="text-gray-500">关键支撑：</span>
                    <span className="font-mono">{min(snapshot.support)?.toFixed(4)}</span>
                  </div>
                  <div className="text-xs text-gray-300">
                    <span className="text-gray-500">下方风险位：</span>
                    <span className="font-mono">{(min(snapshot.support) ?? 0).toFixed(4)}</span>
                  </div>
                  <div className="text-xs text-gray-300">
                    <span className="text-gray-500">上方阻力：</span>
                    <span className="font-mono">{max(snapshot.resistance)?.toFixed(4)}</span>
                  </div>
                  <div className="mt-2 h-2 w-full rounded bg-black/30 border border-cardborder relative overflow-hidden">
                    <div className="absolute inset-y-0 left-0 right-0 bg-gradient-to-r from-up/30 via-gold/20 to-down/30" />
                    <div
                      className="absolute top-1/2 -translate-y-1/2 h-3 w-0.5 bg-white"
                      style={{
                        left: `${(() => {
                          const low = min(snapshot.support);
                          const high = max(snapshot.resistance);
                          const current = ticker?.last ?? 0;
                          if (low == null || high == null || high <= low) return 50;
                          return Math.min(100, Math.max(0, ((current - low) / (high - low)) * 100));
                        })()}%`,
                      }}
                    />
                  </div>
                </div>
              </div>
              <div>
                <div className="text-gray-500 text-xs mb-1">综合判断</div>
                <div className="text-gray-300">
                  评分：{snapshot.trend.score} / 100 → {snapshot.trend.direction}
                </div>
                <div className="text-gray-300">
                  信号：EMA {snapshot.emaStructure} + MACD {snapshot.macd.signal}
                </div>
                <div className="text-gray-500 text-xs mt-1">
                  {snapshot.plan ? '已有可执行计划' : '观望：信号冲突 / 盈亏比不足'}
                </div>
              </div>
            </div>

            <div className="mt-4 pt-4 border-t border-cardborder">
              <h3 className="text-white font-medium mb-2">交易计划</h3>
              {snapshot.plan ? (
                <div className="grid grid-cols-2 md:grid-cols-6 gap-3 text-sm">
                  <div>
                    <div className="text-gray-500 text-xs">当前动作</div>
                    <div className={snapshot.plan.side === 'LONG' ? 'text-up font-semibold' : 'text-down font-semibold'}>
                      {snapshot.plan.side === 'LONG' ? '做多' : '做空'}
                    </div>
                  </div>
                  <div>
                    <div className="text-gray-500 text-xs">进场区</div>
                    <div className="text-white font-mono text-xs">
                      {snapshot.plan.entryLow.toFixed(4)}~{snapshot.plan.entryHigh.toFixed(4)}
                    </div>
                  </div>
                  <div>
                    <div className="text-gray-500 text-xs">目标1</div>
                    <div className="text-up font-mono text-xs">{snapshot.plan.tp1.toFixed(4)}</div>
                  </div>
                  <div>
                    <div className="text-gray-500 text-xs">目标2</div>
                    <div className="text-up font-mono text-xs">{snapshot.plan.tp2.toFixed(4)}</div>
                  </div>
                  <div>
                    <div className="text-gray-500 text-xs">止损</div>
                    <div className="text-down font-mono text-xs">{snapshot.plan.sl.toFixed(4)}</div>
                  </div>
                  <div>
                    <div className="text-gray-500 text-xs">盈亏比</div>
                    <div className="text-gold font-mono text-xs">{snapshot.plan.rrRatio.toFixed(2)}</div>
                  </div>
                </div>
              ) : (
                <div className="text-gray-300 text-sm">
                  <div className="text-white font-medium mb-2">当前动作：观望</div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <div className="text-up text-xs mb-1">触发做多</div>
                      <ul className="text-xs text-gray-400 list-disc list-inside space-y-1">
                        <li>价格站稳 {max(snapshot.support)?.toFixed(4)} 以上</li>
                        <li>RSI 未进入超买区</li>
                        <li>MACD 出现金叉</li>
                      </ul>
                    </div>
                    <div>
                      <div className="text-down text-xs mb-1">触发做空</div>
                      <ul className="text-xs text-gray-400 list-disc list-inside space-y-1">
                        <li>价格跌破 {min(snapshot.support)?.toFixed(4)}</li>
                        <li>成交量放大</li>
                        <li>多空比开始下降</li>
                      </ul>
                    </div>
                  </div>
                  <div className="mt-3 text-xs text-gray-500">
                    失效条件：价格突破 {max(snapshot.resistance)?.toFixed(4)} → 空头逻辑失效；价格跌破 {(min(snapshot.support) ?? 0).toFixed(4)} → 多头逻辑失效
                  </div>
                </div>
              )}
            </div>

            <div className="mt-4 pt-4 border-t border-cardborder text-sm">
              <div className="text-gray-500 text-xs mb-1">核心判断</div>
              <div className="text-gray-300">
                {snapshot.plan
                  ? `${symbol} 当前已有可执行计划，执行时以进场区、止损与目标位的条件确认为主。`
                  : `${symbol} 正处于 ${min(snapshot.support)?.toFixed(4)}-${max(snapshot.support)?.toFixed(4)} 关键支撑的防御战中。多头拥挤或资金费率变化可能先于价格变化，若 ${min(snapshot.support)?.toFixed(4)} 失守，风险会放大；若守住，可能进入震荡整理。`}
              </div>
            </div>
          </div>
        )}

        <div className="bg-card border border-cardborder rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-white font-semibold">AI 策略分析</h2>
            <button
              onClick={generateAi}
              disabled={regenDisabled || aiLoading || !ticker || !snapshot}
              className="px-3 py-1 text-xs bg-gold text-black rounded disabled:opacity-40 hover:brightness-110"
            >
              {aiLoading ? '生成中…' : regenDisabled ? '冷却中' : '重新生成'}
            </button>
          </div>
          {ai ? (
            <div className="text-sm">
              <div className="max-w-none whitespace-pre-wrap text-text">{ai.summary}</div>
              <div className="mt-3 pt-3 border-t border-cardborder text-xs text-gray-500">
                <div>
                  模型: {ai.model} · 生成时间:{' '}
                  {new Date(ai.generatedAt).toLocaleString()}
                </div>
                <div className="mt-1 text-warn">{AI_DISCLAIMER}</div>
              </div>
            </div>
          ) : (
            <div className="text-gray-500 text-sm">
              {aiLoading ? 'AI 策略生成中…' : '加载 AI 策略中…'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
