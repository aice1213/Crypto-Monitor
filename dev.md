# 加密货币实时监控与AI策略分析平台 — 开发交付文档

| 属性 | 内容 |
| --- | --- |
| 文档版本 | V1.0.2（P0 / 一致性 / 工程化 / 契约 / 图表与 AI / 宏观去伪存真，共六批修复；见 13.1 第 13~18 条） |
| 对应PRD版本 | 加密货币实时监控与AI策略分析平台 PRD V1.0.0 |
| 交付日期 | 2026-09-12（V1.0.1 修订：2026-09-13；V1.0.2 修订：2026-10-09） |
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
  rsiZone: 'OVERBOUGHT' | 'OVERSOLD' | 'NEUTRAL';      // ≥70 / ≤30 / 其他（V1.0.2 明确为闭区间）
  macd: {
    dif: number; dea: number; hist: number;
    signal: 'GOLDEN_CROSS' | 'DEATH_CROSS' | 'NO_SIGNAL';
    // 距最近一次交叉的根数：0=当根交叉；1~3=保留期内的"近期信号"（仅用于 UI 弱化显示）；null=无信号
    signalAge: number | null;
  };
  obv: { value: number; ma20: number; flow: 'INFLOW' | 'OUTFLOW' | 'BALANCED' };
  trend: { score: number; direction: 'BULLISH' | 'BEARISH' | 'RANGING' }; // score ∈ [-100, 100]
  support: number[];                                   // 支撑价位（降序 = **离现价最近优先**，最多3个）
  resistance: number[];                                // 阻力价位（升序 = **离现价最近优先**，最多3个）
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
  summary: string;             // 综合策略分析文本（Markdown，前端自行渲染且禁用 HTML）
  signals: {
    // AI **自己**给出的方向（由输出中 `方向: 看多|看空|观望` 一行解析得到）。
    // V1.0.2 修订：早期实现直接复制规则引擎的 trend.direction，
    // 该字段在结构上永不可能分歧，一致性校验形同虚设（审查项 F31）。
    trend: 'BULLISH'|'BEARISH'|'RANGING';
    confidence: 'HIGH'|'MEDIUM'|'LOW';
    consensus: 'ALIGNED'|'DIVERGED'|'UNKNOWN';   // AI 方向与规则引擎是否一致
    engineTrend: 'BULLISH'|'BEARISH'|'RANGING';  // 规则引擎方向，供 UI 对照
  };
  disclaimer: string;          // 固定免责声明
  generatedAt: number;
  model: string;
  degraded: boolean;           // 是否走了降级路径（替代方案：规则引擎文本）
  degradedReason?: 'AI_DISABLED'|'QUOTA_EXHAUSTED'|'AI_UNAVAILABLE'|'PARSE_FAILED';
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
| Candles | 10s（同 symbol+interval+limit 维度） | 30s | 详情页切换周期时防抖；KV 维度 key 含 interval **与 limit** |
| 资金费率/多空比 | 60s | 300s | 资金费率与情绪数据变化缓慢，低频拉取即可 |

> 缓存分层：内存缓存（单实例、低延迟）→ KV（跨实例、重启不丢）。所有 KV 写入均带 TTL，key 规则 `ticker:{symbol}` / `candles:{symbol}:{interval}:{limit}` / `funding:{symbol}`。
> **limit 必须进 key**（V1.0.2 修订）：原 key 只有 `{symbol}:{interval}`，先请求 `limit=50` 会把结果写入缓存，后续 `limit=200` 的请求会命中这 50 根。
| 令牌桶限流 | 每 Worker 实例 10 req/s，burst 20 | 防止突发打满 Gate.io IP 限额（公开接口约 200 req/10s/IP） |
| 超时 | 5s，重试 1 次（指数退避 300ms） | 仍失败返回 `503` + 前端展示"数据延迟，自动重连" |
| 降级 | 缓存 last-known-good，最长容忍 60s；**ticker 与 candles 均须写入** | 过期后标记 `stale: true`，UI 置灰价格。原实现只对 ticker 调用降级写入，candles 的失败分支永远拿不到旧数据、直接 503 |
| 请求合并 | 同 key 并发请求去重（in-flight dedup） | 多卡片同标的只发一次 |
| 入参校验 | `interval` 必须命中 `SUPPORTED_INTERVALS` 白名单；`limit` 夹到 `[1, 500]`，非法值退回 200 | 原实现把查询串原样透传给上游，既可能触发未登记周期（`dataQuality` 恒为 `INSUFFICIENT`），也存在查询参数注入面；构造上游 URL 时 symbol 与 interval 均需 `encodeURIComponent` |
| CORS | `ALLOWED_ORIGINS` 为空时回显 `*`；非空时只回显**名单内**的 Origin，名单外**不输出** `Access-Control-Allow-Origin` | 原实现最后一行为 `return origin`，名单外的源也会被原样回显，白名单形同虚设 |

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
| MACD 金叉(零轴附近) / 死叉 —— **当根**（`signalAge === 0`） | +25 / −25 |
| MACD 金叉 / 死叉 —— 保留期内（`signalAge` 1~3） | +10 / −10 |
| RSI 超卖 / 超买 | +10 / −10 |
| OBV 流入 / 流出 | +25 / −25 |

