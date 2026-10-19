import { useEffect, useRef } from 'react';
import {
  createChart,
  type Time,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesPrimitive,
  type ISeriesPrimitivePaneView,
  type SeriesType,
} from 'lightweight-charts';
import type { CandleDto, IndicatorSnapshotDto } from '@crypto-monitor/shared';
import { fmtPrice, formatBeijingShort } from '@crypto-monitor/shared';
import {
  buildEmaSeries,
  buildEntryBand,
  buildMacdPane,
  buildPatternMarkers,
  buildPlanLevels,
  type EntryBand,
} from './chartData';

/** 图表坐标轴：统一走 shared 的北京时间短格式（原先图内自写一套偏移） */
function formatAxisTime(time: Time): string {
  const ts = typeof time === 'number' ? time : Number(time as unknown as number);
  return formatBeijingShort(ts);
}

/**
 * 进场区阴影。
 *
 * lightweight-charts v4 没有内置矩形图元，半透明矩形要用 series primitive 画：
 * 通过 attached() 拿到 series，再用 priceToCoordinate() 把两个价位换成 y 坐标，
 * 在 bitmap 坐标空间里填充整幅宽度的矩形。
 */
function createEntryBandPrimitive(getBand: () => EntryBand | null): ISeriesPrimitive<Time> {
  let series: ISeriesApi<SeriesType, Time> | null = null;

  const paneView: ISeriesPrimitivePaneView = {
    // 画在 K 线之下，避免遮住蜡烛
    zOrder: () => 'bottom',
    renderer: () => ({
      draw: (target) => {
        const band = getBand();
        if (!band || !series) return;
        const yHigh = series.priceToCoordinate(band.high);
        const yLow = series.priceToCoordinate(band.low);
        if (yHigh == null || yLow == null) return;

        target.useBitmapCoordinateSpace((scope) => {
          const { context: ctx, bitmapSize, verticalPixelRatio } = scope;
          const top = Math.min(yHigh, yLow) * verticalPixelRatio;
          const bottom = Math.max(yHigh, yLow) * verticalPixelRatio;
          ctx.fillStyle = band.color;
          ctx.fillRect(0, top, bitmapSize.width, Math.max(bottom - top, 1));
        });
      },
    }),
  };

  return {
    attached: (param) => {
      series = param.series as ISeriesApi<SeriesType, Time>;
    },
    detached: () => {
      series = null;
    },
    paneViews: () => [paneView],
  };
}

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

/** 主图约占顶部 60%，下方 MACD 副图约占底部 30%，保留间距。 */
const PANE_MARGINS = {
  main: { top: 0.02, bottom: 0.36 },
  macd: { top: 0.66, bottom: 0.02 },
} as const;

const CHART_HEIGHT = 460;

export function KlineChart({ candles, snapshot }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ChartRef | null>(null);
  const fitOnceRef = useRef(false);
  const bandRef = useRef<EntryBand | null>(null);

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
      timeScale: {
        borderColor: '#2a2a2a',
        timeVisible: true,
        tickMarkFormatter: (time: Time) => formatAxisTime(time),
      },
      localization: {
        priceFormatter: (price: number) => fmtPrice(price),
        timeFormatter: (time: Time) => formatAxisTime(time),
      },
      width: containerRef.current.clientWidth,
      height: CHART_HEIGHT,
    });

    chart.priceScale('right').applyOptions({ scaleMargins: PANE_MARGINS.main });

    const candleSeries = chart.addCandlestickSeries({
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderUpColor: '#26a69a',
      borderDownColor: '#ef5350',
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350',
    });

    const ema7 = chart.addLineSeries({ color: '#ffb300', lineWidth: 1, lastValueVisible: false, priceLineVisible: false });
    const ema25 = chart.addLineSeries({ color: '#29b6f6', lineWidth: 1, lastValueVisible: false, priceLineVisible: false });
    const ema99 = chart.addLineSeries({ color: '#ab47bc', lineWidth: 1, lastValueVisible: false, priceLineVisible: false });

    // ---- MACD 副图 ----
    // 顺序很重要：必须先由 series 以该 priceScaleId 创建出刻度，才能对其 applyOptions，
    // 否则 lightweight-charts 会抛 "Trying to apply price scale options with incorrect ID"
    // 并导致整张图空白（本次修复中真实踩到，只有真实渲染验证能发现）。
    const macdHist = chart.addHistogramSeries({ priceScaleId: 'macd', lastValueVisible: false, priceLineVisible: false });
    const dif = chart.addLineSeries({ color: '#29b6f6', lineWidth: 1, priceScaleId: 'macd', lastValueVisible: false, priceLineVisible: false });
    const dea = chart.addLineSeries({ color: '#ffb300', lineWidth: 1, priceScaleId: 'macd', lastValueVisible: false, priceLineVisible: false });
    chart.priceScale('macd').applyOptions({ scaleMargins: PANE_MARGINS.macd });

    // 进场区阴影挂在主图的蜡烛序列上
    candleSeries.attachPrimitive(createEntryBandPrimitive(() => bandRef.current));

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

    const toTime = (t: number) => t as Time;

    ref.candleSeries.setData(
      candles.map((c) => ({
        time: toTime(c.time),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );

    ref.ema7.setData(buildEmaSeries(candles, 7).map((p) => ({ time: toTime(p.time), value: p.value })));
    ref.ema25.setData(buildEmaSeries(candles, 25).map((p) => ({ time: toTime(p.time), value: p.value })));
    ref.ema99.setData(buildEmaSeries(candles, 99).map((p) => ({ time: toTime(p.time), value: p.value })));

    const macdPane = buildMacdPane(candles);
    ref.macdHist.setData(macdPane.hist.map((p) => ({ time: toTime(p.time), value: p.value, color: p.color })));
    ref.dif.setData(macdPane.dif.map((p) => ({ time: toTime(p.time), value: p.value })));
    ref.dea.setData(macdPane.dea.map((p) => ({ time: toTime(p.time), value: p.value })));

    // 进场区阴影：先更新数据再重绘
    bandRef.current = buildEntryBand(snapshot.plan);

    // 形态标记：看涨在蜡烛下方朝上，看跌在蜡烛上方朝下
    ref.candleSeries.setMarkers(buildPatternMarkers(snapshot.patterns, candles));

    // ---- 主图价位线：支撑 / 阻力 / 计划价位 ----
    ref.priceLines.forEach((line) => ref.candleSeries.removePriceLine(line));
    ref.priceLines = [];

    const addLine = (price: number, title: string, color: string, lineStyle: LineStyle) => {
      ref.priceLines.push(
        ref.candleSeries.createPriceLine({
          price,
          color,
          lineWidth: 1,
          lineStyle,
          axisLabelVisible: true,
          title,
        }),
      );
    };

    snapshot.resistance.forEach((price) => addLine(price, 'R', '#ef5350', LineStyle.Dashed));
    snapshot.support.forEach((price) => addLine(price, 'S', '#26a69a', LineStyle.Dashed));

    // 计划价位只在引擎给出 plan 时绘制（plan = null 时不得凭空画线）
    buildPlanLevels(snapshot.plan).forEach((l) =>
      addLine(l.price, l.title, l.color, l.lineStyle as LineStyle),
    );

    if (!fitOnceRef.current) {
      ref.chart.timeScale().fitContent();
      fitOnceRef.current = true;
    }
  }, [candles, snapshot]);

  return <div ref={containerRef} className="w-full" />;
}
