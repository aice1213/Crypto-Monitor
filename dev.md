# 加密货币实时监控与AI策略分析平台 — 开发交付文档

| 属性 | 内容 |
| --- | --- |
| 文档版本 | V1.0.1（一致性修订 + 卡片预警化改版，见 13.1 第 10~12 条） |
| 对应PRD版本 | 加密货币实时监控与AI策略分析平台 PRD V1.0.0 |
| 交付日期 | 2026-09-12（V1.0.1 修订：2026-09-13） |
| 交付范围 | 前端、边缘代理、指标计算引擎、AI策略模块、CI/CD 全套 |
| 部署环境 | Cloudflare Pages + Workers |

> 本文档在 PRD 基础上补充了接口契约、数据模型、算法实现细节、工程化方案与验收标准；对 PRD 中未覆盖或存在歧义之处（符号规范化、数据不足、缓存与限流参数、错误降级等）均已明确给出方案。

---

## 1. 交付总览

### 1.1 交付物清单

| # | 交付物 | 说明 |
| --- | --- | --- |
| 1 | `apps/web` 前端应用（React + Vite + TS） | 监控面板、详情页、K线图表 |
| 2 | `apps/worker` Cloudflare Worker | Gate.io 代理缓存层 + AI 策略 Edge Function |
| 3 | `packages/indicators` 指标计算引擎 | EMA/RSI/MACD/OBV/支撑阻力/交易计划，纯函数、可单测 |
| 4 | `packages/shared` 共享类型与常量 | 前后端统一的数据契约 |
| 5 | 单元测试 + E2E 测试 | Vitest + Playwright |
| 6 | CI/CD（GitHub Actions） | lint → test → build → deploy（main 分支自动发布） |
| 7 | 部署文档与运维手册 | 本文档第 9、10 章 |

### 1.2 架构图（补充自 PRD 第 8 章）

```javascript
浏览器
 ├─ React SPA (Cloudflare Pages)
 │   ├─ Main Thread: UI / Zustand 状态
 │   ├─ Web Worker: indicatorWorker (EMA/RSI/MACD/OBV/评分/交易计划)
 │   └─ Web Worker: 可选 aiWorker（结果缓存与流式渲染）
 │
 ▼ HTTPS
Cloudflare Worker (gate-proxy)
 ├─ GET /api/ticker/:symbol        → Gate.io /futures/usdt/tickers (contract) + 3s KV/内存缓存
 ├─ GET /api/candles/:symbol?interval=1m|5m|15m&limit=200
 │                                   → Gate.io /futures/usdt/candlesticks (统一换算 limit ≤ 500)
 ├─ POST /api/ai/strategy          → 组装 Prompt → Workers AI (llama 3.x) / OpenAI → 流式/一次性返回
 └─ 统一：限流(令牌桶) / 超时(5s) / 重试(1次) / 降级(返回 last-known-good)
```

---

## 2. 数据契约（Data Contract）

> 所有接口返回统一信封：`{ code: 0, data: T, msg?: string, ts: number }`，`code !== 0` 为业务错误。

### 2.1 Symbol 规范化（PRD 未明确，此处补充）

- 用户输入统一转大写、去空格，支持以下形式自动归一为内部标准形式 `BTC_USDT`（Gate.io USDT 永续合约 pair 格式）：

  | 用户输入 | 归一结果 |
  | --- | --- |
  | `btc` / `BTC` | `BTC_USDT`（缺省后缀 USDT） |
  | `btcusdt` / `BTCUSDT` | `BTC_USDT` |
  | `btc_usdt` / `BTC-USDT` / `btc usdt` | `BTC_USDT` |

- 归一算法：① 去空格、转大写；② 若不含 `_`/`-` 且全为字母 → 追加 `_USDT`；③ 若不含 `_`/`-` 且以 `USDT`/`USD` 结尾 → 在结尾前插入 `_`；④ 将 `-`、空格替换为 `_`；⑤ 结果匹配 `^[A-Z0-9]{2,20}_(PERP|USDT|USD)$`。
- 归一后通过 `/api/ticker` 预检合约存在性，不存在则提示“合约不存在或未上市”。
- 默认合约列表（快速添加 chips）：`BTC_USDT, ETH_USDT, SOL_USDT, BNB_USDT, XRP_USDT, DOGE_USDT`。

