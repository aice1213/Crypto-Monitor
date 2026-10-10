import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  MACRO_EVENT_CATEGORY_LABEL,
  LIQUIDITY_EXPANSION_THRESHOLD,
  LIQUIDITY_CONTRACTION_THRESHOLD,
  formatBeijingFromIso,
} from '@crypto-monitor/shared';
import type {
  FomcSnapshot,
  MacroCalendarData,
  MacroFundingData,
  LiquidationHeatmap,
  LiquidityData,
} from '@crypto-monitor/shared';
import { api } from '../../lib/api';
import { usePolling } from '../../hooks/usePolling';

/* ========== 工具函数 ========== */

function fmtCountdown(ms: number): string {
  if (ms < 0) return '已结束';
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  if (days > 0) return `${days}天 ${hours}小时`;
  if (hours > 0) return `${hours}小时 ${mins}分`;
  return `${mins}分钟`;
}

function fmtPct(v: number): string {
  return `${(v * 100).toFixed(4)}%`;
}

function fmtAnnualized(v: number): string {
  return `${(v * 100).toFixed(2)}%`;
}

// 统一使用 shared 的固定偏移实现（原实现用 toLocaleString + Asia/Shanghai，
// 与详情页手写的 UTC+8、图表坐标轴各成一套，口径不一致）
const fmtTime = formatBeijingFromIso;

function urgencyColor(u: string): string {
  if (u === 'RED') return 'text-down';
  if (u === 'YELLOW') return 'text-warn';
  return 'text-gray-500';
}

function levelBadge(level: string): string {
  if (level === 'S') return 'bg-down/20 text-down';
  if (level === 'A') return 'bg-warn/20 text-warn';
  return 'bg-gray-700 text-gray-400';
}

/* ========== 面板 1：FOMC 倒计时 ========== */