> **RSI 权重说明（V1.0.2 修订）**：RSI 超买/超卖衡量的是"位置"而非"方向"。原设计 ±20 与 EMA/MACD/OBV 同权重，会使强趋势被超买扣分抵消而误判为震荡——实测 BTC_USDT 15m 在 EMA 完美多头排列（+30）且 OBV 流入（+25）时，因 RSI 73.5 超买（−20）仅得 35 分 < 40，被判为 `RANGING`，卡片同时输出"横盘区间，不做趋势"与"RSI 超买"两个互斥结论。故降为弱权重 ±10，方向由结构、动能、量能三者主导；RSI 极端值改由"风险提示/仓位建议"承载。

> **MACD 信号新鲜度（V1.0.2 修订）**：4.1 规定交叉信号"之后 3 根内保留**用于 UI 弱化显示**"。但 `signal` 枚举本身无法区分"当根交叉"与"3 根前交叉"，若两者计同权重，同一个交叉会在 4 根 K 线里持续投满票。故 `MacdResult` 新增 `signalAge`，评分与文案均按新鲜度弱化：当根计满权重，保留期内计弱权重。文案须明示新鲜度（如"MACD当根金叉" / "MACD金叉（近 2 根内）"），不得把保留期信号当作当根信号陈述。

方向判定：`≥ +40` 看涨；`≤ −40` 看跌；否则震荡。

### 4.2 支撑/阻力（PRD 5.3.6 落地）

1. 取最近 100 根 K 线，找局部极值 Pivot：`high[i]` 为左右各 3 根内最大 → 候选阻力；`low[i]` 同理 → 候选支撑。
2. 对候选价按 0.3% 聚类（ price band ），每簇取成交量加权中心。
3. 取当前价上方最近 1~3 簇为阻力，下方 1~3 簇为支撑；若不足，以 `EMA99 ± 当前价×0.8%` 作为动态补充位。
4. 输出按距离当前价排序（**最近优先**），最多各 3 个。
5. **禁止构造纯由现价推导的价位**（如 `当前价 × 1.008`）：这类值会随每次轮询跟着价格漂移，却以"支撑/阻力"名义展示与画线，误导性强。动态补充位只允许使用真实指标位（EMA99）。某侧确实没有有效位时，返回空数组，由前端显示占位符。

### 4.3 交易计划（PRD 5.3.7 落地）

- **方向**：评分 ≥ 40 做多计划；≤ −40 做空计划；震荡不出计划（`plan = null`）。
- **进场区**：做多 = `min(ema25, 最近支撑) ± 0.3%`；做空对称。
- **TP1** = 最近阻力（做空：最近支撑）；**TP2** = TP1 外推 1%。
- **SL**（V1.0.2 修订，消除原文自相矛盾）：基础止损 = 进场区远端 ±1.5%。允许为躲避"次近关键位"而放宽（做多贴至次近支撑下方 0.1%，做空对称），但**放宽后不得宽于 3%**。
  - 原实现取 `min(基础止损, 次近支撑下方)` 且无上限，导致次近支撑越远止损越宽：实测 `support=[98,88]` 时止损被推到 10% 外，一个真实 RR 6.82 的做多机会因 RR 被压到 1.19 而返回 `null`。加上限后该机会正常出计划。
  - 当"次近关键位"落在 1.5%~3% 之间时采用结构位；超出 3% 时退回 1.5% 基础止损。
