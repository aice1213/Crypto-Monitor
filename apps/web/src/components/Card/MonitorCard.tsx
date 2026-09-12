import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { TickerDto, AlertSnapshotDto } from '@crypto-monitor/shared';
import { hasAlert } from '../../lib/alert';

interface Props {
  symbol: string;
  ticker?: TickerDto;
  alert?: AlertSnapshotDto;
  flash?: 'up' | 'down' | null;
  onRemove: (symbol: string) => void;
}

export function MonitorCard({ symbol, ticker, alert, flash, onRemove }: Props) {
  const navigate = useNavigate();
  const [confirmRemove, setConfirmRemove] = useState(false);

  const alertActive = alert ? hasAlert(alert) : false;
  const insufficient = alert?.dataQuality === 'INSUFFICIENT';

  const changePct = ticker ? (ticker.change24h * 100).toFixed(2) : '--';
  const changePositive = (ticker?.change24h ?? 0) >= 0;

  const sentimentText =
    alert?.fundingSignal === 'LONG_HEAVY'
      ? '多头拥挤，谨慎追高'
      : alert?.fundingSignal === 'SHORT_HEAVY'
        ? '空头拥挤，谨慎杀跌'
        : '情绪正常';

  const divergenceText =
    alert?.volumePriceDivergence === 'BEARISH_DIVERGENCE'
      ? '价涨量缩，顶背离警示'
      : alert?.volumePriceDivergence === 'BULLISH_DIVERGENCE'
        ? '价跌量增，底背离信号'
        : '量价正常';

  const tfText = alert?.multiTfConflict ? '15m vs 1h 方向冲突' : '多周期方向一致';

  const rsiText = alert
    ? alert.extremeAlert === 'OVERBOUGHT'
      ? 'RSI 超买'
      : alert.extremeAlert === 'OVERSOLD'
        ? 'RSI 超卖'
        : 'RSI 正常'
    : 'RSI --';

  return (
    <div className="bg-card border border-cardborder rounded-lg p-3 flex flex-col gap-1.5 text-sm relative">
      {alert?.dataQuality === 'GAPS_FILLED' && (
        <span
          className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-gray-500"
          title="数据有缺口已填充"
        />
      )}

      <div className="flex items-center justify-between">
        <span className="font-bold text-white text-base">{symbol}</span>
        <span
          className={`px-2 py-0.5 rounded text-xs font-medium ${
            alertActive ? 'bg-warn-bg text-warn' : 'bg-gray-700 text-gray-400'
          }`}
        >
          {alertActive ? '⚠ 预警' : '平稳'}
        </span>
      </div>

      <div className="flex items-baseline justify-between">
        <span
          className={`text-xl font-mono font-semibold ${
            flash === 'up'
              ? 'flash-up text-up-bright'
              : flash === 'down'
                ? 'flash-down text-down-bright'
                : 'text-white'
          }`}
        >
          {ticker
            ? ticker.last.toLocaleString(undefined, { maximumFractionDigits: 2 })
            : '--'}
        </span>
        <span className={changePositive ? 'text-up' : 'text-down'}>
          {changePositive ? '+' : ''}
          {changePct}%
        </span>
      </div>

      <div className="text-gray-400 text-xs flex gap-3">
        <span>资金费率 {(alert?.fundingRate ?? 0).toFixed(4)}%</span>
        <span>多空比 {(alert?.longShortRatio ?? 1).toFixed(2)}</span>
      </div>

      <div
        className={`text-xs ${
          alert?.fundingSignal && alert.fundingSignal !== 'NEUTRAL'
            ? 'text-warn'
            : 'text-gray-400'
        }`}
      >
        情绪: {sentimentText} {alert?.fundingSignal !== 'NEUTRAL' ? '⚠' : ''}
      </div>

      <div
        className={`text-xs ${
          alert?.volumePriceDivergence && alert.volumePriceDivergence !== 'NONE'
            ? 'text-warn'
            : 'text-gray-400'
        }`}
      >
        量价: {divergenceText} {alert?.volumePriceDivergence !== 'NONE' ? '⚠' : ''}
      </div>

      <div
        className={`text-xs ${
          alert?.multiTfConflict ? 'text-warn' : 'text-gray-400'
        }`}
      >
        多周期: {tfText} {alert?.multiTfConflict ? '⚠' : ''}
      </div>

      <div
        className={`text-xs ${
          alert?.extremeAlert === 'OVERBOUGHT'
            ? 'text-down'
            : alert?.extremeAlert === 'OVERSOLD'
              ? 'text-up'
              : 'text-gray-400'
        }`}
      >
        {rsiText} {alert?.extremeAlert ? '⚠' : ''}
      </div>

      {insufficient && <div className="text-xs text-gray-500 italic">数据积累中…</div>}

      <div className="flex justify-end gap-2 mt-1">
        {confirmRemove ? (
          <>
            <button
              onClick={() => {
                onRemove(symbol);
                setConfirmRemove(false);
              }}
              className="px-2 py-0.5 text-xs border border-down text-down rounded hover:bg-down/10"
            >
              确认移除
            </button>
            <button
              onClick={() => setConfirmRemove(false)}
              className="px-2 py-0.5 text-xs border border-gray-600 text-gray-400 rounded hover:bg-gray-700"
            >
              取消
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => setConfirmRemove(true)}
              className="px-2 py-0.5 text-xs border border-gold/60 text-gold rounded hover:bg-gold/10"
            >
              移除
            </button>
            <button
              onClick={() => navigate(`/detail?symbol=${symbol}`)}
              className="px-2 py-0.5 text-xs border border-gold/60 text-gold rounded hover:bg-gold/10"
            >
              详情
            </button>
          </>
        )}
      </div>
    </div>
  );
}