### 2.2 TickerDto（卡片数据）

```ts
interface TickerDto {
  symbol: string;          // "BTC_USDT"
  last: number;            // 最新价
  change24h: number;       // 24h 涨跌幅，如 +0.0325 = +3.25%
  high24h: number;
  low24h: number;
  volume24h: number;       // 24h 成交额(USDT)
  ts: number;              // 服务端时间戳 ms
  stale?: boolean;         // 降级态：超过缓存容忍期返回 last-known-good（见 3.2），UI 置灰价格
}
```

### 2.3 IndicatorSnapshotDto（卡片指标，由前端 Worker 计算后回填）

```ts
interface IndicatorSnapshotDto {
  ema7: number; ema25: number; ema99: number;
  emaStructure: 'BULLISH' | 'BEARISH' | 'MIXED';      // 多头/空头/缠绕
  rsi14: number;                                       // 0-100
  rsiZone: 'OVERBOUGHT' | 'OVERSOLD' | 'NEUTRAL';      // >70 / <30 / 其他
  macd: { dif: number; dea: number; hist: number; signal: 'GOLDEN_CROSS' | 'DEATH_CROSS' | 'NONE' };
  obv: { value: number; ma20: number; flow: 'INFLOW' | 'OUTFLOW' | 'BALANCED' };
  trend: { score: number; direction: 'BULLISH' | 'BEARISH' | 'RANGING' }; // score ∈ [-100, 100]
  support: number[];                                   // 支撑价位（升序，最多3个）
  resistance: number[];                                // 阻力价位（降序，最多3个）
  plan: TradePlan | null;                              // 盈亏比<1.5 时为 null；决策内容仅详情页展示（卡片预警化，见 5.1.1）
  dataQuality: 'FULL' | 'GAPS_FILLED' | 'INSUFFICIENT'; // 数据质量分级（见 4.4）：K线<30根为 INSUFFICIENT
}

// AlertSnapshotDto（卡片预警指标，V1.0.1 新增）：卡片仅渲染本结构；决策型字段（plan/支撑阻力明细）下沉详情页
interface AlertSnapshotDto {
  fundingRate: number;              // 当前资金费率（Gate.io /funding_rate）
  fundingSignal: 'LONG_HEAVY' | 'SHORT_HEAVY' | 'NEUTRAL'; // 多空拥挤情绪
  longShortRatio: number;           // 多空账户比（/contract_stats，interval=1h）
  volumePriceDivergence: 'BULLISH_DIVERGENCE' | 'BEARISH_DIVERGENCE' | 'NONE';
  multiTfConflict: boolean;         // 15m 与 1h 趋势方向不一致
  extremeAlert: 'OVERBOUGHT' | 'OVERSOLD' | null;   // RSI14 超买/超卖警示
  dataQuality: 'FULL' | 'GAPS_FILLED' | 'INSUFFICIENT';
}

interface TradePlan {
  entryLow: number; entryHigh: number;   // 进场区
  tp1: number; tp2: number;              // 第一/第二止盈
  sl: number;                            // 止损
  rrRatio: number;                       // 盈亏比 = (TP1 - 进场中值) / (进场中值 - SL)
  side: 'LONG' | 'SHORT';
  reason: string;                        // 一句话生成依据，供 AI/用户参考
}
```

### 2.4 CandleDto / AiStrategyDto

```ts
interface CandleDto { time: number; open: number; high: number; low: number; close: number; volume: number; } // time: Unix秒

interface AiStrategyDto {
  symbol: string;
  summary: string;             // 综合策略分析文本（Markdown）
  signals: {                   // AI 对各项指标的复述校验（用于一致性检查）
    trend: 'BULLISH'|'BEARISH'|'RANGING';
    confidence: 'HIGH'|'MEDIUM'|'LOW';
  };
  disclaimer: string;          // 固定免责声明
  generatedAt: number;
  model: string;
}
```

---

## 3. Gate.io 接入与代理层设计

### 3.1 使用的公开接口（明确为 Gate.io 期货公开 API）

**数据源统一为 Gate.io USDT 永续合约（Futures）公开 API**，不涉及用户私钥，无需签名。

