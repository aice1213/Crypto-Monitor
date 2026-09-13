import { useEffect, useRef } from 'react';
import {
  createChart,
  type Time,
  ColorType,
  CrosshairMode,
  type IChartApi,
  type IPriceLine,
} from 'lightweight-charts';
import type { CandleDto, IndicatorSnapshotDto } from '@crypto-monitor/shared';
import { ema } from '@crypto-monitor/indicators';

interface Props {
  candles: CandleDto[];
  snapshot: IndicatorSnapshotDto;
}

type ChartRef = {
  chart: IChartApi;
  candleSeries: ReturnType<IChartApi['addCandlestickSeries']>;
  ema7: ReturnType<IChartApi['addLineSeries']>;
  ema25: ReturnType<IChartApi['addLineSeries']>;
  ema99: ReturnType<IChartApi['addLineSeries']>;
  macdHist: ReturnType<IChartApi['addHistogramSeries']>;
  dif: ReturnType<IChartApi['addLineSeries']>;
  dea: ReturnType<IChartApi['addLineSeries']>;
  priceLines: IPriceLine[];
};

export function KlineChart({ candles, snapshot }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ChartRef | null>(null);
  const fitOnceRef = useRef(false);

  useEffect(() => {
    if (!containerRef.current) return;

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

    const ema7 = chart.addLineSeries({ color: '#ffb300', lineWidth: 1 });
    const ema25 = chart.addLineSeries({ color: '#29b6f6', lineWidth: 1 });
    const ema99 = chart.addLineSeries({ color: '#ab47bc', lineWidth: 1 });

    const macdHist = chart.addHistogramSeries({ priceScaleId: 'macd' });
    chart.priceScale('macd').applyOptions({
      scaleMargins: { top: 0.7, bottom: 0.05 },
    });
    const dif = chart.addLineSeries({ color: '#29b6f6', lineWidth: 1, priceScaleId: 'macd' });
    const dea = chart.addLineSeries({ color: '#ffb300', lineWidth: 1, priceScaleId: 'macd' });

    chartRef.current = {
      chart,
      candleSeries,
      ema7,
      ema25,
      ema99,
      macdHist,
      dif,
      dea,
      priceLines: [],
    };

    const handleResize = () => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth });
      }
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      chart.remove();
      chartRef.current = null;
    };
  }, []);


  useEffect(() => {
    const ref = chartRef.current;
    if (!ref || candles.length === 0) return;

    const closes = candles.map((c) => c.close);
    const ema7Arr = ema(closes, 7);
    const ema25Arr = ema(closes, 25);
    const ema99Arr = ema(closes, 99);
    const ema12 = ema(closes, 12);
    const ema26 = ema(closes, 26);
    const difArr = closes.map((_, i) =>
      !Number.isNaN(ema12[i]) && !Number.isNaN(ema26[i]) ? ema12[i] - ema26[i] : NaN,
    );
    const validStart = difArr.findIndex((v) => !Number.isNaN(v));
    const validDif = difArr.filter((v) => !Number.isNaN(v));
    const deaArr = ema(validDif, 9);
    const dea = new Array<number>(closes.length).fill(NaN);
    let di = 0;
    for (let i = validStart; i < closes.length; i++) {
      if (!Number.isNaN(difArr[i])) dea[i] = deaArr[di++];
    }

    ref.candleSeries.setData(
      candles.map((c) => ({
        time: c.time as Time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );

    ref.ema7.setData(
      candles.map((c, i) => ({ time: c.time as Time, value: ema7Arr[i] })).filter((d) => !Number.isNaN(d.value)),
    );
    ref.ema25.setData(
      candles.map((c, i) => ({ time: c.time as Time, value: ema25Arr[i] })).filter((d) => !Number.isNaN(d.value)),
    );
    ref.ema99.setData(
      candles.map((c, i) => ({ time: c.time as Time, value: ema99Arr[i] })).filter((d) => !Number.isNaN(d.value)),
    );

    ref.macdHist.setData(
      candles
        .map((c, i) => {
          const h = !Number.isNaN(difArr[i]) && !Number.isNaN(dea[i]) ? (difArr[i] - dea[i]) * 2 : 0;
          return { time: c.time as Time, value: h, color: h >= 0 ? '#26a69a' : '#ef5350' };
        })
        .filter((d) => !Number.isNaN(d.value)),
    );

    ref.dif.setData(
      candles.map((c, i) => ({ time: c.time as Time, value: difArr[i] })).filter((d) => !Number.isNaN(d.value)),
    );
    ref.dea.setData(
      candles.map((c, i) => ({ time: c.time as Time, value: dea[i] })).filter((d) => !Number.isNaN(d.value)),
    );

    ref.priceLines.forEach((line) => ref.candleSeries.removePriceLine(line));
    ref.priceLines = [];

    snapshot.resistance.forEach((price) => {
      ref.priceLines.push(
        ref.candleSeries.createPriceLine({
          price,
          color: '#ef5350',
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: 'R',
        }),
      );
    });

    snapshot.support.forEach((price) => {
      ref.priceLines.push(
        ref.candleSeries.createPriceLine({
          price,
          color: '#26a69a',
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: 'S',
        }),
      );
    });

    if (!fitOnceRef.current) {
      ref.chart.timeScale().fitContent();
      fitOnceRef.current = true;
    }
  }, [candles, snapshot]);

  return <div ref={containerRef} className="w-full" />;
}
