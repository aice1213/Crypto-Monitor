-- 价格异动通知（推送服务）初始化迁移
-- 开发交付文档 V1.1.0 §10.3 D1 表结构
-- 表：push_targets / push_channels / push_logs / rv_cache_backup

-- 推送标的目标与条件（条件以 JSON 存储，便于演进不改表）
CREATE TABLE IF NOT EXISTS push_targets (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  exchange TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  conditions_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(symbol, exchange)
);

-- 推送通道配置（Webhook 与签名密钥 AES-GCM 加密存储）
CREATE TABLE IF NOT EXISTS push_channels (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  group_name TEXT,
  webhook_enc TEXT NOT NULL,
  sign_enc TEXT,
  keyword TEXT,
  security_type TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'OK',
  updated_at INTEGER NOT NULL
);

-- 推送日志（结构化，供查询与复盘）
CREATE TABLE IF NOT EXISTS push_logs (
  id TEXT PRIMARY KEY,
  target_id TEXT,
  symbol TEXT,
  channel_type TEXT,
  channel_id TEXT,
  trigger_type TEXT,
  trigger_mode TEXT,
  price REAL,
  change_percent REAL,
  key_price REAL,
  threshold_used REAL,
  multiplier_used REAL,
  result TEXT,
  error_code TEXT,
  error_msg TEXT,
  ts INTEGER NOT NULL
);

-- 日志查询索引
CREATE INDEX IF NOT EXISTS idx_logs_ts ON push_logs(ts);
CREATE INDEX IF NOT EXISTS idx_logs_symbol ON push_logs(symbol, ts);

-- RV 推荐阈值备份（KV 失效时兜底，文档 §10.1）
CREATE TABLE IF NOT EXISTS rv_cache_backup (
  symbol TEXT PRIMARY KEY,
  rv20 REAL,
  btc_rv20 REAL,
  multiplier REAL,
  recommended_threshold REAL,
  source TEXT,
  computed_at INTEGER NOT NULL
);