| 用途 | Gate.io 端点 | 说明 |
| --- | --- | --- |
| Ticker | `GET /api/v4/futures/usdt/tickers?contract=BTC_USDT` | 返回 `last`/`change_percentage`/`high_24h`/`low_24h`/`volume_24h`（金额为 USDT） |
| K线 | `GET /api/v4/futures/usdt/candlesticks?contract=BTC_USDT&interval=1m&limit=200&from=...&to=...` | 返回 `[ts(ms), volume, close, low, high, open]`（注意期货字段顺序与现货不同：第 4 位为 low、第 5 位为 high，接入时以实际响应为准并写入契约测试） |
| 合约元信息（预检用） | `GET /api/v4/futures/usdt/contracts/BTC_USDT` | 校验合约存在性与上市状态，返回 `name`/`mark_price`/`funding_rate` 等 |
| 资金费率 | `GET /api/v4/futures/usdt/funding_rate?contract=BTC_USDT` | 当前期资金费率，卡片“多空情绪”预警用 |
| 多空比 | `GET /api/v4/futures/usdt/contract_stats?contract=BTC_USDT&interval=1h` | 返回 `long_short_ratio` 等，卡片情绪预警用 |

> 与现货 API 的差异：`currency_pair` 参数替换为 `contract`；24h 成交额字段为 `volume_24h`（现货为 `quote_volume`）；k线 `limit` 上限 2000，本系统统一取 200。

### 3.2 Worker 缓存与限流策略（量化参数）

| 项 | 内存缓存 TTL | KV 缓存 TTL | 说明 |
| --- | --- | --- | --- |
| Ticker | 3s | 30s | 与前端轮询同频，命中内存缓存不触达 Gate.io；KV 用于跨实例共享与冷启动兜底 |
| Candles | 10s（同 symbol+interval 维度） | 30s | 详情页切换周期时防抖；KV 维度 key 含 interval |
| 资金费率/多空比 | 60s | 300s | 资金费率与情绪数据变化缓慢，低频拉取即可 |

> 缓存分层：内存缓存（单实例、低延迟）→ KV（跨实例、重启不丢）。所有 KV 写入均带 TTL，key 规则 `ticker:{symbol}` / `candles:{symbol}:{interval}` / `funding:{symbol}`。
| 令牌桶限流 | 每 Worker 实例 10 req/s，burst 20 | 防止突发打满 Gate.io IP 限额（公开接口约 200 req/10s/IP） |
| 超时 | 5s，重试 1 次（指数退避 300ms） | 仍失败返回 `503` + 前端展示"数据延迟，自动重连" |
| 降级 | 缓存 last-known-good，最长容忍 60s | 过期后标记 `stale: true`，UI 置灰价格 |
| 请求合并 | 同 key 并发请求去重（in-flight dedup） | 多卡片同标的只发一次 |

---

## 4. 指标计算引擎（packages/indicators）

全部为**纯函数**，输入 `CandleDto[]`，输出 `IndicatorSnapshotDto`，在 Web Worker 中运行。

### 4.1 核心算法实现要点

**EMA**：`ema[i] = k·close[i] + (1-k)·ema[i-1]`，`k = 2/(n+1)`；首值用 SMA 初始化。EMA 斜率取最近 5 根 EMA 差分的线性回归斜率符号。

**RSI(14)**：Wilder 平滑。`avgGain/avgLoss` 首值用简单平均，之后递推。

**MACD(12,26,9)**：DIF = EMA12 − EMA26；DEA = DIF 的 EMA9；柱 = (DIF − DEA) × 2。

- 金叉：`dif[t-1] ≤ dea[t-1] && dif[t] > dea[t] && hist[t] > 0`，且 `|dif[t]| ≤ ATR14 × 0.5`（零轴附近约束，实现"有效信号"要求）。
- 死叉对称。仅标记交叉发生当根 K 线，之后 3 根内保留"近期信号"状态用于 UI 弱化显示。

**OBV**：`obv += sign(close−prevClose) × volume`；MA20 为 OBV 的 20 周期 SMA。流入/流出除比较 MA20 外要求 OBV 的 5 周期斜率同号（PRD 要求，落地为线性回归斜率）。

**综合评分**（PRD 5.3.5，满分 ±100）：

| 条件 | 得分 |
| --- | --- |
| EMA 多头 / 空头 | +30 / −30 |
| MACD 金叉(零轴附近) / 死叉 | +25 / −25 |
| RSI 超卖 / 超买 | +20 / −20 |
| OBV 流入 / 流出 | +25 / −25 |