- **盈亏比**：`RR = |TP1 − entryMid| / |entryMid − SL|`，要求 ≥ 1.5，否则 `plan = null`。
- **`plan = null` 的展示**：前端只能显示"观望：信号冲突 / 盈亏比不足"，**绝不允许前端自行估算价位**。前端拼凑的进场/止盈/止损会绕过 RR 风控并展示出虚高盈亏比（实测曾出现 10.24 / 155.23 这类数字）。
- **指标输入**：所有指标一律基于**已收盘 K 线**计算，未收盘的最后一根必须剔除（Gate.io 返回的末根为正在形成中，开盘初期成交量不足均量 2%，会使量比、OBV 流向与"地量/缩量"判断全部失真）。

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
- **警示生成规则**：① 情绪——`|fundingRate| > 0.05%` 或 `longShortRatio > 2 / < 0.5` 判拥挤（多头拥挤提示谨慎追高，空头拥挤提示谨慎杀跌）；② 量价背离——价格创 5 根窗口新高而 OBV/成交量未新高（顶背离），或价格新低而 OBV 未新低（底背离）；③ 多周期冲突——15m 评分方向与 1h 评分方向不一致；④ 超买超卖——RSI14 ≥ 70 / ≤ 30。
- **RSI 行配色**：超买红（`text-down`）、超卖绿（`text-up`）、中性灰；超买超卖均属警示，均需挂 ⚠。
- **行标签**：`情绪:` / `量价:` / `多周期:` / `RSI(周期)`，不得使用"策略"等与多周期一致性无关的措辞。
- **文案与状态一致性（V1.0.2 修订，强制）**：
  - 每一行的"是否挂 ⚠"必须与该行的**警示判定同源**，不得在展示层另起一套阈值。情绪行必须直接消费 `AlertSnapshotDto.fundingSignal`（与右上徽标的 `hasAlert()` 同源），否则会出现"行内挂 ⚠ 但徽标显示平稳"的自相矛盾（实测 13 组样本中 4 组命中）。
  - 量价行在无背离时必须输出"量价正常"灰字，**不得产生警示**；量比高低只能作为中性信息补充。
  - 量价行的涨跌方向必须用**价格**涨跌幅（`ticker.change24h`），严禁用成交量变化率冒充——实测出现过"价格 +1.09% 上涨、卡片显示'下行'"的错误。
  - 量价背离必须基于**已收盘** K 线判定（见 4.3 指标输入）。
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
  - v4 的 lightweight-charts **没有独立 pane API**，四个区带用各自的 `priceScaleId` + `scaleMargins` 纵向切分（主图 ≈ 顶部 42%，其下 MACD / RSI / OBV）。区带必须互不重叠且顺序固定，已用单测守卫。
  - **必须先由 series 以该 `priceScaleId` 创建刻度，再对其 `applyOptions`**，否则会抛 `Trying to apply price scale options with incorrect ID` 并导致整张图空白（本次修复中真实踩到，仅渲染验证可发现）。
  - RSI 副图纵轴固定 0~100（`autoscaleInfoProvider`），否则 30/70 参考线没有意义。
- 水平线：支撑（绿虚线）、阻力（红虚线）、TP1/TP2（绿）、SL（红）。**计划价位只在引擎给出了 `plan` 时绘制**，`plan = null` 时不得凭空画线。
- **进场区（半透明矩形）**：v4 无内置矩形图元，用 series primitive（`attachPrimitive` + `priceToCoordinate`）在 bitmap 坐标空间填充。做多绿、做空红，`zOrder: 'bottom'` 画在 K 线之下。
- **图表数据层与引擎共用实现**（V1.0.2 修订）：`components/Chart/chartData.ts` 复用 `ema / macd / rsi / obv / sma`，不再在图内自行重算 MACD（旧实现与引擎的 DEA 预热处理不一致，且把预热期画成贴着 0 的假柱）。MACD 副图显式跳过 `(slow−1)+(signal−1)=33` 根预热。
- **决策面板（V1.0.1 新增）**：K 线下方独立区块展示交易计划（方向 / 进场区 / TP1 / TP2 / SL / 盈亏比）与支撑阻力明细，数据来自 `IndicatorSnapshotDto.plan` 与 `support`/`resistance`；`plan = null` 时显示“观望：信号冲突 / 盈亏比不足”。
- **AI 面板（V1.0.2 补齐实现）**：`components/AiStrategy/AiPanel.tsx`。
  - Markdown 由 `lib/markdown.ts` 解析为结构化块，再以 React children 渲染；**全程不使用 `dangerouslySetInnerHTML`**，模型输出里的 `<script>`/`<img onerror>` 只会显示为文字（已用真实浏览器探针验证：`__xss = NOT_EXECUTED`、`imgCount = 0`）。
  - 同时展示「AI 方向」与「规则引擎」方向；`consensus === 'DIVERGED'` 时显示“⚠ AI 观点与规则引擎存在分歧，请以规则引擎方向为准”；`UNKNOWN` 时说明已回退为规则引擎方向。
  - `degraded` 必须显式标注为“规则引擎兜底”，并注明原因（配额用尽 / AI 已关闭 / AI 不可用），**不得让兜底文本冒充模型输出**。
  - “重新生成”按钮 60s 冷却防刷（倒计时可见）。首次进入与切换 symbol/周期时自动生成一次——该结果现在会被渲染出来。
  - 摘要开头的机器可读 `方向: …` 行在展示前剥离（上方已有方向标签）。

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
**方向**：必须单独一行且只能写 看多 / 看空 / 观望，格式为 `方向: 看多`（供一致性校验解析）。

