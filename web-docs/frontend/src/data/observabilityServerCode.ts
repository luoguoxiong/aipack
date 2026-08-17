// observability-server 文档代码示例

// ── 1. 快速启动 ────────────────────────────────────────────────
export const obsServerQuickstartCode = `# 1. 复制配置文件并修改
cp packages/observability-server/.env.example packages/observability-server/.env

# 2. 启动服务（零依赖模式：SQLite + 内存聚合）
pnpm --filter @aipack-ai/observability-server dev

# 3. 访问管理面板
#   浏览器打开 http://localhost:8787
#   默认用户名：admin（密码在启动日志中自动生成或 ADMIN_PASS 配置）

# 4. 构建生产版本
pnpm --filter @aipack-ai/observability-server build
# 构建产物内置面板：GET / 直接返回管理界面`;

// ── 2. 客户端接入（一行注入） ─────────────────────────────────
export const obsServerClientCode = `import { createRuntime } from '@aipack-ai/core';
import { createObservability } from '@aipack-ai/observability';

// 1. 创建可观测性实例（配置 appId + 收集服务地址）
const obs = createObservability({
  appId: 'travel-app',
  appSecret: 'sk-travel123',      // 与 OBS_APPS 白名单或面板创建的凭证匹配
  endpoint: 'http://localhost:8787', // 默认值，可省略
});

// 2. 注入 Runtime，所有埋点自动上报
const runtime = createRuntime({
  provider: /* ... */,
  telemetry: obs.telemetry,  // 一行注入
});

// 3. 上报失败自动写入本地缓存（.aipack/observability/{appId}.json）
//    收集服务恢复后 SDK 自动补报，无需手动处理`;

// ── 3. 作为库嵌入 ─────────────────────────────────────────────
export const obsServerLibraryCode = `import {
  createCollector,
  createCollectorServer,
  loadConfig,
} from '@aipack-ai/observability-server';

// 方式 A：直接启动独立服务（读取 process.env）
const config = loadConfig();
const server = await createCollectorServer(config);
await server.listen();
// → http://localhost:8787 (面板 + 上报 + API)

// 方式 B：嵌入现有 Koa/Express 应用
const collector = await createCollector({
  dbPath: './data/obs.db',
  seedApps: { 'my-app': 'sk-xxx' },
  admin: { username: 'admin', password: 'admin123' },
});

// 挂载到 Koa：
app.use(async (ctx, next) => {
  if (ctx.path.startsWith('/api/collect') || ctx.path.startsWith('/metrics/')) {
    await collector.handle(ctx.req, ctx.res);
    ctx.respond = false;
  } else {
    await next();
  }
});`;

// ── 4. 平台级部署（MySQL + ClickHouse + Kafka + Redis） ─────
export const obsServerInfraCode = `# packages/observability-server/infra/docker-compose.yml
# 一键启动 MySQL/ClickHouse/Kafka/Redis/ZooKeeper

# 对应 .env 配置：
BUSINESS_STORE=mysql
MYSQL_URL=mysql://aipack:aipackpass@localhost:3306/aipack

TRACE_STORE=clickhouse
CLICKHOUSE_URL=http://localhost:8123

MQ_ENABLED=true
KAFKA_BROKERS=localhost:9094

AGGREGATOR=hybrid   # L1 本地(1min) + L2 Redis(60min)，推荐生产
REDIS_URL=redis://:aipackpass@localhost:6379

RATE_LIMIT_BACKEND=redis
INGEST_RATE=1000

AUTH_MODE=multi
ADMIN_PASS=your_strong_password
JWT_SECRET=$(openssl rand -hex 32)

# 启动中间件容器
cd packages/observability-server
docker compose -f infra/docker-compose.yml --env-file .env up -d

# 启动服务
pnpm --filter @aipack-ai/observability-server dev`;