方向判定：`≥ +40` 看涨；`≤ −40` 看跌；否则震荡。

### 4.2 支撑/阻力（PRD 5.3.6 落地）

1. 取最近 100 根 K 线，找局部极值 Pivot：`high[i]` 为左右各 3 根内最大 → 候选阻力；`low[i]` 同理 → 候选支撑。
2. 对候选价按 0.3% 聚类（ price band ），每簇取成交量加权中心。
3. 取当前价上方最近 1~3 簇为阻力，下方 1~3 簇为支撑；若不足，以 `EMA99 ± 当前价×0.8%` 作为动态补充位。
4. 输出按距离当前价排序，最多各 3 个。

### 4.3 交易计划（PRD 5.3.7 落地）

- **方向**：评分 ≥ 40 做多计划；≤ −40 做空计划；震荡不出计划（`plan = null`）。
- **进场区**：做多 = `min(ema25, 最近支撑) ± 0.3%`；做空对称。
- **TP1** = 最近阻力（做空：最近支撑）；**TP2** = TP1 外推 1%。
- **SL** = 进场区远端 1.5%，且不得越过下一关键位（做多时 SL < 次近支撑）。
- **盈亏比**：`RR = |TP1 − entryMid| / |entryMid − SL|`，要求 ≥ 1.5，否则 `plan = null` 并输出 `reason`。

### 4.4 边界情况处理（PRD 未覆盖，补充）

| 场景 | 行为 |
| --- | --- |
| 新上市交易对 K 线 < 120 根 | 指标照常计算（EMA99 用可得数据），`emaStructure` 输出 MIXED，评分权重归一化 |
| 数据 < 30 根 | 卡片显示"数据积累中"，不出交易计划 |
| 价格极端跳变（单根 > 15%） | 该根不参与指标，标记异常 |
| K线时间戳不连续 | 缺口以最后收盘价前值填充，`dataQuality = 'GAPS_FILLED'`；缺口占比 > 20% 整体标记 `INSUFFICIENT` |
| Web Worker 不可用（旧浏览器） | 主线程兜底同步计算，控制台告警 |

---

## 5. 前端实现

### 5.1 技术栈与目录结构

```javascript
apps/web/
├── src/
│   ├── pages/Home/          # 监控面板（搜索区 + 卡片网格）
│   ├── pages/Detail/        # AI策略 + K线（路由 /detail?symbol=BTC_USDT）
│   ├── components/Card/     # 监控卡片（14 个字段，PRD 5.1.2）
│   ├── components/Chart/    # Lightweight Charts 封装（多周期 + 4 子图）
│   ├── workers/indicator.worker.ts
│   ├── store/               # Zustand：watchlist、settings、priceFlash
│   ├── hooks/               # usePolling(3s, 页面可见性暂停)、useIndicators
│   └── lib/api.ts           # fetch 封装，超时/重试/错误统一处理
└── public/
│   └── _redirects          # SPA 路由回退规则（见 9.2）
```

### 5.1.1 监控卡片设计规范（以视觉稿为准）

卡片为深色圆角容器（`#0d1a12` 近黑绿底、1px 暗绿边框、8px 圆角），字号紧凑、行距 1.6，字段布局自上而下：

```
┌─────────────────────────────────────┐
│ BTC                     [ ⚠ 预警 ] │  ← 行1：标的加粗白字左对齐；右侧预警标签
│                                     │     有警示=琥珀底深棕字，全部正常=灰底“平稳”
│ 77334.2                  +6.04%     │  ← 行2：实时价大字号(≈22px)，价格变动闪烁；
│                                     │     24h涨幅右对齐，涨绿跌红
│ 资金费率 0.012%   多空比 1.24      │  ← 行3：资金费率 + 多空账户比（中性色）
│ 情绪: 多头拥挤，谨慎追高 ⚠         │  ← 行4：多空情绪（拥挤=警示色）
│ 量价: 价涨量缩，顶背离警示 ⚠       │  ← 行5：量价背离（无背离显示“量价正常”灰字）
│ 多周期: 15m↑ vs 1h↓ 方向冲突 ⚠    │  ← 行6：多周期方向一致性
│ RSI(15m) 76  超买 ⚠                 │  ← 行7：超买超卖警示（>70 红 / <30 绿）
│                        [移除][详情] │  ← 底部右侧描边按钮；决策内容见详情页
└─────────────────────────────────────┘
```

