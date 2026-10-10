import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { TickerDto, AlertSnapshotDto, IndicatorSnapshotDto, FundingRateDto } from '@crypto-monitor/shared';
import { fmtPrice } from '@crypto-monitor/shared';
import { hasAlert } from '../../lib/alert';
import { rsiLine, sentimentLine, tfLine, volumePriceLine } from '../../lib/cardText';
import { useWatchlistStore } from '../../store/watchlist';

interface Props {
  symbol: string;
  ticker?: TickerDto;
  alert?: AlertSnapshotDto;
  snapshot?: IndicatorSnapshotDto;
  funding?: FundingRateDto;
  flash?: 'up' | 'down' | null;
  onRemove: (symbol: string) => void;
}

function fmtPct(v: number): string {
  return `${(v * 100).toFixed(4)}%`;
}

function fmtRatio(v: number): string {
  return v.toFixed(2);
}

export function MonitorCard({ symbol, ticker, alert, snapshot, funding, flash, onRemove }: Props) {
  const navigate = useNavigate();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const storeFunding = useWatchlistStore((s) => s.funding[symbol]);
  const fundingValue = funding ?? storeFunding;

  const alertActive = alert ? hasAlert(alert) : false;
  const insufficient = alert?.dataQuality === 'INSUFFICIENT';

  const changePct = ticker ? (ticker.change24h * 100).toFixed(2) : '--';
  const changePositive = (ticker?.change24h ?? 0) >= 0;

  const sentiment = alert
    ? sentimentLine(alert.fundingSignal, alert.fundingRate, alert.longShortRatio)
    : { text: '--', tone: 'neutral' as const };
  // 量比的涨跌判断必须用**价格**涨跌幅，不能用成交量变化（volumeAvg20ChangePct）冒充
  const volumePrice = alert
    ? volumePriceLine(alert.volumePriceDivergence, snapshot?.obv.volumeRatio ?? 0, ticker?.change24h ?? 0)
    : { text: '--', tone: 'neutral' as const };
  const tf = alert ? tfLine(alert.multiTfState, alert.multiTfConflict) : { text: '--', tone: 'neutral' as const };
  // 指标快照未就绪时只显示状态，绝不编造一个 RSI 数值
  const rsi = !alert
    ? { text: 'RSI --', tone: 'neutral' as const }
    : snapshot
      ? rsiLine(snapshot.rsi14)
      : alert.extremeAlert === 'OVERBOUGHT'
        ? { text: 'RSI · 超买', tone: 'danger' as const }
        : alert.extremeAlert === 'OVERSOLD'
          ? { text: 'RSI · 超卖', tone: 'good' as const }
          : { text: 'RSI --', tone: 'neutral' as const };

  const toneClass = (tone: 'neutral' | 'warn' | 'danger' | 'good') =>
    tone === 'danger'
      ? 'text-down'
      : tone === 'warn'
        ? 'text-warn'
        : tone === 'good'
          ? 'text-up'
          : 'text-gray-400';

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
          {ticker ? fmtPrice(ticker.last) : '--'}
        </span>
        <span className={changePositive ? 'text-up' : 'text-down'}>
          {changePositive ? '+' : ''}
          {changePct}%
        </span>
      </div>

      <div className="text-gray-400 text-xs flex gap-3">
        <span>资金费率 {fundingValue ? fmtPct(fundingValue.fundingRate) : '--'}</span>
        <span>多空比 {alert ? fmtRatio(alert.longShortRatio) : '--'}</span>
      </div>

      <div className={toneClass(sentiment.tone)}>
        情绪: {sentiment.text} {sentiment.tone !== 'neutral' ? '⚠' : ''}
      </div>

      <div className={toneClass(volumePrice.tone)}>
        量价: {volumePrice.text} {volumePrice.tone !== 'neutral' ? '⚠' : ''}
      </div>

      <div className={toneClass(tf.tone)}>
        多周期: {tf.text} {tf.tone !== 'neutral' ? '⚠' : ''}
      </div>

      <div className={toneClass(rsi.tone)}>
        {rsi.text} {rsi.tone !== 'neutral' ? '⚠' : ''}
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