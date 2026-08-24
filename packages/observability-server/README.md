# @aipack-ai/observability-server — aipack 可观测性收集服务（S2）

接收各应用 SDK（`@aipack-ai/observability`）的埋点上报，完成 **落盘 + 聚合 + REST 查询 + Web 面板**。

## 两种运行模式

| | 简单模式（默认） | 平台模式 |
|---|---|---|
| 落盘 | SQLite 同步写 | Kafka 解耦 → worker 批量写 ClickHouse |
| 聚合 | 进程内 memory | Redis / hybrid（L1+L2，多实例共享） |
| 业务库 | SQLite | MySQL（多用户 RBAC / 项目 / Agent 定义 / 价格库） |
| 依赖 | 零依赖 | Docker 起 MySQL/CH/Kafka/Redis（见 [infra/README.md](infra/README.md)） |
| 适用 | 本地开发、单实例 | 生产、横向扩展 |

```
简单模式:  SDK ──► collector(HTTP :8787) ──► SQLite

平台模式:  SDK ──► collector ──► Kafka(aipack.ingest) ──► ingest-worker ──► ClickHouse
                                          (削峰解耦)        │
                                                            ├─ 成本计算(Phase 6)
                                                            └─ 喂聚合器(Phase 7, Redis)
```

## 快速开始（简单模式）

```bash
cd packages/observability-server
cp .env.example .env    # 可选：改 ADMIN_PASS / OBS_APPS
pnpm --filter @aipack-ai/observability-server dev
```

启动后：

- **面板**：http://localhost:8787 （登录 `ADMIN_USER` / `ADMIN_PASS`，默认 admin/admin123）
- **上报**：`POST http://localhost:8787/api/v1/ingest`
- **健康检查**：`GET /healthz`
- 数据落在 `./.aipack/collector.db`（由 `DB_PATH` 控制）

> 带面板的构建产物：`pnpm --filter @aipack-ai/observability-server build && pnpm --filter @aipack-ai/observability-server start`（`GET /` 直接返回面板，无需另起前端）。

## 平台模式

### 1. 起基础设施（MySQL / ClickHouse / Kafka / Redis）

```bash
cd packages/observability-server
docker compose -f infra/docker-compose.yml --env-file .env up -d
# 验证：docker compose -f infra/docker-compose.yml ps  → 5 容器 healthy
```

### 2. 切换 .env 配置

取消"应用连接配置"段对应注释：

```env
TRACE_STORE=clickhouse
CLICKHOUSE_URL=http://localhost:8123

MQ_ENABLED=true
KAFKA_BROKERS=localhost:9094

AGGREGATOR=hybrid                       # 推荐：L1 内存 + L2 Redis
REDIS_URL=redis://:aipackpass@localhost:6379

BUSINESS_STORE=mysql                    # 可选：多用户 RBAC
MYSQL_URL=mysql://aipack:aipackpass@localhost:3306/aipack
```

### 3. 起两个进程（各开一个终端）

```bash
# 终端 1：API 服务（收上报 → 投 Kafka；面板/查询同端口）
pnpm --filter @aipack-ai/observability-server dev

# 终端 2：消费 worker（Kafka → ClickHouse）
pnpm --filter @aipack-ai/observability-server worker
```

## ingest-worker

独立消费进程（生产用 bin `observability-worker`，开发用 `pnpm ... worker`）：

- **职责**：消费 Kafka topic `aipack.ingest` → 按 appId 合并 batch → 成本计算 → `TraceStore.flush` 批量写 CH → 喂聚合器
- **容错链**：单条解析失败（毒丸）直接进 DLQ；flush 失败指数退避重试（500ms 起步、上限 10s，`KAFKA_MAX_RETRIES` 默认 3 次）→ 整批进 DLQ；DLQ 发送失败落本地 outbox（JSONL）定期重放；DLQ 速率超 10 条/60s 告警日志
- **横向扩展**：多实例共用 `KAFKA_GROUP_ID`，Kafka 自动 rebalance 分配 partition（topic 默认 6 分区 = 并发上限）
- **前置条件**：`MQ_ENABLED=true` 且 `TRACE_STORE=clickhouse`，否则启动即报错退出（SQLite 模式 collector 同步落盘，worker 无意义）

worker 专属变量（与 collector 共用 .env）：`KAFKA_CONSUMER_BATCH`（单批最大消息数，默认 500）、`KAFKA_CONSUMER_WAIT`（攒批超时 ms，默认 1000）、`KAFKA_FROM_BEGINNING`、`KAFKA_MAX_RETRIES`。

## 脚本清单