视觉与逻辑要点：

- **预警标签**（右上胶囊）：任一警示命中（情绪拥挤 / 量价背离 / 周期冲突 / 超买超卖）显示“⚠ 预警”琥珀底深棕字；全部正常显示“平稳”灰底胶囊。
- **价格闪烁**：相对上一次轮询上涨亮绿 500ms、下跌亮红 500ms，仅变色不重排。
- **决策内容下沉（V1.0.1）**：进场区、止盈/止损、支撑阻力明细、交易计划（plan）**不在卡片展示**，统一移至详情页决策面板（见 5.3）；卡片字段集改为预警型，对应 `AlertSnapshotDto`（见 2.3）。
- **警示生成规则**：① 情绪——`|fundingRate| > 0.05%` 或 `longShortRatio > 2 / < 0.5` 判拥挤（多头拥挤提示谨慎追高，空头拥挤提示谨慎杀跌）；② 量价背离——价格创 5 根窗口新高而 OBV/成交量未新高（顶背离），或价格新低而 OBV 未新低（底背离）；③ 多周期冲突——15m 评分方向与 1h 评分方向不一致；④ 超买超卖——RSI14 > 70 / < 30。
- **按钮**：移除（二次确认弹窗）/ 详情（跳转 `/detail?symbol=BTC_USDT`），均为透明底 + 暗金色描边小按钮，hover 提亮。
- **数据缺失态**：`dataQuality = 'INSUFFICIENT'` 时卡片显示“数据积累中”；`'GAPS_FILLED'` 时在卡片右上角以灰点标记；预警字段与价格数据照常可用，不整卡置灰。

### 5.2 状态与轮询

- **Watchlist 持久化**：`localStorage`（key: `crypto.watchlist.v1`），上限 20 个（PRD 风险章节要求）；超过给出提示。
- **轮询**：`document.visibilityState === 'visible'` 时才轮询（PRD 性能风险要求的非活跃暂停）；同一 symbol 多卡片共享一个轮询单元。
- **价格闪烁**：价格变化时触发 500ms 高亮动画（涨亮绿/跌亮红），使用 CSS class 切换而非重排。
- **卡片网格**：CSS Grid，`repeat(auto-fill, minmax(160px, 1fr))` 实现 320px–2560px 自适应，PC 约 3 列、手机 2 列，配合 `grid-template-columns` 断点精确控制；过渡用 `transition: grid 200ms` 不生效的部分改用 FLIP 动画库或仅做 opacity 过渡（技术备注）。

### 5.3 详情页图表

- 周期切换 `1m / 5m / 15m`，切换时保留可视区域右端对齐，数据预取相邻周期。
- 主图：Candlestick + EMA7/25/99（三色线）；副图依次 MACD（柱+双线）、RSI（14，30/70 虚线）、OBV（线 + MA20）。
- 水平线：支撑（绿虚线）、阻力（红虚线）、进场区（半透明绿/红矩形，`createPriceLine` + custom series 实现阴影）。
- **决策面板（V1.0.1 新增）**：K 线下方独立区块展示交易计划（方向 / 进场区 / TP1 / TP2 / SL / 盈亏比）与支撑阻力明细，数据来自 `IndicatorSnapshotDto.plan` 与 `support`/`resistance`；`plan = null` 时显示“观望：信号冲突 / 盈亏比不足”。
- AI 面板：Markdown 渲染（禁用 HTML 防 XSS），“重新生成”按钮 60s 冷却防刷。

### 5.4 主题与样式

- 背景 `#121212`，主文字 `#A8E6CF`，涨 `#26a69a`→亮绿 `#00e676`，跌 `#ef5350`→亮红 `#ff5252`，卡片 `#1e1e1e`、边框 `#2a2a2a`。
- Tailwind 扩展 token 统一在 `tailwind.config.ts`，避免散落魔法色值。

---

## 6. AI 策略模块

### 6.1 Prompt 设计（强制数据驱动，防幻觉）