[输入数据]
标的: {symbol}  周期: {interval}  时间: {ts}
价格: {last} (24h {change24h}%)
EMA结构: {emaStructure}  RSI14: {rsi14} ({rsiZone})
MACD: DIF {dif} DEA {dea} 信号 {signal}（当根交叉 / 近 N 根内，非当根）
OBV流向: {flow}  支撑 {support} 阻力 {resistance}
规则引擎评分: {score} ({direction})
交易计划: {plan ?? '不满足盈亏比要求，无计划'}
```

> MACD 信号必须带**新鲜度**说明（审查项 F19）：`signal` 枚举本身无法区分"当根交叉"与"3 根内保留"，
> 若不给模型这个上下文，模型会把已过去的交叉当成刚发生。

### 6.2 调用与一致性校验

- 首选 **Cloudflare Workers AI**（免 Key 管理、低延迟），模型 `@cf/meta/llama-3.1-8b-instruct`；预留 OpenAI 兼容适配层。
- **一致性校验（V1.0.2 落实）**：Worker 从 AI 输出中解析 `方向:` 一行得到 AI 自己的方向，与规则引擎方向比较，
  写入 `signals.consensus`（`ALIGNED` / `DIVERGED` / `UNKNOWN`），并在 `signals.trend` 中保留 **AI 的方向**、
  `signals.engineTrend` 保留规则引擎方向。UI 在 `DIVERGED` 时标注"AI 观点与规则引擎存在分歧，请以规则引擎方向为准"。
  无法解析方向时 `consensus = UNKNOWN`，`trend` 回退为规则引擎方向。
  - 早期实现把 `signals.trend` 直接赋值为 `snap.trend.direction`，该字段在结构上永不可能分歧，校验形同虚设。
- 降级路径（AI 未绑定 / 抛错 / 返回空 / `AI_ENABLED=false` / 额度用尽）统一走规则引擎文本，
  并以 `degraded: true` + `degradedReason` 标记，UI 显示"规则引擎兜底"。**兜底文本的结论与依据必须来自真实快照**：
  结论跟随 `trend.direction`（不得硬编码"观望"），关键位取 `support[0]` / `resistance[0]`（最近一级，而非最远一级）。
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

> **实现现状（V1.0.2 校准）**：下表"设计目标"为本期规划；"现状"列如实反映仓库中已具备的覆盖。此前仓库只有 2 个测试文件，覆盖率远低于本节规划，本轮已补齐核心回归（共 147 个用例，`npm test` 四包全绿）。

| 层级 | 工具 | 设计目标覆盖 | 现状 |
| --- | --- | --- | --- |
| 共享层单元测试 | Vitest | 符号规范化（含全角/中文别名/括号剥离/`_PERP`）、价格格式化 | ✅ 已完成（`packages/shared`，24 例） |
| 指标单元测试 | Vitest | EMA/RSI/MACD/ATR/OBV/支撑阻力/评分边界/交易计划/RR/数据质量/未收盘K线剔除 | ✅ 已完成（`packages/indicators`，75 例，5 个测试文件） |
| 前端逻辑测试 | Vitest | 卡片四行文案与状态判定同源、`buildAlert` 拥挤方向/背离/多周期/dataQuality | ✅ 已完成（`apps/web`，19 例，纯函数层） |
| Worker 测试 | Vitest（Node 环境 + fetch mock） | TTL 缓存、限流、请求合并、降级、字段映射 | 🟡 部分完成（`apps/worker`，29 例）：缓存/限流/合并已覆盖；**Gate.io 字段映射与 K 线契约已用 mock 覆盖**；尚未使用 `@cloudflare/vitest-pool-workers` 跑真实 workerd |
| 组件测试 | Testing Library | 卡片渲染、超买标红、移除二次确认、防重提示 | ❌ 未实现（需引入 jsdom + Testing Library） |
| E2E | Playwright | 添加标的→卡片出现→详情页→周期切换→返回状态保持 | ❌ 未实现（未引入依赖，根 `test:e2e` 脚本不存在） |
| 性能基准 | Vitest bench + CI 阈值 | 单批 20 标的 P95 < 50ms；首屏 LCP < 2s 阻断 | ❌ 未实现 |
| Worker 压力测试 | k6 / autocannon | 100 rps × 60s：命中率 ≥ 90%、P95 < 300ms、零 5xx | ❌ 未实现 |

**已落地的关键回归用例**（均对应本报告修复项，防止回归）：

- `volume_24h_quote` 才是我方 `volume24h`，`volume_24h`（合约张数）不得被当成成交额
- `contract_stats` 按 `time` 取**最新**一条（顺序打乱时同样成立）
- K 线字段映射不依赖位置下标，且按时间升序返回
- 止损基础 1.5%、结构位放宽上限 3%、次近关键位过远时不得把计划判死
- 支撑阻力不返回"现价 ×1.008/×0.992"这类合成位，且顺序为"离现价最近优先"
- 卡片"情绪行是否挂 ⚠"当且仅当 `fundingSignal !== NEUTRAL`（穷举 84 组费率×多空比）
- 量价行在无背离时永远为中性且文案含"量价正常"
- 未收盘 K 线必须剔除
- 完全横盘 RSI = 50、`rsiZone` 闭区间边界

**关键验收用例（指标对拍，尚未执行）**：用 BTC_USDT 2026-01-01 ~ 2026-08-31 日线 240 根，EMA/RSI/MACD 与 TradingView 偏差容忍：EMA < 0.05%、RSI < 0.5、MACD DIF/DEA < 0.01%。**该对拍仍待补齐**——当前为自洽性测试（内部一致性与边界），尚无外部基准对拍。

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
  - **额度计数落在 KV（V1.0.2 修订，审查项 F32）**：key 为 `ai:quota:{YYYY-MM-DD}`，写入时带到期时间。原实现只用模块级变量计数，随 isolate 重建清零、多实例各算一份，额度形同虚设。KV 为最终一致，因此这是"近似限额"而非严格限额；KV 不可用时退回进程内计数，不阻断主流程。

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
13. **首批 P0 修复（V1.0.2，对应代码审查报告）**：
    - **4.1 评分权重**：RSI 超买/超卖由 ±20 降为 ±10，避免强趋势被超买扣分抵消而误判为震荡。
    - **4.3 止损规则**：明确为"基础 1.5%，为躲开次近关键位可放宽但上限 3%"，消除原文"1.5%"与"SL < 次近支撑"的自相矛盾；原无上限实现会把合格计划判死。
    - **4.2 支撑阻力**：禁止构造纯由现价推导的价位（`现价 × 1.008/0.992`），动态补充位只允许使用 EMA99；无有效位时返回空数组并由前端显示占位符。
    - **4.3 指标输入**：所有指标基于**已收盘** K 线计算，剔除未收盘末根（原先会让量比、OBV 流向、地量/缩量判断全部失真）。
    - **5.1.1 文案一致性**：情绪行直接消费 `fundingSignal`（与徽标同源）；量价行无背离时输出"量价正常"且不挂警示；量价涨跌方向改用 `ticker.change24h`，不再用成交量变化率冒充。
    - **5.1.1 量价背离**：改用 `detectVolumePriceDivergence`（按"价格创 5 根新高/新低而 OBV 未同步"判定），废弃原先"RSI 极端 + OBV 流向"的自创规则。
    - **3.1 TickerDto.volume24h**：改用 `volume_24h_quote`（USDT 成交额）。原 `volume_24h` 是合约张数（= 基础币 ÷ `quanto_multiplier`），实测 BTC_USDT 少报 8.18 倍。
    - **3.1 多空比**：`contract_stats` 按时间升序返回，改取**最新**一条。原取 `rows[0]` 最旧记录，实测滞后 29 小时且会让卡片"偏多/中性"结论翻转。
    - **5.3 详情页交易计划**：删除前端自行估算价位的分支，`plan = null` 时只显示"观望：信号冲突 / 盈亏比不足"。
14. **第二批一致性修复（V1.0.2，对应代码审查报告 F11/F13/F15~F17/F21~F25）**：
    - **2.3 数组顺序契约**：明确 `support` 为**降序**、`resistance` 为**升序**，两者语义统一为"**离现价最近优先**"。原文档写"support 升序 / resistance 降序"，与实现及全部消费方（`buildTradePlan` 取 `[0]` 为最近位、图表画线、详情页关键价位）相反。
    - **2.3 RSI 边界**：`rsiZone` 明确为闭区间 `≥70 / ≤30`（原写 `>70 / <30`），并统一 `rsiZone()`、卡片 RSI 行、`extremeAlert`、详情页风险提示四处判定，消除"同一边界、两种结论"。
    - **5.1.1 RSI 行配色**：超卖改为绿色（原与超买同为红色）；行标签 `策略：` 更正为 `多周期：`。
    - **5.3 关键价位语义**：`即时支撑 / 关键支撑 / 下方风险位 / 上方阻力` 分别取 `support[0] / support[1] / support[最后] / resistance[0]`，四个标签对应四个不同价位。原实现三个标签渲染同一个"最远支撑"，且"即时支撑"实际最远。
    - **5.3 文案**：EMA 多头排列不得描述为"弱反弹偏空震荡"；突破/跌破提示必须使用现价之外的价位（原"站上 \<最近支撑\>"在价格已高于该支撑时恒为真，无信息量）。
    - **4.1 RSI 平坦序列**：`avgGain` 与 `avgLoss` 同时为 0（完全横盘）时 RSI 定义为 50。原返回 100，会把横盘误判为"超买"并扣分。
    - **4.1 周期秒数表**：补全 `30m / 1h / 4h / 8h / 1d`。原表只有 `1m/5m/15m`，而 `Home` 页会用 `1h` 拉取多周期对比数据，导致 1h K 线每根都被判为"缺口"、`dataQuality` 恒为 `INSUFFICIENT`。
15. **第三批工程化修复（V1.0.2，对应代码审查报告 F26/F36/F37/F39）**：
    - **根脚本全部失效（F26）**：`npm run test / build / dev:web / dev:worker` 与 `start.bat` / `start.sh` 使用了 `--workspace=shared|indicators|worker|web` 这类写法，npm 只接受**完整路径**或**包名**，实测全部报 `No workspaces found`。已统一改为 `--workspace=packages/xxx`。`typecheck` 由 `tsc -b`（根 tsconfig 的 references 缺少 `composite`，无法构建）改为四包串行 `tsc --noEmit`。
    - **缺少 ESLint 配置（F36）**：新增 `.eslintrc.cjs`（ESLint 8 eslintrc 格式）+ `eslint-plugin-react-hooks` 依赖；CI 增补 `npm run lint` 步骤。
    - **CI 隐式依赖（F36 附带）**：原 CI 的 "Typecheck" 步骤未加 `--noEmit`，靠其副作用产出 `packages/*/dist` 供测试解析依赖包（`dist` 已被 `.gitignore` 忽略）。现改为显式 `Build packages` 步骤 + 独立 `Typecheck`，不再依赖步骤顺序的副作用。
    - **测试覆盖（F37）**：新增 `packages/shared`（24 例）与 `apps/web`（19 例）的 Vitest 配置与用例，`packages/indicators` 由 34 例扩到 75 例并拆分为 5 个文件（新增 `macd` / `dataQuality` / `obv` / `pivots`），`apps/worker` 由 11 例扩到 29 例（新增 Gate.io 字段映射与 K 线契约）。总计 147 例。抽出了 `apps/web/src/lib/cardText.ts`，使卡片四行文案成为可单测的纯函数。
    - **`.gitignore`（F39）**：补 `*.tsbuildinfo`。
    - **第三批附带修复的三个实现缺陷**：
      - `stripSeparators` 的字符类里 `[` 未转义会让 `]` 提前闭合字符类，**正则静默失效**，所有分隔符都去不掉（改用 `\u005B\u005D` 并加注说明）。
      - `normalizeSymbol` 无法产出 `_PERP`（分隔符先被剥离），与自身校验正则 `^[A-Z0-9]{2,20}_(PERP|USDT|USD)$` 不一致。
      - `buildAlert` 的拥挤方向判定把**未达阈值**的费率当作方向依据：`rate=0.0001 / ratio=0.3` 时拥挤完全由"账户偏空"造成却返回 `LONG_HEAVY`，卡片会显示"多头拥挤，谨慎追高"，方向与多空比相反。现改为"多空比优先，其次已越界的费率"。
      - `macd` 在 DEA 预热期把 `dea` 写成 0，出现 `dif=14 / dea=0 / hist=0` 这类违反 `hist=(dif−dea)×2` 的三元组；现令预热期 `dea = dif`。
      - `assessDataQuality` 的异常跳变判定与**原始**前收比较，一根错误报价会连坐其后的恢复根（100→130→100 两根都被中性化）；现与已修正的前收比较。
16. **第四批修复（V1.0.2，对应代码审查报告 F19/F27/F28）**：
    - **MACD 信号新鲜度（F19，2.3 / 4.1）**：`MacdResult` 新增 `signalAge`（0=当根，1~3=保留期内，null=无信号）；评分改为当根 ±25、保留期内 ±10；详情页"核心依据"与 10 秒结论、AI Prompt 均须带上新鲜度措辞。
    - **candles 入参与缓存（F28，3.2）**：`interval` 走 `SUPPORTED_INTERVALS` 白名单（同时把该名单补齐到与 `intervalSeconds()` 一致，原名单只有 `1m/5m/15m` 而 Home 页需要 `1h`）；`limit` 夹到 `[1,500]` 且进入缓存 key；candles 成功时写入 last-known-good 降级缓存（原先只对 ticker 写入，失败分支永远 503）；构造上游 URL 时 symbol 与 interval 均做 `encodeURIComponent`。
    - **CORS 白名单（F27，3.2）**：原最后一行为 `return origin`，导致名单外的源也被原样回显；现名单外不输出 `Access-Control-Allow-Origin`。
    - **测试**：新增 `apps/worker/src/router.test.ts`（19 例，覆盖 interval 白名单、limit 夹取与缓存维度、candles 降级、CORS 白名单、错误路径）；`indicators` 增补 `signalAge` 与"白名单/周期表不得漂移"守卫。总计 174 例。
17. **第五批修复（V1.0.2，对应代码审查报告 F29/F30/F31/F32/F34）**：
    - **图表补齐 + 进场区（F34，5.3）**：补 RSI（30/70 虚线，纵轴固定 0~100）与 OBV（线 + MA20）副图、进场区半透明矩形、TP1/TP2/SL 价位线。进场区用 series primitive 绘制；计划价位只在引擎给出 `plan` 时绘制。
    - **图表数据层与引擎统一（F34 附带）**：新增 `components/Chart/chartData.ts`，复用 `ema / macd / rsi / obv / sma`，废弃图内自行重算的 MACD（与引擎 DEA 预热不一致、且画出贴 0 的假柱）。
    - **AI 兜底文案（F29，6.2）**：结论跟随规则引擎方向（不再硬编码"观望"），依据改为陈述真实指标值，关键位改取 `support[0]` / `resistance[0]`（原先用 min/max 取到最远一级，与"关键位"语义相反）。
    - **AI 面板落地渲染（F30，5.3）**：新增 `AiPanel` + `MarkdownView` + `lib/markdown.ts`；模型输出真正展示出来（此前每次进详情页都调用模型却从不渲染，纯烧额度）。Markdown 以 React children 渲染，不使用 `dangerouslySetInnerHTML`；“重新生成”带 60s 冷却倒计时。
    - **一致性校验落实（F31，2.4 / 6.1 / 6.2）**：Prompt 要求单独输出 `方向:` 一行；Worker 解析后写入 `signals.consensus` / `signals.trend`（AI 自己的方向）/ `signals.engineTrend`；UI 分歧时警示并以规则引擎为准。降级统一标记 `degraded` + `degradedReason`，UI 显示"规则引擎兜底"。
    - **AI 日额度落 KV（F32，10）**：计数键 `ai:quota:{date}`，跨实例、带到期；KV 异常退回进程内计数。
    - **测试**：新增 `apps/worker/src/ai.test.ts`（23 例）、`apps/web/src/components/Chart/chartData.test.ts`（18 例）、`apps/web/src/lib/markdown.test.ts`（15 例）。总计 230 例。
    - **仅靠渲染验证才发现的问题**：图表曾在 series 创建 `priceScaleId` 之前调用 `chart.priceScale(id).applyOptions(...)`，抛错导致整张图空白；typecheck 与单测都无法发现，最终用 headless Chrome 截图 + `--dump-dom` 抓取 window.onerror 定位。图表改动务必做一次真实渲染验证。
18. **第六批修复（V1.0.2，对应代码审查报告 F38 · 宏观模块去伪存真）**：
    - **清算热力图（原为 `Math.random()` 占位）**：改用 Gate.io `/futures/usdt/liq_orders` **真实强平成交订单**聚合。
      - 方向约定依据 Gate.io 官方 SDK：`size` 为仓位张数（带方向），`order_size` 为强平委托张数 —— **负数=卖出委托=多头被强平**，正数=买入委托=空头被强平。
      - 名义金额 = `|order_size| × quanto_multiplier × fill_price`；按现价的 0.1% 分桶。
      - Gate.io 限制单次 `from`/`to` 跨度 **≤ 1 小时**（实测超出返回 `INVALID_PARAM_VALUE`），故只取最近 1 小时窗口，并如实标注窗口、样本笔数与合计金额。
      - 取不到数据时返回 `live: false` + 空 `cells`，UI 显示"暂不可用"，**不再编造任何价位或金额**。横轴中心也不再硬编码（原先 BTC 固定 76000，与实盘相差约 9%）。
    - **资金费率（原"加权"实为算术平均）**：三个交易所的持仓量全部改为真实取数（Gate.io 由 `position_size × quanto_multiplier × mark_price` 折算，Binance/OKX 走各自 `/openInterest` 接口），加权因此成为真正的 OI 加权；全部 OI 缺失时退化为算术平均并**在 UI 上标注**，字段名随 `weightedByOpenInterest` 切换。
      年化改用各交易所**实际结算周期**（Gate.io 取 `funding_interval`，OKX 取相邻两期 `fundingTime`/`nextFundingTime` 之差），不再一律按 8 小时折算（4 小时结算的合约原先会被低估一半）。
      每个交易所单独返回 `ok`/`error`，失败者在面板上显式标为"不可用"并显示原因，不再静默拉低平均。
    - **净流动性（原为硬编码示例序列）**：改为实时拉取 FRED（`WALCL` / `WTREGEN` / `RRPONTSYD`，使用**无需 API Key** 的 `fredgraph.csv` 端点）。
      - 单位统一换算为十亿美元（WALCL/WTREGEN 原始单位为百万美元，RRPONTSYD 已是十亿美元），CSV 中的缺失值 `.` 按跳过处理而非当成 0。
      - 以 WALCL 的周频观测日为骨架，TGA/RRP 按日期取"不晚于该日"的最近观测对齐。
      - `weeklyChange` 改为与**约 7 天前**的观测点比较，并回传 `comparedTo` 让 UI 如实标注；原实现取 `history[length-3]`（半月频样本下实际跨度 26 天）却标成"较上周变动"。
      - 抓取失败时回退到 KV 中保留 7 天的"最近一次成功结果"，并在 UI 上以警示条说明其观测日；完全没有可用数据时显示"暂不可用"。**失败结果只短缓存 60 秒**，避免一次上游抖动让面板空白一小时。
    - **FOMC 快照**：`snapshotUpdatedAt` 改为**固定的录入时间常量**（原先用 `new Date().toISOString()` 冒充"录入时间"，让 UI 误以为刚刚更新过）；`lastDecision`/`lastDecisionBps` 由"已发生决议"列表按会议时间推导，不再硬编码，因此会随时间自然推进。
    - **宏观面板 UI**：资金费率着色改为按**拥挤度**（偏离越大越接近警示色），修正原先"正费率红、负费率绿"与涨跌配色相反的读法；三个面板改用 `usePolling`（原为裸 `setInterval`，页面不可见时仍在请求）；新增"暂不可用 / 陈旧数据"状态与数据源标注。
    - **时间格式统一**：新增 `formatBeijingTime` / `formatBeijingShort` / `formatBeijingFromIso`（固定 UTC+8 偏移）。此前详情页手写一套、宏观页用 `toLocaleString`、图表坐标轴又一套，口径不一致。
    - **测试**：新增 `apps/worker/src/macro.test.ts`（32 例）覆盖强平聚合/分桶/方向、OI 加权与退化、FRED CSV 解析与单位换算、对照日语义、FOMC 推导、日历紧迫度；`router.test.ts` 增补净流动性 last-known-good 兜底 2 例。总计 272 例。
    - **已知环境限制**：在本机 `workerd`（Miniflare）中 **FRED 不可达**（同环境下普通 Node 约 1.2s 可返回，Treasury FiscalData 与 NY Fed 亦可达，仅 `fred.stlouisfed.org` 超时）。生产 Cloudflare 边缘大概率可正常访问；代码在不可达时如实降级。若生产也不可达，可改用已验证可达的替代源（Treasury FiscalData 取 TGA、NY Fed 取 RRP、Fed H.4.1 取总资产），但 WALCL 无干净的免 Key 历史序列，需另行评估。

### 13.2 常用命令

```bash
npm install

# 本地开发（两个终端 / 或直接跑 start.bat、start.sh）
npm run dev:worker    # Worker（wrangler dev）
npm run dev:web       # 前端（vite）

npm test              # 四个包的全部单测（shared / indicators / worker / web）
npm run lint          # ESLint
npm run typecheck     # 四包类型检查
npm run build         # shared -> indicators -> worker(dry-run) -> web
```

> 注意：本项目使用 **npm**（仓库内为 `package-lock.json`，无 `pnpm-workspace.yaml`），早期文档中的 `pnpm` 命令已失效。
> E2E（Playwright）、性能基准、k6 压力测试与 `@cloudflare/vitest-pool-workers` 尚未接入，见第 8 章"现状"列。

### 13.3 参考资料

- Gate.io API v4: https://www.gate.io/docs/developers/apiv4/
- Lightweight Charts: https://tradingview.github.io/lightweight-charts/
- TechnicalIndicators: https://github.com/anandanand84/technicalindicators
- Cloudflare Workers AI: https://developers.cloudflare.com/workers-ai/