| 脚本 | 说明 |
|---|---|
| `pnpm --filter @aipack-ai/observability-server dev` | tsx 直跑 src（API 服务） |
| `pnpm --filter @aipack-ai/observability-server worker` | tsx 直跑 ingest-worker |
| `pnpm --filter @aipack-ai/observability-server build` | tsup 构建 + vite 构建面板（产物 dist/） |
| `pnpm --filter @aipack-ai/observability-server start` | 跑构建产物 dist/main.js |
| `pnpm --filter @aipack-ai/observability-server test` | 单测（node --test） |
| `pnpm --filter @aipack-ai/observability-server typecheck` | 类型检查（主包 + web） |

## 客户端接入

应用侧配置环境变量（参考 `apps/ai_travel_agent/.env`）：

```env
OBS_APP_ID=app_xxx
OBS_APP_SECRET=sk_xxx
OBS_ENDPOINT=http://localhost:8787
```

或代码注入：

```ts
import { createObservability } from '@aipack-ai/observability';

const obs = createObservability({
  appId: 'travel-app',
  appSecret: 'sk-travel123',        // 与服务端 app 白名单匹配
  endpoint: 'http://localhost:8787',
});
createRuntime({ ..., telemetry: obs.telemetry });
```

> appId/appSecret 可在面板"应用管理"里动态创建（生成 `app_*` / `sk_*`），或启动前用 `OBS_APPS=appId:appSecret` 种入（已存在则跳过）。
> 上报失败自动写入本地缓存（`./.aipack/observability/{appId}.json`），收集服务恢复后自动补报。

## 查询 API

| 端点 | 说明 |
|---|---|
| `GET /healthz` | 健康检查（探测实际 trace store） |
| `GET /metrics/summary?since&until&groupBy=model\|tool\|session` | 聚合摘要（requests/successRate/totalTokens/p50/p95/p99/retryRate） |
| `GET /metrics/timeseries?since&until&step&metric` | 时间序列 |
| `GET /metrics/tools?since&until` | 工具成功率排行（升序） |
| `GET /metrics/versions?since&until` | 版本对比 |
| `GET /metrics/cost?since&until` | 成本统计（模型用量计价） |
| `GET /metrics/error-classes?since&until` | 错误归类 |
| `GET /metrics/model-prices` / `POST` | 模型价格查询 / 维护 |
| `GET /traces?since&until&status&model&tool&page` | 运行列表 |
| `GET /traces/:traceId` | Trace 明细（spans 时间线） |

面板管理接口（JWT 鉴权）：`/api/auth/*`、`/api/apps`、`/api/projects`、`/api/users/*`、`/api/alerts/*`。

## 配置

完整变量见 [.env.example](.env.example)（分段注释齐全），常用项：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `DB_PATH` | `.aipack/collector.db` | SQLite 文件（简单模式） |
| `ADMIN_USER` / `ADMIN_PASS` | admin / 自动生成 | 面板登录凭证 |
| `SESSION_SECRET` | 派生 | 面板会话签名（推荐显式配置） |
| `OBS_APPS` | 可选 | 启动种入的 appId:appSecret 白名单，逗号分隔 |
| `RETENTION_DAYS` | `30` | 明细保留天数（<=0 禁用清理） |
| `ALERTS_ENABLED` | `true` | 告警评估器（`ALERTS_WEBHOOK_URL` 配通知） |
| `INGEST_RATE` | `100` | 每应用上报限流（个/秒，<=0 关闭） |
| `TLS_KEY` / `TLS_CERT` | - | 都配置时启用 HTTPS |
| `TRACE_STORE` | `sqlite` | `sqlite` / `clickhouse` / `dual`（双写灰度迁移） |
| `MQ_ENABLED` | `false` | true 走 Kafka 解耦（需另起 worker） |
| `AGGREGATOR` | `memory` | `memory` / `redis` / `hybrid` |
| `AUTH_MODE` | `multi` | 多用户 RBAC（JWT access/refresh + Cookie） |

## 数据模型

- `runs`：一次 run/stream（trace 根，含 `costCents` 成本累加）
- `spans`：run / model / tool 时间线（model span 含 attempts/tokens/session_key/costCents）
- `tool_calls`：工具调用明细
- 权限拦截仅计入聚合计数（`summary.permissionDenied`），不落库

## 相关文档

- [infra/README.md](infra/README.md) — Docker 基础设施（服务清单 / 端口冲突 / 调试命令 / 生产注意事项）
- worker 源码头部注释：[src/worker/ingest-worker.ts](src/worker/ingest-worker.ts)（配置项与错误处理详述）