```javascript
你是加密货币量化分析师。仅基于下方给定指标数据推理，禁止臆造未提供的信息；
若数据矛盾或不足，明确说明"信号冲突，建议观望"。
输出 Markdown，固定包含：## 趋势研判 / ## 关键位与量价 / ## 交易计划 / ## 风险提示。
交易计划必须与给定 plan 字段一致，不得另行编造价格。

[输入数据]
标的: {symbol}  周期: {interval}  时间: {ts}
价格: {last} (24h {change24h}%)
EMA结构: {emaStructure}  RSI14: {rsi14} ({rsiZone})
MACD: DIF {dif} DEA {dea} 信号 {signal}
OBV流向: {flow}  支撑 {support} 阻力 {resistance}
规则引擎评分: {score} ({direction})
交易计划: {plan ?? '不满足盈亏比要求，无计划'}
```

### 6.2 调用与一致性校验

- 首选 **Cloudflare Workers AI**（免 Key 管理、低延迟），模型 `@cf/meta/llama-3.1-8b-instruct`；预留 OpenAI 兼容适配层。
- Worker 侧校验：AI 输出中的方向/plan 价格与规则引擎不一致时，在 UI 标注"AI 观点与规则引擎存在分歧"，并以后者为准展示。
- 同一 symbol 结果缓存 60s，重新生成强制刷新。
- 输出固定附加免责声明："本内容仅供学习参考，不构成投资建议；加密货币交易风险极高，请自行决策、控制风险。"

---

## 7. 非功能需求落地对照

| PRD 要求 | 落地方案 |
| --- | --- |
| 首页 3s 轮询 | `usePolling(3000)` + visibility 暂停 + Worker 缓存 |
| Web Worker 计算 | `indicator.worker.ts`，postMessage 批量回传，单批计算 < 50ms |
| LCP < 2s | Vite 分包（vendor/charts 分离）+ 路由懒加载 + 字体 `font-display: swap` + 首屏骨架屏 |
| HTTPS 强制 | Cloudflare Pages 默认全站 HTTPS + HSTS |
| AI Key 不暴露 | 全部 AI 调用经 Worker，前端无任何 Secret |
| 兼容性 | Browserslist `last 2 versions, not dead`；Lightweight Charts v4/v5 按构建目标降级 |

---

## 8. 测试计划

| 层级 | 工具 | 覆盖 |
| --- | --- | --- |
| 单元测试 | Vitest | indicators 包全算法（与 TA-Lib/TradingView 快照对拍 ≥ 30 组样本）、评分边界（±40）、RR 计算、符号规范化 |
| 组件测试 | Testing Library | 卡片渲染、超买标红、移除二次确认、防重提示 |
| Worker 测试 | `@cloudflare/vitest-pool-workers` | 缓存 TTL、限流、错误降级、AI 一致性校验 |
| E2E | Playwright | 添加标的→卡片出现→详情页→周期切换→返回状态保持 |
| 契约测试 | MSW mock Gate.io 响应 | 期货 K线字段顺序（ts,volume,close,low,high,open）回归 |
| 性能基准 | Vitest bench + CI 阈值脚本 | 单批 20 标的指标计算 P95 < 50ms（Web Worker）；首屏 LCP < 2s 纳入 CI 阻断阈值 |
| Worker 压力测试 | k6 / autocannon | Gate.io 代理 100 rps × 60s：缓存命中率 ≥ 90%、P95 < 300ms、零 5xx；AI 接口 20 rps：限流与降级生效 |

**关键验收用例（指标对拍）**：用 BTC_USDT 2026-01-01 ~ 2026-08-31 日线 240 根，EMA/RSI/MACD 与 TradingView 偏差容忍：EMA < 0.05%、RSI < 0.5、MACD DIF/DEA < 0.01%。

---

## 9. 部署方案

### 9.1 环境划分

| 环境 | 分支 | 地址 |
| --- | --- | --- |
| 生产 | `main` | `https://crypto-monitor.pages.dev`（可绑自定义域） |
| 预览 | PR 分支 | `https://<branch>.crypto-monitor.pages.dev` |

### 9.2 部署步骤