function FomcPanel({ data }: { data: FomcSnapshot | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!data) return <PanelLoading title="FOMC 利率决议" />;

  const meetingTime = new Date(data.nextMeeting).getTime();
  const countdown = fmtCountdown(meetingTime - now);
  const topProb = [...data.probabilities].sort((a, b) => b.probability - a.probability)[0];

  return (
    <div className="bg-card border border-cardborder rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-white font-semibold">FOMC 利率决议</h2>
        <span className="text-xs text-gray-500">{data.meetingName}</span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <div>
          <div className="text-gray-500 text-xs">距离决议</div>
          <div className="text-gold text-lg font-mono font-bold">{countdown}</div>
        </div>
        <div>
          <div className="text-gray-500 text-xs">当前利率</div>
          <div className="text-white font-mono">
            {data.currentRateFloor.toFixed(2)}–{data.currentRateCeil.toFixed(2)}%
          </div>
        </div>
        <div>
          <div className="text-gray-500 text-xs">上次决议</div>
          <div
            className={
              data.lastDecision === 'CUT'
                ? 'text-up'
                : data.lastDecision === 'HIKE'
                  ? 'text-down'
                  : 'text-white'
            }
          >
            {data.lastDecision === 'CUT' ? '降息' : data.lastDecision === 'HIKE' ? '加息' : '按兵不动'}
            {data.lastDecisionBps !== 0 && ` ${data.lastDecisionBps > 0 ? '+' : ''}${data.lastDecisionBps}bp`}
          </div>
        </div>
        <div>
          <div className="text-gray-500 text-xs">最高概率区间</div>
          <div className="text-white font-mono">
            {topProb.rateFloor.toFixed(2)}–{topProb.rateCeil.toFixed(2)}% ({topProb.probability}%)
          </div>
        </div>
      </div>

      <div className="text-gray-500 text-xs mb-1">利率概率分布</div>
      <div className="flex gap-1 h-6 rounded overflow-hidden">
        {data.probabilities.map((p, i) => (
          <div
            key={i}
            className="h-full flex items-center justify-center text-[10px] text-white/80 font-mono"
            style={{
              width: `${p.probability}%`,
              backgroundColor:
                p.probability === topProb.probability ? '#c9a227' : `rgba(168,230,207,${0.3 + (p.probability / 100) * 0.5})`,
            }}
            title={`${p.rateFloor.toFixed(2)}–${p.rateCeil.toFixed(2)}%: ${p.probability}%`}
          >
            {p.probability >= 15 ? `${p.probability}%` : ''}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[10px] text-gray-500">
        {data.probabilities.map((p, i) => (
          <span key={i}>
            {p.rateFloor.toFixed(2)}–{p.rateCeil.toFixed(2)}%
          </span>
        ))}
      </div>

      <div className="mt-3 text-[10px] text-gray-600">{data.source}</div>
    </div>
  );
}

/* ========== 面板 2：14天宏观日历 ========== */

function CalendarPanel({ data }: { data: MacroCalendarData | null }) {
  if (!data) return <PanelLoading title="14天宏观日历" />;

  return (
    <div className="bg-card border border-cardborder rounded-lg p-4">
      <h2 className="text-white font-semibold mb-3">14天宏观日历</h2>
      {data.events.length === 0 ? (
        <div className="text-gray-500 text-sm py-4 text-center">暂无近期事件</div>
      ) : (
        <div className="space-y-2 max-h-80 overflow-y-auto">
          {data.events.map((e) => (
            <div
              key={e.id}
              className="flex items-start gap-3 p-2 rounded hover:bg-white/5"
            >
              <div className="flex flex-col items-center min-w-[60px]">
                <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${levelBadge(e.level)}`}>
                  {e.level}
                </span>
                <span className={`text-xs mt-1 ${urgencyColor(e.urgency)}`}>
                  {fmtTime(e.time)}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-white text-sm font-medium">{e.title}</span>
                  <span className="text-gray-500 text-xs">{MACRO_EVENT_CATEGORY_LABEL[e.category]}</span>
                </div>
                {(e.previous || e.forecast || e.actual) && (
                  <div className="text-xs text-gray-500 mt-0.5 flex gap-3">
                    {e.previous && <span>前值 {e.previous}</span>}
                    {e.forecast && <span>预期 {e.forecast}</span>}
                    {e.actual && <span className="text-text">实际 {e.actual}</span>}
                  </div>
                )}
                {e.note && <div className="text-xs text-gray-600 mt-0.5">{e.note}</div>}
              </div>
              <div className={`text-xs font-bold ${urgencyColor(e.urgency)}`}>
                {e.urgency === 'RED' ? '●' : e.urgency === 'YELLOW' ? '●' : '○'}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ========== 面板 3：BTC/SOL 资金费率 ========== */

/**
 * 费率着色：按"拥挤风险"着色，而不是按正负号染成红/绿。
 * 原先"正费率=红、负费率=绿"与"涨绿跌红"的读法相反，容易被误读成看跌信号。
 * 现在：偏离越大越接近警示色（amber），接近中性则为灰。
 */
function fundingTone(rate: number): string {
  const pct = Math.abs(rate) * 100;
  if (pct >= 0.05) return 'text-warn';
  if (pct >= 0.01) return 'text-gold';
  return 'text-gray-300';
}

function FundingPanel() {
  const [symbol, setSymbol] = useState<'BTC_USDT' | 'SOL_USDT'>('BTC_USDT');
  const [data, setData] = useState<MacroFundingData | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const d = await api.getMacroFunding(symbol);
      setData(d);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '请求失败');
    }
  }, [symbol]);

  useEffect(() => {
    setData(null);
    setError('');
  }, [symbol]);

  // 走 usePolling：页面不可见时暂停（dev.md 5.2）
  usePolling(load, 60_000);

  return (
    <div className="bg-card border border-cardborder rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-white font-semibold">多交易所资金费率</h2>
        <div className="flex gap-1">
          {(['BTC_USDT', 'SOL_USDT'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSymbol(s)}
              className={`px-2 py-0.5 text-xs rounded ${
                symbol === s ? 'bg-gold text-black' : 'bg-gray-700 text-gray-400 hover:text-white'
              }`}
            >
              {s.replace('_USDT', '')}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="text-down text-xs mb-2">获取失败：{error}</div>}

      {data ? (
        <>
          <div className="grid grid-cols-2 gap-3 mb-2">
            <div>
              <div className="text-gray-500 text-xs">
                {data.weightedByOpenInterest ? '持仓量加权当期费率' : '当期费率（算术平均）'}
              </div>
              <div className={`text-lg font-mono font-bold ${fundingTone(data.weightedFundingRate)}`}>
                {fmtPct(data.weightedFundingRate)}
              </div>
            </div>
            <div>
              <div className="text-gray-500 text-xs">
                {data.weightedByOpenInterest ? '持仓量加权年化' : '年化（算术平均）'}
              </div>
              <div className={`text-lg font-mono font-bold ${fundingTone(data.weightedAnnualizedRate)}`}>
                {fmtAnnualized(data.weightedAnnualizedRate)}
              </div>
            </div>
          </div>

          {!data.weightedByOpenInterest && (
            <div className="mb-2 text-[10px] text-gray-500">
              ⚠ 全部交易所的持仓量均未取到，当前为算术平均而非持仓量加权
            </div>
          )}

          <div className="space-y-2">
            {data.exchanges.map((e) => (
              <div key={e.exchange} className="flex items-center justify-between p-2 rounded bg-black/20">
                <span className="text-white text-sm font-medium">
                  {e.exchange}
                  {!e.ok && <span className="ml-1 text-[10px] text-down">不可用</span>}
                </span>
                {e.ok ? (
                  <div className="flex gap-3 text-xs font-mono items-center">
                    <span className={fundingTone(e.fundingRate)}>{fmtPct(e.fundingRate)}</span>
                    <span className="text-gray-500">年化 {fmtAnnualized(e.annualizedRate)}</span>
                    <span className="text-gray-600">/{e.settlementHours}h</span>
                    <span className="text-gray-600">
                      OI {e.openInterest > 0 ? `$${(e.openInterest / 1e9).toFixed(2)}B` : '—'}
                    </span>
                  </div>
                ) : (
                  <span className="text-[10px] text-gray-600">{e.error ?? '取数失败'}</span>
                )}
              </div>
            ))}
          </div>

          <div className="mt-2 text-[10px] text-gray-600">
            年化按各交易所**实际结算周期**折算（Gate.io 取 funding_interval，OKX 取相邻两期之差）。
            {data.availableCount}/{data.exchanges.length} 个交易所取数成功。
          </div>
        </>
      ) : (
        !error && <div className="text-gray-500 text-sm py-4 text-center">加载中…</div>
      )}
    </div>
  );
}

/* ========== 面板 4：清算热力图 ========== */

function LiquidationPanel() {
  const [symbol, setSymbol] = useState<'BTC_USDT' | 'SOL_USDT'>('BTC_USDT');
  const [data, setData] = useState<LiquidationHeatmap | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const d = await api.getMacroLiquidation(symbol);
      setData(d);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '请求失败');
    }
  }, [symbol]);

  useEffect(() => {
    setData(null);
    setError('');
  }, [symbol]);

  usePolling(load, 60_000);

  if (!data) {
    return error ? (
      <PanelError title="清算热力图" message={error} />
    ) : (
      <PanelLoading title="清算热力图" />
    );
  }

  const maxUsd = Math.max(...data.cells.map((c) => c.longLiquidationUsd + c.shortLiquidationUsd), 1);

  return (
    <div className="bg-card border border-cardborder rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-white font-semibold">清算热力图</h2>
        <div className="flex gap-1">
          {(['BTC_USDT', 'SOL_USDT'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSymbol(s)}
              className={`px-2 py-0.5 text-xs rounded ${
                symbol === s ? 'bg-gold text-black' : 'bg-gray-700 text-gray-400 hover:text-white'
              }`}
            >
              {s.replace('_USDT', '')}
            </button>
          ))}
        </div>
      </div>

      {!data.live ? (
        // 取不到真实强平数据时明确显示"暂不可用"，不再用随机数冒充
        <div className="text-sm text-gray-400 py-6 text-center">
          暂不可用
          <div className="text-[10px] text-gray-600 mt-1">
            未能取得真实强平订单{data.reason ? `（${data.reason}）` : ''}
          </div>
        </div>
      ) : data.cells.length === 0 ? (
        <div className="text-sm text-gray-400 py-6 text-center">
          近 {data.windowHours} 小时无强平订单
          <div className="text-[10px] text-gray-600 mt-1">样本为空，不代表市场没有强平</div>
        </div>
      ) : (
        <>
          <div className="flex items-end gap-1 h-32 mb-3">
            {data.cells.map((c, i) => {
              const total = c.longLiquidationUsd + c.shortLiquidationUsd;
              const heightPct = (total / maxUsd) * 100;
              const longPct = total > 0 ? (c.longLiquidationUsd / total) * 100 : 0;
              return (
                <div
                  key={i}
                  className="flex-1 flex flex-col justify-end h-full"
                  title={`${c.price}: 多单强平 $${c.longLiquidationUsd.toLocaleString()} / 空单强平 $${c.shortLiquidationUsd.toLocaleString()}`}
                >
                  <div
                    className="w-full relative"
                    style={{ height: `${heightPct}%`, minHeight: total > 0 ? '2px' : '0' }}
                  >
                    <div className="absolute top-0 left-0 right-0 bg-down/70" style={{ height: `${longPct}%` }} />
                    <div
                      className="absolute bottom-0 left-0 right-0 bg-up/70"
                      style={{ height: `${100 - longPct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          <div className="flex justify-between text-[10px] text-gray-600 mb-3">
            <span>{data.cells[0]?.price}</span>
            <span>{data.cells[Math.floor(data.cells.length / 2)]?.price}</span>
            <span>{data.cells[data.cells.length - 1]?.price}</span>
          </div>

          <div className="flex items-center gap-4 text-xs text-gray-500 mb-2">
            <span className="flex items-center gap-1">
              <span className="w-3 h-3 bg-down/70 inline-block" />
              多单强平
            </span>
            <span className="flex items-center gap-1">
              <span className="w-3 h-3 bg-up/70 inline-block" />
              空单强平
            </span>
          </div>

          <div className="text-xs text-gray-500 mb-1">
            窗口 近 {data.windowHours} 小时 · 样本 {data.sampleCount} 笔 · 合计 $
            {data.totalUsd.toLocaleString()}
          </div>

          {data.topLevels.length > 0 && (
            <div className="text-xs text-gray-500">
              金额最大价位：
              {data.topLevels.map((l, i) => (
                <span key={i} className="ml-2 text-gold font-mono">
                  {l.price} (${(l.totalUsd / 1e3).toFixed(1)}K)
                </span>
              ))}
            </div>
          )}
        </>
      )}

      <div className="mt-2 text-[10px] text-gray-600">{data.disclaimer}</div>
    </div>
  );
}


/* ========== 面板 5：净流动性 ========== */

function LiquidityPanel({ data, error }: { data: LiquidityData | null; error?: string }) {
  if (!data) {
    return error ? <PanelError title="净流动性" message={error} /> : <PanelLoading title="净流动性" />;
  }

  const regimeLabel =
    data.regime === 'EXPANSION' ? '扩张' : data.regime === 'CONTRACTION' ? '收缩' : '平稳';
  const regimeColor =
    data.regime === 'EXPANSION' ? 'text-up' : data.regime === 'CONTRACTION' ? 'text-down' : 'text-warn';

  const values = data.history.map((h) => h.netLiquidity);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  return (
    <div className="bg-card border border-cardborder rounded-lg p-4">
      <h2 className="text-white font-semibold mb-3">净流动性（WALCL − TGA − RRP）</h2>

      {data.history.length === 0 ? (
        <div className="text-sm text-gray-400 py-6 text-center">
          暂不可用
          <div className="text-[10px] text-gray-600 mt-1">
            未能取得 FRED 数据{data.reason ? `（${data.reason}）` : ''}
          </div>
        </div>
      ) : (
        <>
          {!data.live && (
            <div className="mb-3 rounded border border-warn/50 bg-warn-bg px-2 py-1 text-warn text-xs">
              ⚠ {data.reason ?? '实时抓取失败'}，以下为最近一次成功抓取的快照
            </div>
          )}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4">
            <div>
              <div className="text-gray-500 text-xs">当前净流动性</div>
              <div className="text-white text-lg font-mono font-bold">${data.current.toFixed(0)}B</div>
              {data.asOf && <div className="text-[10px] text-gray-600">观测日 {data.asOf}</div>}
            </div>
            <div>
              <div className="text-gray-500 text-xs">
                较对照观测日变动
                {data.comparedTo && <span className="text-gray-600">（{data.comparedTo}）</span>}
              </div>
              <div className={`text-lg font-mono font-bold ${data.weeklyChange >= 0 ? 'text-up' : 'text-down'}`}>
                {data.weeklyChange >= 0 ? '+' : ''}${data.weeklyChange.toFixed(0)}B
              </div>
            </div>
            <div>
              <div className="text-gray-500 text-xs">流动性状态</div>
              <div className={`text-lg font-bold ${regimeColor}`}>{regimeLabel}</div>
            </div>
          </div>

          <div className="text-gray-500 text-xs mb-1">近 {data.history.length} 个观测周走势</div>
          <div className="flex items-end gap-1 h-24 mb-2">
            {data.history.map((p, i) => {
              const heightPct = ((p.netLiquidity - min) / range) * 100;
              const isLatest = i === data.history.length - 1;
              return (
                <div
                  key={p.date}
                  className={`flex-1 rounded-t ${isLatest ? 'bg-gold' : 'bg-text/40'}`}
                  style={{ height: `${Math.max(heightPct, 2)}%` }}
                  title={`${p.date}: 净流动性 $${p.netLiquidity.toFixed(0)}B（WALCL ${p.walcl.toFixed(0)} − TGA ${p.tga.toFixed(0)} − RRP ${p.rrp.toFixed(2)}）`}
                />
              );
            })}
          </div>
          <div className="flex justify-between text-[10px] text-gray-600">
            <span>{data.history[0]?.date}</span>
            <span>{data.history[data.history.length - 1]?.date}</span>
          </div>
        </>
      )}

      <div className="mt-3 text-[10px] text-gray-600">
        解读阈值：变动 &gt; +${LIQUIDITY_EXPANSION_THRESHOLD}B 扩张 / 变动 &lt; −
        {Math.abs(LIQUIDITY_CONTRACTION_THRESHOLD)}B 收缩
      </div>
      <div className="text-[10px] text-gray-600">{data.source}</div>
    </div>
  );
}

/* ========== 通用加载 / 错误面板 ========== */

function PanelLoading({ title }: { title: string }) {
  return (
    <div className="bg-card border border-cardborder rounded-lg p-4">
      <h2 className="text-white font-semibold mb-3">{title}</h2>
      <div className="text-gray-500 text-sm py-4 text-center">加载中…</div>
    </div>
  );
}

function PanelError({ title, message }: { title: string; message: string }) {
  return (
    <div className="bg-card border border-cardborder rounded-lg p-4">
      <h2 className="text-white font-semibold mb-3">{title}</h2>
      <div className="text-down text-sm py-4 text-center">获取失败：{message}</div>
    </div>
  );
}

/* ========== 主页面 ========== */

export function Macro() {
  const navigate = useNavigate();
  const [fomc, setFomc] = useState<FomcSnapshot | null>(null);
  const [calendar, setCalendar] = useState<MacroCalendarData | null>(null);
  const [liquidity, setLiquidity] = useState<LiquidityData | null>(null);
  const [liquidityError, setLiquidityError] = useState('');

  // FOMC/日历为人工维护 + FRED 序列（周频），1 小时刷新一次即可。
  // 走 usePolling：页面不可见时暂停（dev.md 5.2，原先用裸 setInterval 会一直请求）。
  const load = useCallback(async () => {
    api.getMacroFomc().then(setFomc).catch(() => {});
    api.getMacroCalendar().then(setCalendar).catch(() => {});
    try {
      setLiquidity(await api.getMacroLiquidity());
      setLiquidityError('');
    } catch (e) {
      setLiquidityError(e instanceof Error ? e.message : '请求失败');
    }
  }, []);

  usePolling(load, 3600_000);

  return (
    <div className="min-h-screen bg-bg text-text p-4">
      <div className="max-w-7xl mx-auto">
        <div className="mb-4">
          <h1 className="text-2xl font-bold text-white mb-1">
            Crypto Signa Monitor
          </h1>
          <p className="text-gray-500 text-xs mb-2">
            数据来源：Gate.io / Binance / OKX / FRED · 仅供学习参考，不构成投资建议
          </p>

          {/* 页面切换标签 */}
          <div className="flex gap-1 border-b border-cardborder pb-2">
            <button
              onClick={() => navigate('/')}
              className="px-4 py-1.5 text-sm rounded-t border-b-2 border-transparent text-gray-400 hover:text-white hover:border-gray-500"
            >
              监控面板
            </button>
            <button
              onClick={() => navigate('/macro')}
              className="px-4 py-1.5 text-sm rounded-t border-b-2 border-gold text-gold font-medium"
            >
              宏观背景
            </button>
          </div>
        </div>

        {/* 第一行：FOMC + 日历 */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
          <FomcPanel data={fomc} />
          <CalendarPanel data={calendar} />
        </div>

        {/* 第二行：资金费率 + 清算 */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
          <FundingPanel />
          <LiquidationPanel />
        </div>

        {/* 第三行：净流动性 */}
        <LiquidityPanel data={liquidity} error={liquidityError} />

        <footer className="mt-8 text-center text-gray-600 text-xs">
          宏观数据仅供学习参考，不构成投资建议；数据来源与精度见各面板说明。
        </footer>
      </div>
    </div>
  );
}
