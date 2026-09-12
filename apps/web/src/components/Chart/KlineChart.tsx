import { useEffect, useRef } from 'react';
import {
  createChart,
  type Time,
  ColorType,
  CrosshairMode,
} from 'lightweight-charts';
import type { CandleDto, IndicatorSnapshotDto } from '@crypto-monitor/shared';
import { ema } from '@crypto-monitor/indicators';

interface Props {
  candles: CandleDto[];
  snapshot: IndicatorSnapshotDto;
}

export function KlineChart({ candles, snapshot }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current || candles.length === 0) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#1e1e1e' },
        textColor: '#A8E6CF',
      },
      grid: {
        vertLines: { color: '#2a2a2a' },
        horzLines: { color: '#2a2a2a' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#2a2a2a' },
      timeScale: { borderColor: '#2a2a2a', timeVisible: true },
      width: containerRef.current.clientWidth,
      height: 460,
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderUpColor: '#26a69a',
      borderDownColor: '#ef5350',
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350',
    });

    candleSeries.setData(
      candles.map((c) => ({
        time: c.time as Time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );

    const closes = candles.map((c) => c.close);
    const addEma = (period: number, color: string) => {
      const e = ema(closes, period);
      const line = chart.addLineSeries({ color, lineWidth: 1 });
      line.setData(
        candles
          .map((c, i) => ({ time: c.time as Time, value: e[i] }))
          .filter((d) => !Number.isNaN(d.value)),
      );
    };
    addEma(7, '#ffb300');
    addEma(25, '#29b6f6');
    addEma(99, '#ab47bc');

    snapshot.resistance.forEach((price) => {
      candleSeries.createPriceLine({
        price,
        color: '#ef5350',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: 'R',
      });
    });
    snapshot.support.forEach((price) => {
      candleSeries.createPriceLine({
        price,
        color: '#26a69a',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: 'S',
      });
    });

    // MACD pane
    chart.priceScale('macd').applyOptions({
      scaleMargins: { top: 0.7, bottom: 0.05 },
    });
    const ema12 = ema(closes, 12);
    const ema26 = ema(closes, 26);
    const dif = closes.map((_, i) =>
      !Number.isNaN(ema12[i]) && !Number.isNaN(ema26[i]) ? ema12[i] - ema26[i] : NaN,
    );
    const validStart = dif.findIndex((v) => !Number.isNaN(v));
    const validDif = dif.filter((v) => !Number.isNaN(v));
    const deaArr = ema(validDif, 9);
    const dea: number[] = new Array(closes.length).fill(NaN);
    let di = 0;
    for (let i = validStart; i < closes.length; i++) {
      if (!Number.isNaN(dif[i])) dea[i] = deaArr[di++];
    }

    const macdHist = chart.addHistogramSeries({ priceScaleId: 'macd' });
    macdHist.setData(
      candles
        .map((c, i) => {
          const h =
            !Number.isNaN(dif[i]) && !Number.isNaN(dea[i]) ? (dif[i] - dea[i]) * 2 : 0;
          return { time: c.time as Time, value: h, color: h >= 0 ? '#26a69a' : '#ef5350' };
        })
        .filter((d) => !Number.isNaN(d.value)),
    );

    const difLine = chart.addLineSeries({ color: '#29b6f6', lineWidth: 1, priceScaleId: 'macd' });
    difLine.setData(
      candles
        .map((c, i) => ({ time: c.time as Time, value: dif[i] }))
        .filter((d) => !Number.isNaN(d.value)),
    );
    const deaLine = chart.addLineSeries({ color: '#ffb300', lineWidth: 1, priceScaleId: 'macd' });
    deaLine.setData(
      candles
        .map((c, i) => ({ time: c.time as Time, value: dea[i] }))
        .filter((d) => !Number.isNaN(d.value)),
    );

    chart.timeScale().fitContent();

    const handleResize = () => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth });
      }
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      chart.remove();
    };
  }, [candles, snapshot]);

  return <div ref={containerRef} className="w-full" />;
}