```bash
# 0. 确保 SPA 回退规则存在（apps/web/public/_redirects，构建时自动复制到 dist）
#    /*  /index.html  200

# 1. 构建前端
pnpm --filter web build        # 输出 apps/web/dist

# 2. 独立部署 Worker（含 AI / KV 绑定）
cd apps/worker
wrangler deploy --env production
# 需在 dashboard 绑定: AI (Workers AI)、KV 命名空间 CRYPTO_CACHE（跨实例缓存，见 3.2）
# Worker 独立部署、独立伸缩，不依赖 Pages 运行时

# 3. 部署 Pages（纯静态托管，不承载任何 API 逻辑）
wrangler pages deploy apps/web/dist --project-name crypto-monitor

# 4. 自定义域路由（必配，替代 Pages Functions）
# Dashboard → Worker → Settings → Domains & Routes：
#   绑定 api.crypto-monitor.com（或主站自定义域的 /api/* 路由）直连该 Worker。
# 前端 apps/web/src/lib/api.ts 通过 VITE_API_BASE（默认同源 /api）指向 Worker 域；
# 同源部署时由 Cloudflare 路由规则将 /api/* 转发至 Worker，无需 Pages Functions。
```

### 9.3 SPA 路由回退（必配）

本项目为 React SPA（含 `/detail?symbol=...` 路由），直接访问或刷新子路由会 404。需在 `apps/web/public/_redirects` 写入：

```
/*  /index.html  200
```

构建时 Vite 自动将其复制到 `dist/` 一并部署。此文件不进入版本控制忽略列表，变更需走 CR。

### 9.4 环境变量（Worker）

| 变量 | 说明 | 密级 |
| --- | --- | --- |
| `OPENAI_API_KEY` | 备用 AI 提供商 | Secret |
| `AI_PROVIDER` | `workers-ai`（默认）/ `openai` | 普通 |
| `GATEIO_BASE` | `https://api.gateio.ws` | 普通 |
| `CRYPTO_CACHE`（KV 命名空间绑定） | 跨实例缓存与冷启动兜底（见 3.2） | 普通 |
| `VITE_API_BASE`（前端构建变量） | Worker 自定义域地址，默认 `/api` 同源 | 普通 |

### 9.5 CI/CD 流水线

```javascript
push/PR → lint (eslint + tsc) → unit tests (含 worker pool) → build
→ (main) deploy worker → deploy pages → smoke test (curl /api/ticker/BTC_USDT)
→ (失败) 自动回滚至上一 Pages deployment
```

---

## 10. 运维与监控

- **告警**：Worker 侧记录 Gate.io 5xx 比例、AI 调用延迟 P95；可用 Cloudflare Workers Analytics / 简单 Logpush 到 R2。
- **降级开关**：Worker 环境变量 `AI_ENABLED=false` 可全局关闭 AI 功能（详情页显示"AI 维护中"）。
- **成本控制**：AI 调用按 symbol 60s 缓存 + **每日上限 300–500 次**。Workers AI 免费额度约 10,000 neurons/日，按本系统平均 prompt 输入/输出长度折算，300–500 次调用即触顶；超限后返回规则引擎策略文本兜底，并在 UI 提示“AI 额度已用尽，今日展示规则引擎策略”。**升级路径**：① 开通 Workers 付费计划提升 AI 额度；② 配置 `OPENAI_API_KEY` 并切换 `AI_PROVIDER=openai` 走按量付费；③ 提高缓存 TTL 降低调用频率。

---

## 11. 里程碑与验收（对应 PRD 第 10 章，补充验收标准）

| 阶段 | 周期 | 交付物 | 验收标准（DoD） |
| --- | --- | --- | --- |
| P0 基础框架 | 第1周 | 脚手架、主题、卡片 UI | 320/768/1440/2560 四档截图走查通过；Lighthouse 可访问性 ≥ 90 |
| P1 数据接入 | 第2周 | Gate.io 代理 + 指标引擎 + 实时流 | 20 标的并行 3s 轮询 Gate.io 出网 QPS ≤ 3；指标对拍通过 |
| P2 策略引擎 | 第3周 | 评分/关键位/交易计划 + K线 | 评分边界单测全绿；K线三周期切换无闪断；盈亏比过滤生效 |
| P3 AI 集成 | 第4周 | Prompt 工程 + 一致性校验 | 30 组样本中 AI 方向与规则引擎一致率 ≥ 85%；Key 不出现在前端 bundle（构建检查脚本） |
| P4 测试上线 | 第5周 | 全端测试 + 部署 | E2E 全绿；Chrome/Firefox/Safari/Edge + iOS Safari 真机走查；P95 TTFB < 600ms |