// ── 5. Metrics API 示例 ───────────────────────────────────────
export const obsServerMetricsCode = `// ====== 聚合摘要（summary） ======
// GET /metrics/summary?since=1710000000000&until=1710003600000&groupBy=model
{
  "requests": 1280,
  "successRate": 0.974,
  "totalTokens": 3421800,
  "p50Ms": 820,
  "p95Ms": 2410,
  "p99Ms": 5800,
  "avgTurns": 4.2,
  "retryRate": 0.083,
  "permissionDenied": 12,
  "costTotal": 2845,   // 总费用（分），Phase 6
  "errorClasses": {
    "ModelRateLimitError": 23,
    "ToolNotFoundError": 5
  }
}

// ====== 时间序列（timeseries） ======
// GET /metrics/timeseries?step=300000&metric=requests
[
  { "t": 1710000000000, "v": 128 },
  { "t": 1710000300000, "v": 156 },
  { "t": 1710000600000, "v": 142 }
]

// ====== Trace 列表 ======
// GET /traces?page=1&pageSize=20&status=error
{
  "page": 1, "pageSize": 20, "total": 47,
  "items": [
    {
      "traceId": "01HR...",
      "appId": "travel-app",
      "startedAt": 1710000000000,
      "durationMs": 3420,
      "status": "error",
      "errorClass": "ModelRateLimitError",
      "tokens": { "input": 1280, "output": 342 },
      "parentTraceId": "01HQ...",  // W3C 跨系统链路
      "w3cTraceId": "4bf9..."
    }
  ]
}

// ====== 错误归因下钻 ======
// GET /metrics/error-classes/ModelRateLimitError?since=...
{
  "errorClass": "ModelRateLimitError",
  "count": 23,
  "modelDistribution": { "gpt-4o": 18, "claude-3-opus": 5 },
  "toolDistribution": { "search_hotel": 12, "book_flight": 11 },
  "recentTraces": [ /* 最近 N 条 traceId + 摘要 */ ]
}`;

// ── 6. 告警规则配置 ───────────────────────────────────────────
export const obsServerAlertCode = `// 创建告警规则：POST /api/projects/:projectId/alerts
{
  "name": "P95 耗时超阈值",
  "metric": "p95Ms",           // 成功率/P95/重试率/Tokens/请求量/工具成功率等
  "operator": "gt",            // lt | lte | gt | gte | regress_by
  "threshold": 3000,           // 3 秒
  "lookbackMs": 900000,        // 回看 15 分钟
  "cooldownMs": 600000,        // 触发后冷却 10 分钟
  "appId": "travel-app",       // 可选，缺省=全局
  "webhookUrl": "https://oapi.dingtalk.com/robot/send?..."
}

// 版本回归规则（对比最近两个版本）
{
  "name": "新版本成功率退化",
  "metric": "versionSuccessRate",
  "operator": "regress_by",
  "threshold": 0.05,           // 成功率下降超过 5% 触发
  "lookbackMs": 3600000
}

// 工具级规则
{
  "name": "search_hotel 成功率低于 90%",
  "metric": "toolSuccessRate",
  "operator": "lt",
  "threshold": 0.90,
  "toolName": "search_hotel"   // toolSuccessRate 必须指定工具
}

// 支持的通知目标（JSON POST webhook）：
//   - 企业微信机器人
//   - Slack Incoming Webhook
//   - 飞书自定义机器人
//   - 自建 HTTP 回调`;

// ── 7. 成本管理（Phase 6） ────────────────────────────────────
export const obsServerCostCode = `// 模型价格 CRUD
// POST /metrics/model-prices
{
  "model": "gpt-4o",
  "inputPricePer1k": 0.025,   // 输入 $0.025 / 1K tokens
  "outputPricePer1k": 0.10,   // 输出 $0.10 / 1K tokens
  "currency": "USD",
  "effectiveAt": 1710000000000 // 生效时间（可选，缺省立即）
}

// 成本聚合：GET /metrics/cost?since=...&until=...&groupBy=model
{
  "totalCostCents": 2845,          // 总费用 28.45 美元（cent 单位）
  "byModel": {
    "gpt-4o": { "costCents": 1920, "tokens": 2100000 },
    "claude-3-opus": { "costCents": 925, "tokens": 680000 }
  }
}

// ingest-worker 在 span 落盘前自动调用 CostCalculator：
// costCents = (inputTokens/1000 * inputPrice) + (outputTokens/1000 * outputPrice)
// 结果写入 span 记录，同时被 aggregator 累计到 costTotal`;

// ── 8. 冷数据归档（Phase 8） ──────────────────────────────────
export const obsServerArchiveCode = `// ArchiveScheduler 每日自动运行：
//   - 91~180 天数据从 ClickHouse 导出为 Parquet
//   - 上传到 S3 / OSS 等对象存储
//   - trace_archive 表使用 S3 Engine，长周期查询自动路由

// 配置：
// CLICKHOUSE init.sql 中定义 trace_archive：
//   ENGINE = S3(
//     'https://s3.amazonaws.com/bucket/aipack-archive/*.parquet',
//     Parquet
//   )

// 手动触发出：
import { exportToParquet, createArchiveScheduler } from '@aipack-ai/observability-server';

const result = await exportToParquet({
  clickhouse: chClient,
  s3: { bucket: 'my-bucket', prefix: 'aipack-archive/' },
  daysAgoStart: 91,
  daysAgoEnd: 180,
});
// result = { exportedRows: 1_234_567, parquetFiles: 42, s3Path: 's3://...' }

// 定时任务：
const scheduler = createArchiveScheduler({
  clickhouse: chClient,
  s3Config: { /* ... */ },
  runAtHour: 3,   // 每日凌晨 3 点
});
scheduler.start();`;
