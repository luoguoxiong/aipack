-- aipack 监控库初始化 (ClickHouse 24.x)
-- 由 docker-entrypoint-initdb.d 在首次启动 clickhouse 容器时执行。

CREATE DATABASE IF NOT EXISTS aipack;

USE aipack;

-- ── runs ──────────────────────────────────────────────────────
-- MergeTree: 按 started_at 日期分区,ORDER BY 优化常用过滤(app_id + 时间 + trace_id)
-- TTL 90 天自动清理热表(Phase 8 冷归档)
CREATE TABLE IF NOT EXISTS runs (
  trace_id      String,
  app_id        LowCardinality(String),
  started_at    DateTime64(3),
  ended_at      DateTime64(3),
  session_key   LowCardinality(String),
  channel       LowCardinality(String),
  model         LowCardinality(String),
  version       LowCardinality(String),
  status        Enum('success' = 1, 'error' = 2, 'validation' = 3),
  error_class   LowCardinality(String),
  turns         UInt16,
  duration_ms   UInt32,
  active_ms     UInt32,
  queued_ms     UInt32,
  ttft_ms       UInt32,
  input_tokens  UInt32,
  output_tokens UInt32,
  cache_read    UInt32,
  cache_write   UInt32,
  cost_cents    UInt32                                       -- Phase 6 填充
) ENGINE = MergeTree
PARTITION BY toYYYYMMDD(started_at)
ORDER BY (app_id, started_at, trace_id)
TTL started_at + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;

-- ── spans ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS spans (
  id            UInt64,
  trace_id      String,
  app_id        LowCardinality(String),
  span_id       String,
  kind          Enum('run' = 1, 'model' = 2, 'tool' = 3),
  name          LowCardinality(String),
  started_at    DateTime64(3),
  duration_ms   UInt32,
  status        Enum('ok' = 1, 'error' = 2),
  error_class   LowCardinality(String),
  attempts      UInt16,
  input_tokens  UInt32,
  output_tokens UInt32,
  cache_read    UInt32,
  cache_write   UInt32,
  session_key   LowCardinality(String),
  cost_cents    UInt32                                       -- Phase 6
) ENGINE = MergeTree
PARTITION BY toYYYYMMDD(started_at)
ORDER BY (app_id, trace_id, started_at, span_id)
TTL started_at + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;

-- ── tool_calls ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tool_calls (
  id           UInt64,
  trace_id     String,
  app_id       LowCardinality(String),
  span_id      String,
  tool_name    LowCardinality(String),
  status       Enum('ok' = 1, 'error' = 2, 'blocked' = 3, 'skipped' = 4),
  duration_ms  UInt32,
  error_class  LowCardinality(String),
  started_at   DateTime64(3)                                 -- 工具调用开始时刻(由 span 推导)
) ENGINE = MergeTree
PARTITION BY toYYYYMMDD(started_at)
ORDER BY (app_id, trace_id, tool_name, started_at)
TTL started_at + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;

-- ── events (自定义业务事件) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS events (
  id          UInt64,
  trace_id    String,
  app_id      LowCardinality(String),
  session_key LowCardinality(String),
  name        LowCardinality(String),
  data        String,                                        -- JSON 字符串
  ts          DateTime64(3)
) ENGINE = MergeTree
PARTITION BY toYYYYMMDD(ts)
ORDER BY (app_id, trace_id, ts)
TTL ts + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;

-- ── retry_attempts ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS retry_attempts (
  id           UInt64,
  trace_id     String,
  app_id       LowCardinality(String),
  span_id      String,
  provider     LowCardinality(String),
  model_id     LowCardinality(String),
  attempt      UInt16,
  error_class  LowCardinality(String),
  status       UInt16,                                       -- HTTP 状态码
  delay_ms     UInt32,
  ts           DateTime64(3)
) ENGINE = MergeTree
PARTITION BY toYYYYMMDD(ts)
ORDER BY (app_id, trace_id, ts)
TTL ts + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;

-- ── alert_events (告警触发/恢复历史,Phase 1 也写 MySQL,CH 侧用于长周期分析) ──
CREATE TABLE IF NOT EXISTS alert_events (
  id          UInt64,
  rule_id     String,
  rule_name   String,
  app_id      LowCardinality(String),
  metric      LowCardinality(String),
  operator    LowCardinality(String),
  threshold   Float64,
  value       Float64,
  status      Enum('fired' = 1, 'recovered' = 2),
  created_at  DateTime64(3)
) ENGINE = MergeTree
PARTITION BY toYYYYMMDD(created_at)
ORDER BY (created_at, rule_id)
TTL created_at + INTERVAL 365 DAY                            -- 告警历史留 1 年
SETTINGS index_granularity = 8192;

-- ── 物化视图:按应用+模型预聚合(可选,优化 dashboard 查询) ─────
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_runs_by_app_model
ENGINE = SummingMergeTree
PARTITION BY toYYYYMMDD(day)
ORDER BY (app_id, model, day)
TTL day + INTERVAL 365 DAY
AS
SELECT
  app_id,
  model,
  toDate(started_at) AS day,
  count()             AS requests,
  sum(if(status = 'success' AND error_class = '', 1, 0)) AS success,
  sum(input_tokens + output_tokens + cache_read + cache_write) AS tokens,
  sum(cost_cents)    AS cost_cents
FROM runs
GROUP BY app_id, model, day;

-- ── trace_archive (Phase 8：冷归档 S3 引擎表) ─────────────────
-- 映射到 S3 上的 Parquet 文件，供超过 90 天 TTL 的冷数据查询。
-- 注意：此处的 S3 URL 为占位符，实际 URL 与凭证应在运行时通过 CH 配置注入
-- （如 <s3><aipack-archive>...</aipack-archive></s3> 或 s3 表函数参数）。
-- 建议生产环境使用通配路径（如 https://s3.amazonaws.com/aipack-archive/runs-*.parquet）
-- 以读取归档调度器导出的多个分片文件。
CREATE TABLE IF NOT EXISTS trace_archive (
  trace_id      String,
  app_id        LowCardinality(String),
  started_at    DateTime64(3),
  ended_at      DateTime64(3),
  session_key   LowCardinality(String),
  channel       LowCardinality(String),
  model         LowCardinality(String),
  version       LowCardinality(String),
  status        Enum('success' = 1, 'error' = 2, 'validation' = 3),
  error_class   LowCardinality(String),
  turns         UInt16,
  duration_ms   UInt32,
  active_ms     UInt32,
  queued_ms     UInt32,
  ttft_ms       UInt32,
  input_tokens  UInt32,
  output_tokens UInt32,
  cache_read    UInt32,
  cache_write   UInt32,
  cost_cents    UInt32
) ENGINE = S3('https://s3.amazonaws.com/aipack-archive/', 'Parquet');

-- 创建默认用户(若未通过环境变量创建)
-- 注:CLICKHOUSE_USER 环境变量已创建用户,此处仅授权
GRANT SELECT, INSERT, ALTER, CREATE, DROP, TRUNCATE ON aipack.* TO IF EXISTS 'aipack'@'%';
