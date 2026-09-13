import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { TickerDto, AlertSnapshotDto, IndicatorSnapshotDto } from '@crypto-monitor/shared';
import { RSI_OVERBOUGHT, RSI_OVERSOLD, LONG_SHORT_RATIO_HIGH, LONG_SHORT_RATIO_LOW } from '@crypto-monitor/shared';
import { hasAlert } from '../../lib/alert';

interface Props {
  symbol: string;
  ticker?: TickerDto;
  alert?: AlertSnapshotDto;
  snapshot?: IndicatorSnapshotDto;
  flash?: 'up' | 'down' | null;
  onRemove: (symbol: string) => void;
}

function fmtPct(v: number): string {
  return `${v.toFixed(4)}%`;
}

function fmtRatio(v: number): string {
  return v.toFixed(2);
}

function fundingMeaning(rate: number): { text: string; tone: 'neutral' | 'warn' | 'danger' | 'good' } {
  if (Math.abs(rate) < 0.0001) return { text: '动能衰竭', tone: 'warn' };
  if (rate > 0.0005) return { text: '多头溢价强', tone: 'danger' };
  if (rate < -0.0005) return { text: '空头溢价强', tone: 'danger' };
  if (rate > 0) return { text: '多头占优', tone: 'neutral' };
  return { text: '空头占优', tone: 'neutral' };
}

function sentimentLine(rate: number, ratio: number): { text: string; tone: 'neutral' | 'warn' | 'danger' } {
  const longCrowded = ratio > LONG_SHORT_RATIO_HIGH || rate > 0.0005;
  const shortCrowded = ratio < LONG_SHORT_RATIO_LOW || rate < -0.0005;
  if (longCrowded && ratio > 2.2) return { text: '多头极度拥挤', tone: 'danger' };
  if (longCrowded) return { text: '多头拥挤', tone: 'warn' };
  if (shortCrowded && ratio < 0.45) return { text: '空头极度拥挤', tone: 'danger' };
  if (shortCrowded) return { text: '空头拥挤', tone: 'warn' };
  return { text: '仓位均衡', tone: 'neutral' };
}

function volumePriceLine(divergence: AlertSnapshotDto['volumePriceDivergence'], volumeRatio: number, changePct: number): {
  text: string;
  tone: 'neutral' | 'warn';
} {
  const ratioLabel =
    volumeRatio < 0.5
      ? '地量'
      : volumeRatio < 0.8
        ? '缩量'
        : volumeRatio <= 1.2
          ? '平量'
          : '放量';

  const data = `量比${volumeRatio.toFixed(2)} · 20期${changePct >= 0 ? '+' : ''}${changePct.toFixed(1)}%`;

  if (divergence === 'BEARISH_DIVERGENCE') {
    return { text: `价涨量缩 · ${data}`, tone: 'warn' };
  }
  if (divergence === 'BULLISH_DIVERGENCE') {
    return { text: `价跌量增 · ${data}`, tone: 'warn' };
  }
  if (ratioLabel === '地量') {
    return { text: `地量 · ${data}`, tone: 'warn' };
  }
  if (ratioLabel === '缩量') {
    return { text: `缩量 · ${data}`, tone: 'warn' };
  }
  if (ratioLabel === '放量') {
    return { text: `放量 · ${data}`, tone: 'warn' };
  }
  return { text: `平量 · ${data}`, tone: 'neutral' };
}

function tfLine(conflict: boolean): { text: string; tone: 'neutral' | 'warn' } {
  if (conflict) return { text: '15m≠1h，未共振', tone: 'warn' };
  return { text: '多周期一致', tone: 'neutral' };
}

function rsiLine(rsi: number): { text: string; tone: 'neutral' | 'warn' | 'danger' } {
  if (rsi >= RSI_OVERBOUGHT) return { text: `RSI ${rsi.toFixed(1)} · 超买`, tone: 'danger' };
  if (rsi <= RSI_OVERSOLD) return { text: `RSI ${rsi.toFixed(1)} · 超卖`, tone: 'danger' };
  return { text: `RSI ${rsi.toFixed(1)} · 中性`, tone: 'neutral' };
}

export function MonitorCard({ symbol, ticker, alert, snapshot, flash, onRemove }: Props) {
  const navigate = useNavigate();
  const [confirmRemove, setConfirmRemove] = useState(false);

  const alertActive = alert ? hasAlert(alert) : false;
  const insufficient = alert?.dataQuality === 'INSUFFICIENT';

  const changePct = ticker ? (ticker.change24h * 100).toFixed(2) : '--';
  const changePositive = (ticker?.change24h ?? 0) >= 0;

  const funding = alert ? fundingMeaning(alert.fundingRate) : { text: '--', tone: 'neutral' as const };
  const sentiment = alert ? sentimentLine(alert.fundingRate, alert.longShortRatio) : { text: '--', tone: 'neutral' as const };
  const volumePrice = alert ? volumePriceLine(alert.volumePriceDivergence, snapshot?.obv.volumeRatio ?? 1, snapshot?.obv.volumeAvg20ChangePct ?? 0) : { text: '--', tone: 'neutral' as const };
  const tf = alert ? tfLine(alert.multiTfConflict) : { text: '--', tone: 'neutral' as const };
  const rsi = alert ? rsiLine(snapshot?.rsi14 ?? (alert.extremeAlert === 'OVERBOUGHT' ? RSI_OVERBOUGHT + 1 : alert.extremeAlert === 'OVERSOLD' ? RSI_OVERSOLD - 1 : 50)) : { text: 'RSI --', tone: 'neutral' as const };

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
                : 'text-text'
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
        <span>资金费率 {alert ? fmtPct(alert.fundingRate) : '--'}</span>
        <span>多空比 {alert ? fmtRatio(alert.longShortRatio) : '--'}</span>
      </div>

      <div className={`text-xs ${toneClass(funding.tone)}`}>
        资金费率含义: {funding.text}
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