---

## 12. 风险应对对照（对应 PRD 第 11 章，落地化）

| 风险 | PRD 措施 | 本期落地 |
| --- | --- | --- |
| Gate.io 限流 | Worker 缓存 + 请求合并 + 降级 | 3s/10s TTL、in-flight dedup、令牌桶 10/s、last-known-good 60s |
| 指标偏差 | 交叉验证 + 单测 | TA-Lib 对拍 + 0.05%/0.5 容差 + 快照回归 |
| AI 幻觉 | 强制基于数据推理 + 免责声明 | Prompt 强约束 + 输出与规则引擎一致性校验 + 分歧标注 |
| 合规 | 免责声明 | 首页页脚 + 详情页 + AI 输出三处固定展示 |
| 多标卡顿 | 限 20 个 + 暂停非活跃轮询 | localStorage 上限 + visibility API + Worker 计算 + 共享轮询单元 |
| 限流跨实例一致性 | —（本期接受该限制，列为已知技术债） | 内存令牌桶不跨实例，多实例部署时全局一致限流需引入 Durable Objects；本期单实例 + KV 缓存 + Gate.io IP 限额（200 req/10s）裕度充足，多实例扩容时优先落地 DO 方案 |

---

## 13. 附录

### 13.1 PRD 补充/修订记录

1. **符号规范化**（新增，2.1）：`BTC`/`BTCUSDT`/`btc` 等输入统一归一为 `BTC_USDT`，含缺省后缀规则与合约预检。
2. **数据源明确为期货公开 API**（修订，3.1）：采用 Gate.io USDT 永续合约 `/futures/usdt/*` 端点，替换初稿中的现货 API；注意期货 K线字段顺序与现货不同。
3. **K线不足与异常跳变**（新增，4.4）：定义数据积累期与异常过滤。
4. **AI 一致性校验与降级**（新增，6.2 / 10）：防幻觉的工程兜底。
5. **止盈第二目标位**（明确，4.3）：TP2 = 阻力上方 1%，仅提示不作为 RR 依据。
6. **watchlist 上限提示**（明确，5.2）。
7. **Gate.io candlesticks 返回字段顺序**（补充，3.1）：现货/期货字段顺序不同，接入时极易踩坑，已写入契约测试。
8. **监控卡片设计规范**（新增，5.1.1）：以视觉稿为准逐行定义卡片布局、配色与"动能"文案；补充卡片 OBV 固定 4h 周期、主判定周期为 15m 的约定。（V1.0.1 起卡片 OBV/动能展示已被第 10 条预警化改版取代，本条仅留档）。
9. **SPA 路由回退**（新增，9.3）：`_redirects` 规则防止 `/detail` 刷新 404。
10. **卡片指标预警化**（修订，2.3 / 3.1 / 5.1.1 / 5.3）：卡片仅保留资金费率+多空情绪、量价背离、多周期冲突、超买超卖四类“预警型”指标；进场区、TP/SL、支撑阻力明细等“决策型”内容下沉至详情页决策面板；新增 `AlertSnapshotDto`、`funding_rate` / `contract_stats` 两个数据源。
11. **缓存分层与部署解耦**（修订，3.2 / 9.2 / 9.4）：缓存策略表拆分为“内存缓存 TTL”与“KV 缓存 TTL(30s)”两栏；Worker 明确为独立部署，通过自定义域路由 `/api/*`，不再依赖 Pages Functions。
12. **AI 成本控制与测试补强**（修订，8 / 10）：AI 日调用上限由 2000 调整为 300–500 次，注明免费额度限制与三条升级路径；测试计划新增性能基准与 Worker 压力测试项；风险章节补充内存限流不跨实例、需 Durable Objects 实现全局一致的说明。

### 13.2 常用命令

```bash
pnpm install
pnpm dev              # 本地起 web + worker (wrangler dev)
pnpm test             # 全部单测
pnpm test:e2e         # Playwright
pnpm build && pnpm deploy
```

### 13.3 参考资料

- Gate.io API v4: https://www.gate.io/docs/developers/apiv4/
- Lightweight Charts: https://tradingview.github.io/lightweight-charts/
- TechnicalIndicators: https://github.com/anandanand84/technicalindicators
- Cloudflare Workers AI: https://developers.cloudflare.com/workers-ai/