# observability-server 平台化实施计划

> **目标**：将 `@aipack-ai/observability-server` 从单进程 MVP 升级为平台型分布式可观测服务。
>
> **架构选型**（已确认）：
> - 部署形态：平台型分布式（多实例横向扩展）
> - 业务库：MySQL（用户 / 项目 / Agent 定义 / ACL）
> - 监控库：ClickHouse（明细 Trace / Token / Cost / Metrics）
> - MQ：Kafka（解耦 ingest 与落盘）
> - 共享状态：Redis（聚合窗口 + 限流计数）
>
> **核心原则**：
> 1. 接口先行 — 所有新组件通过抽象接口注入，`SQLiteStore` 始终保留为零依赖默认实现
> 2. 向后兼容 — 现有 SDK 协议（`POST /api/v1/ingest`）不变；现有 env 配置继续生效
> 3. 双写迁移 — SQLite → MySQL/CH 切换期支持双写比对，验证一致后切流
> 4. 渐进可观测 — 每阶段独立可发布、可回滚

---

## 1. 目标架构拓扑

```
                    ┌──────────────────────────────────────────┐
                    │              Agent 应用层                 │
                    │  (travel-agent / office-agent / ...)     │
                    └────────────────┬─────────────────────────┘
                                     │ createObservability({ appId, appSecret })
                                     ↓
                    ┌──────────────────────────────────────────┐
                    │  @aipack-ai/observability (SDK)          │
                    │  HttpReporter + 本地缓存补报 + OTLP 旁路 │
                    └────────────────┬─────────────────────────┘
                                     │ POST /api/v1/ingest (HTTPS + 限流)
                                     ↓
                    ┌──────────────────────────────────────────┐
                    │  Collector (无状态, 可水平扩展)            │  ← Phase 7
                    │  - 鉴权 (appId+Secret → MySQL apps)       │
                    │  - 限流 (Redis 令牌桶)                    │
                    │  - 写 Kafka topic (不落本地)              │
                    └────────────────┬─────────────────────────┘
                                     │ produce aipack.ingest
                                     ↓
                    ┌──────────────────────────────────────────┐
                    │           Kafka (aipack.ingest)           │  ← Phase 3
                    │   partitions=N, retention=7d              │
                    └────────────────┬─────────────────────────┘
                                     │ consume (consumer group)
                                     ↓
                    ┌──────────────────────────────────────────┐
                    │  Ingest Worker (无状态, 可水平扩展)        │  ← Phase 3
                    │  - 批量消费 → ClickHouse 批量 INSERT      │
                    │  - 喂 Redis 聚合器（共享滑动窗口）         │
                    │  - 失败 → DLQ topic                       │
                    └──────┬─────────────────────┬─────────────┘
                           │                     │
                           ↓                     ↓
            ┌──────────────────────┐  ┌──────────────────────────┐
            │   MySQL (业务库)      │  │   ClickHouse (监控库)     │  ← Phase 1/2
            │  users / projects     │  │  runs / spans /          │
            │  project_apps         │  │  tool_calls / events /   │
            │  agent_definitions    │  │  retry_attempts /        │
            │  acl / model_prices   │  │  alert_events            │
            └──────────┬────────────┘  └──────────┬───────────────┘
                       │                          │
                       │     ┌────────────────────┘
                       │     │ Redis (聚合窗口 + 限流)
                       │     │   ← Phase 7
                       ↓     ↓
            ┌──────────────────────────────────────────────────┐
            │           Query API (无状态, 可水平扩展)           │
            │  /metrics/*  /traces/*  /api/apps  /api/agent-*   │
            │  /api/auth/*  /api/projects/*  /api/users/*       │
            └──────────────────────┬───────────────────────────┘
                                   ↓
            ┌──────────────────────────────────────────────────┐
            │              Dashboard (React + Antd)            │
            │  Dashboard / Traces(瀑布图) / Alerts / Apps /     │
            │  Projects / AgentDefs / Users / Cost             │
            └──────────────────────────────────────────────────┘
```

---

## 2. 现有抽象盘点（切入点）

| 抽象 | 现状 | 复用度 |
|---|---|---|
| `TraceStore` 接口 | ✅ 已抽象（[store.ts#L58](file:///Users/peroluo/Document/github/aipack/packages/observability-server/src/store.ts#L58)），含 `insertRun/Span/ToolCall/queryRuns/queryTrace/flush/prune/backup` | 高 — 新增 `ClickHouseTraceStore` 实现即接入 |
| `AppStore` 接口 | ✅ 已抽象（[store.ts#L76](file:///Users/peroluo/Document/github/aipack/packages/observability-server/src/store.ts#L76)），含 `createApp/listApps/verifyApp/regenerateSecret/seedApps` | 高 — 新增 `MySQLAppStore` 实现即接入 |
| `AlertStore` 接口 | ✅ 已抽象（[store.ts#L127](file:///Users/peroluo/Document/github/aipack/packages/observability-server/src/store.ts#L127)） | 高 — 新增 `MySQLAlertStore` |
| `Aggregator` | 🟡 进程内 `Map`（[aggregator.ts](file:///Users/peroluo/Document/github/aipack/packages/observability-server/src/aggregator.ts)） | 中 — 需抽 `Aggregator` 接口，新增 `RedisAggregator` |
| `SessionManager` | ✅ 已支持无状态 HMAC（[auth.ts](file:///Users/peroluo/Document/github/aipack/packages/observability-server/src/auth.ts)） | 高 — 扩展为 `UserStore` + JWT |
| `HttpReporter` | ✅ SDK 侧，含缓存补报（[reporter.ts](file:///Users/peroluo/Document/github/aipack/packages/observability-server/src/reporter.ts)） | 不动 — 协议层不变 |
| `EventBatch` | ✅ 协议稳定（[observability/types.ts](file:///Users/peroluo/Document/github/aipack/packages/observability/src/types.ts)） | 不动 — Kafka 透传 |
| `CollectorOptions` | ✅ 依赖注入风格（[collector.ts#L49](file:///Users/peroluo/Document/github/aipack/packages/observability-server/src/collector.ts#L49)） | 高 — 增加可选字段切换后端 |

**关键结论**：现有代码 90% 的接口抽象已就位，新组件只需"插桩式"实现接口，collector 通过 `opts` 注入即可切换，无需大改主流程。

---

## 3. 阶段任务分解

### Phase 0 — 基础设施（docker-compose）

**目标**：本地一键拉起 MySQL + ClickHouse + Kafka + Redis + Zookeeper，作为后续阶段开发与测试依赖。

**任务**：
- [ ] 新建 `infra/docker-compose.yml`，编排 5 个服务
- [ ] 新建 `.env.example`（容器变量+应用连接配置；单一 .env 供应用与 compose 共用）
- [ ] 新建 `infra/README.md`（启动/停止/重置命令）
- [ ] ClickHouse 初始化 schema（`infra/clickhouse/init.sql`）
- [ ] MySQL 初始化 schema（`infra/mysql/init.sql`）
- [ ] Kafka topic 创建脚本（`infra/kafka/create-topics.sh`）

**涉及文件**（新增）：
```
infra/
├── docker-compose.yml
├── .env.example
├── README.md
├── clickhouse/init.sql
├── mysql/init.sql
└── kafka/create-topics.sh
```

**依赖**：无（最先做）

**验证**：`docker compose up -d` 后 5 容器 health 全绿；`clickhouse-client` 能查 `system.tables`；`mysql` 能连；`kafka-topics --list` 能看到 `aipack.ingest`。

**回滚**：`docker compose down -v` 删卷即可，对主仓代码零影响。

---

### Phase 1 — MySQL 业务库（users / projects / Agent 定义 / ACL）

**目标**：把 `apps` 表从 SQLite 迁到 MySQL；新增用户/项目/Agent定义/ACL 五张表；提供 `MySQLAppStore` / `MySQLUserStore` / `MySQLProjectStore` / `MySQLAgentDefinitionStore` / `MySQLAclStore` 五个实现。

**任务**：
- [ ] 抽离 `AppStore` 接口到独立文件 `src/stores/app-store.ts`（从 store.ts 拆出）
- [ ] 新增 `src/stores/user-store.ts`：`UserStore` 接口 + `SQLiteUserStore`（零依赖默认）+ `MySQLUserStore`
- [ ] 新增 `src/stores/project-store.ts`：`ProjectStore` 接口 + 双实现
- [ ] 新增 `src/stores/agent-definition-store.ts`：`AgentDefinitionStore` 接口 + 双实现（含 version 字段，支持 publish/rollback）
- [ ] 新增 `src/stores/acl-store.ts`：`AclStore` 接口（role: owner|editor|viewer）+ 双实现
- [ ] 新增 `src/stores/mysql.ts`：连接池（`mysql2/promise`）+ 迁移 runner
- [ ] 新增 `src/stores/migrations/` 目录：编号化 SQL 迁移文件
- [ ] 修改 `config.ts`：新增 `MYSQL_URL` / `BUSINESS_STORE=sqlite|mysql` 配置
- [ ] 修改 `collector.ts`：`opts` 增加 `appStore?` / `userStore?` 等可选注入，缺省回落 SQLite
- [ ] 修改 `admin.ts`：app 管理端点改走注入的 `AppStore`（去 SQLiteStore 强类型依赖）
- [ ] 密码哈希：`src/auth/password.ts`（argon2id，带 salt）

**MySQL Schema**（`infra/mysql/init.sql`）：
```sql
CREATE TABLE users (
  id            CHAR(26) PRIMARY KEY,            -- ULID
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,           -- argon2id
  name          VARCHAR(100),
  created_at    BIGINT NOT NULL,
  UNIQUE INDEX uk_email (email)
);

CREATE TABLE projects (
  id          CHAR(26) PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  owner_id    CHAR(26) NOT NULL,
  created_at  BIGINT NOT NULL,
  INDEX idx_owner (owner_id),
  CONSTRAINT fk_proj_owner FOREIGN KEY (owner_id) REFERENCES users(id)
);

CREATE TABLE project_apps (
  project_id  CHAR(26) NOT NULL,
  app_id      VARCHAR(64) NOT NULL,
  PRIMARY KEY (project_id, app_id),
  INDEX idx_app (app_id),
  CONSTRAINT fk_pa_proj FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- apps 表（从 SQLite 迁移，字段对齐）
CREATE TABLE apps (
  app_id       VARCHAR(64) PRIMARY KEY,
  app_secret   VARCHAR(128) NOT NULL,
  name         VARCHAR(100) NOT NULL,
  created_at   BIGINT NOT NULL,
  last_seen_at BIGINT
);

CREATE TABLE agent_definitions (
  id           CHAR(26) PRIMARY KEY,             -- ULID
  project_id   CHAR(26) NOT NULL,
  name         VARCHAR(100) NOT NULL,
  version      INT NOT NULL,                      -- 自增（同 project+name 内）
  status       ENUM('draft','published','archived') NOT NULL DEFAULT 'draft',
  spec         JSON NOT NULL,                     -- { systemPrompt, tools, model, params }
  created_by   CHAR(26) NOT NULL,
  created_at   BIGINT NOT NULL,
  published_at BIGINT,
  UNIQUE KEY uk_name_version (project_id, name, version),
  INDEX idx_project (project_id, status),
  CONSTRAINT fk_ad_proj FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT fk_ad_user FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE acl (
  user_id     CHAR(26) NOT NULL,
  project_id  CHAR(26) NOT NULL,
  role        ENUM('owner','editor','viewer') NOT NULL,
  granted_at  BIGINT NOT NULL,
  granted_by  CHAR(26),
  PRIMARY KEY (user_id, project_id),
  CONSTRAINT fk_acl_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_acl_proj FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
```

**依赖**：Phase 0

**验证**：
- `BUSINESS_STORE=sqlite` 时所有行为不变（回归测试通过）
- `BUSINESS_STORE=mysql` 时：创建用户 → 登录 → 创建项目 → 关联 app → 创建 Agent 定义 → 发布 v1 → 编辑后发布 v2 → 回滚到 v1
- ACL：viewer 不能 DELETE /api/apps/:appId；editor 不能管理成员
- 迁移脚本可重复执行（idempotent）

**回滚**：`BUSINESS_STORE=sqlite` 即退回原行为；MySQL 表保留不删，下次切换可复用。

---

### Phase 2 — ClickHouse 监控库（TraceStore 实现）

**目标**：新增 `ClickHouseTraceStore`，支持双写模式（SQLite + CH）做数据比对，最终单写 CH。

**任务**：
- [ ] 新增 `src/stores/clickhouse-store.ts`：实现 `TraceStore` 接口
- [ ] ClickHouse DDL（`infra/clickhouse/init.sql`）：MergeTree 引擎，按 `started_at` ORDER BY，按 `toStartOfDay(started_at)` 分区，TTL 90d
- [ ] 批量 INSERT 优化：每 worker 攒 1000 行或 1s 触发一次（`src/ingest/batcher.ts`）
- [ ] `queryRuns` / `queryTrace` / `queryVersionMetrics` 改写为 CH SQL（用 `quantile()` 聚合函数，不再 JS 侧排序）
- [ ] `config.ts` 新增 `CLICKHOUSE_URL` / `TRACE_STORE=sqlite|clickhouse|dual`
- [ ] `collector.ts`：`opts.traceStore` 注入；`dual` 模式同时写两库（比对用）
- [ ] 新增 `src/stores/dual-trace-store.ts`：包装两个 store，写双写、读优先 CH、定期比对脚本

**ClickHouse Schema**：
```sql
CREATE TABLE runs (
  trace_id      String,
  app_id        LowCardinality(String),
  started_at    DateTime64(3),
  ended_at      DateTime64(3),
  session_key   LowCardinality(String),
  channel       LowCardinality(String),
  model         LowCardinality(String),
  version       LowCardinality(String),
  status        Enum('success','error','validation'),
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
  cost_cents    UInt32                              -- Phase 6 填充
) ENGINE = MergeTree
PARTITION BY toYYYYMMDD(started_at)
ORDER BY (app_id, started_at, trace_id)
TTL started_at + INTERVAL 90 DAY;

-- spans / tool_calls / events / retry_attempts 同构（详见 init.sql）
```

**依赖**：Phase 0

**验证**：
- `TRACE_STORE=clickhouse`：ingest 1000 runs 后 `SELECT count()` 一致；`/traces/:id` 能查到 spans 时间线
- `TRACE_STORE=dual`：跑 1h 真实流量，脚本比对两库 count 与字段差异 < 0.01%
- 分位数：CH `quantile(0.95)(duration_ms)` vs SQLiteStore JS 排序值误差 < 1ms
- `EXPLAIN` 验证查询走索引不扫全表

**回滚**：`TRACE_STORE=sqlite` 即退回；CH 表可保留继续写入，下次切换无缝。

---

### Phase 3 — Kafka MQ 层 + Ingest Worker

**目标**：解耦 collector 的 ingest 与落盘。collector 仅鉴权 + 限流 + produce Kafka；独立 worker 消费 → CH 批量写入。

**任务**：
- [ ] 新增 `src/mq/kafka-producer.ts`：封装 `kafkajs` Producer，topic=`aipack.ingest`
- [ ] 新增 `src/mq/kafka-consumer.ts`：consumer group=`obs-workers`，批量拉取（max 500 条 / 1s）
- [ ] 修改 `collector.ts`：`opts.mqProducer` 注入时走 produce，不注入时走原同步落盘（兼容）
- [ ] 新增 `src/worker/ingest-worker.ts`：独立 bin 入口，消费 Kafka → `TraceStore.flush` + `Aggregator.ingest*`
- [ ] 新增 `src/worker/dlq.ts`：失败消息进 `aipack.ingest.dlq` topic，告警评估器监控 DLQ 速率
- [ ] 限流改 Redis 令牌桶（`src/rate-limit-redis.ts`），替换进程内 `RateLimiter`
- [ ] `config.ts`：`KAFKA_BROKERS` / `MQ_ENABLED=true|false`
- [ ] SDK 不动（协议层不变）

**依赖**：Phase 0、Phase 2（CH 是 worker 的 sink）

**验证**：
- `MQ_ENABLED=false`：行为完全同当前（回归）
- `MQ_ENABLED=true`：SDK 上报 → collector 200 → Kafka lag 消失 → CH 出现数据，端到端延迟 < 2s
- 杀掉 worker 30s 后重启：Kafka 积压消息能消费完，无丢失
- 故意让 CH 不可用：消息进 DLQ，DLQ 计数告警触发

**回滚**：`MQ_ENABLED=false`，collector 回落同步落盘；Kafka topic 保留。

---

### Phase 4 — 用户 / RBAC / 项目（面板完整链路）

**目标**：把 Phase 1 的存储层接到面板与 API。注册/登录/项目切换/成员管理全链路打通。

**任务**：
- [ ] 修改 `src/auth.ts`：`SessionManager` 升级为多用户（payload 含 `userId` / `projectId` / `role`）
- [ ] 新增 `src/auth/jwt.ts`：access token (15min) + refresh token (7d)，HTTP-only cookie
- [ ] 新增 `src/api/users.ts`：`POST /api/users/register` / `GET /api/users/me` / `PATCH /api/users/me`
- [ ] 新增 `src/api/projects.ts`：CRUD + 成员管理（`POST /api/projects/:id/members`）
- [ ] 新增 `src/api/auth.ts`：`POST /api/auth/refresh` / `POST /api/auth/logout`
- [ ] 新增 `src/middleware/auth.ts`：解析 token → 注入 `req.user`；`requireRole('owner')` 守卫
- [ ] 修改 `admin.ts`：app 管理端点加项目上下文（`?projectId=xxx`，按 ACL 过滤）
- [ ] 面板新增页面：`RegisterPage` / `ProjectsPage` / `ProjectMembersPage`
- [ ] 面板 `App.tsx`：加项目切换器（顶部下拉），所有查询带 `projectId`
- [ ] 兼容老 `ADMIN_USER/ADMIN_PASS`：启动时若 `users` 表空且配置了 ADMIN_*，自动 seed 一个 admin 用户

**依赖**：Phase 1

**验证**：
- 注册新用户 → 登录 → 创建项目 → 邀请另一用户为 editor → 该用户能看到项目下 app 但不能删 app
- 老部署升级：保留 `ADMIN_USER/ADMIN_PASS`，首次启动 seed admin，密码不变即可登录
- Token 过期：access 过期后 refresh 自动续期；refresh 过期需重新登录

**回滚**：保留 `/api/auth/login`（单用户模式）端点；`AUTH_MODE=single` 退回原行为。

---

### Phase 5 — Agent 定义生命周期

**目标**：面板可视化编辑 Agent 定义（system prompt / tools / model / 参数），版本化发布/回滚，发布后可下发给 Agent 应用。

**任务**：
- [ ] 新增 `src/api/agent-definitions.ts`：
  - `POST /api/projects/:pid/agents` 创建
  - `GET /api/projects/:pid/agents` 列表
  - `POST /api/projects/:pid/agents/:id/publish` 发布新版本
  - `POST /api/projects/:pid/agents/:id/rollback?to=vN` 回滚
  - `GET /api/projects/:pid/agents/:id/versions` 版本列表
- [ ] Agent spec schema 校验（`src/agent-definition/schema.ts`）：用 zod 或 typebox
- [ ] 面板新增 `AgentDefsPage`：列表 + 编辑器（Monaco YAML）+ 版本对比 diff
- [ ] 面板新增 `AgentVersionDiff` 组件：左右两列 spec JSON diff
- [ ] SDK 新增 `getAgentDefinition(name, version)` 拉取接口（可选，按需启用）
- [ ] Webhook：发布新版本时触发 `agent.published` 事件，通知订阅的 Agent 应用热重载

**Agent spec 格式**：
```yaml
systemPrompt: "You are a helpful travel assistant..."
model:
  provider: deepseek
  id: deepseek-chat
  temperature: 0.7
  maxTokens: 4096
tools:
  - search
  - weather
  - itinerary
params:
  maxTurns: 20
  approvalMode: auto
```

**依赖**：Phase 4

**验证**：
- 创建 Agent 定义 v1 draft → publish → 编辑 → publish v2 → rollback 到 v1
- v1 与 v2 的 spec diff 在面板正确展示
- Agent 应用拉取 published 版本能正常初始化 runtime

**回滚**：Agent 定义表保留，面板隐藏 AgentDefsPage 即可。

---

### Phase 6 — Cost 核算 + Trace 瀑布图

**目标**：引入模型价格表，span 落盘时计算 cost；面板加成本卡片与趋势；TracesPage 加 ECharts Gantt 瀑布图。

**任务**：
- [ ] 新增 `model_prices` 表（MySQL）：
  ```sql
  CREATE TABLE model_prices (
    model_id           VARCHAR(100) NOT NULL,
    input_per_1m       DECIMAL(10,4) NOT NULL,    -- $/1M tokens
    output_per_1m      DECIMAL(10,4) NOT NULL,
    cache_read_per_1m  DECIMAL(10,4) DEFAULT 0,
    cache_write_per_1m DECIMAL(10,4) DEFAULT 0,
    currency           CHAR(3) DEFAULT 'USD',
    effective_at       BIGINT NOT NULL,
    PRIMARY KEY (model_id, effective_at)
  );
  ```
- [ ] 新增 `src/cost/calculator.ts`：根据 span 的 model + tokens + 价格表算 `cost_cents`
- [ ] 修改 `ingest-worker`：span 落盘前调用 calculator 填 `cost_cents`
- [ ] 修改 `Aggregator`：新增 `totalCostCents` 字段
- [ ] 修改 `summary` / `timeseries` API：加 `costTotal` 指标
- [ ] 面板 `DashboardPage`：新增成本 KPI 卡片 + 成本趋势图（按模型/应用拆分）
- [ ] 面板 `TracesPage`：spans 列表改 ECharts Gantt（custom series），x 轴时间、y 轴 span、颜色按 kind 区分
- [ ] 面板 `AppsPage`：新增"模型价格管理"子页（CRUD `model_prices`，仅 owner 可编辑）

**依赖**：Phase 2（CH 存储 cost_cents 列）、Phase 4（价格表 ACL）

**验证**：
- 上报 1000 runs 后 `SUM(cost_cents)` 与手动按价格表核算误差为 0
- 价格变更：新价格只对后续 span 生效，历史 span cost 不变（按 effective_at）
- 瀑布图：span 时间轴与 `/traces/:id` 返回的 `startedAt + durationMs` 一致

**回滚**：`cost_cents` 列保留为 0；面板隐藏成本卡片。

---

### Phase 7 — 分布式聚合 + 多实例部署

**目标**：collector 与 worker 无状态化，聚合窗口迁到 Redis，支持横向扩容。

**任务**：
- [ ] 抽离 `Aggregator` 接口（`src/aggregator/interface.ts`）：`ingestRun/ModelCall/ToolCall/Permission/Retry` + `summary/timeseries/tools`
- [ ] 新增 `src/aggregator/redis-aggregator.ts`：滑动窗口 + 直方图用 Redis Hash + ZSET 存储
- [ ] 新增 `src/aggregator/hybrid-aggregator.ts`：本地 L1（1min 微窗口）+ Redis L2（60min 主窗口），降低 Redis QPS
- [ ] 修改 `collector.ts`：`opts.aggregatorFactory` 注入，缺省用进程内 `Aggregator`
- [ ] 修改 `worker`：消费后喂注入的 aggregator
- [ ] Prometheus exporter 改为查 Redis aggregator（多实例导出一致）
- [ ] 部署文档：`docs/deploy-distributed.md`（N collector + M worker + Redis 集群）

**依赖**：Phase 3（worker 已存在）、Phase 2（CH）

**验证**：
- 3 collector + 2 worker 部署：ingest 请求均匀分布；聚合数据跨实例一致
- 杀掉 1 collector：流量自动转到其他实例；窗口数据不丢（在 Redis）
- 杀掉 1 worker：Kafka 消费组自动 rebalance，无消息丢失
- Prometheus 抓取任一 collector 都返回相同指标

**回滚**：`AGGREGATOR=memory` 退回进程内聚合（仅单实例可用）。

---

### Phase 8 — 长周期留存 + 冷归档

**目标**：CH 热表 TTL 90 天；超期数据归档到对象存储 Parquet；长周期查询走 CH S3 引擎。

**任务**：
- [ ] CH 表加 TTL（已在 Phase 2 DDL 含）
- [ ] 新增 `src/archive/parquet-writer.ts`：CH `SELECT … INTO OUTFILE S3` 或用 `@clickhouse/client` 导出 Parquet 到 S3/OSS
- [ ] 新增 `src/archive/scheduler.ts`：每日凌晨归档前 91-180 天数据到 `s3://aipack-archive/trace-yyyy-mm/`
- [ ] CH 配置 S3 引擎表：`trace_archive` 映射到 S3 Parquet
- [ ] 修改 `queryRuns`：时间范围 > 90 天时自动路由到 `trace_archive` 表
- [ ] 面板时间范围选择器扩展到 1 年（自动提示"查询可能较慢"）

**依赖**：Phase 2

**验证**：
- 写入 100 天数据 → 第 91 天 TTL 自动清理热表
- 归档任务跑完后 S3 有 Parquet 文件
- 面板查 120 天前数据：路由到 archive 表，能在 5s 内返回

**回滚**：归档表保留，路由关闭即只查热表（>90 天数据查不到，但不报错）。

---

### Phase 9 — 增强（采样 / 链路关联 / PII 脱敏）

**目标**：补齐企业级可观测的高级能力。

**任务**：
- [ ] **采样策略**：SDK `sampleStrategy` 选项，支持 `error-priority`（错误 run 必采，成功按 rate）/ `slow-priority`（>P95 必采）/ `traceid-ratio`（一致性 head 采样）
- [ ] **W3C Trace Context**：SDK 支持 `traceparent` 头注入与解析；与外部 OpenTelemetry 链路打通
  - `RunRecord` 加 `parentTraceId?` / `w3cTraceId?` 字段
  - collector 透传到 CH
  - 面板 Trace 详情显示父链路跳转
- [ ] **PII 脱敏**：内置规则库 `src/redact/rules.ts`（手机号/邮箱/身份证/银行卡正则）
  - SDK `redact` 钩子默认启用内置规则
  - 面板可配置项目级脱敏规则（字段级策略：mask / hash / drop）
  - 规则存 MySQL `redact_rules` 表
- [ ] **错误归因下钻**：面板 ErrorClass 卡片点击 → 列出该类错误最近 100 条 trace → 按工具/模型分布

**依赖**：独立于其他阶段，可并行

**验证**：
- 采样：`error-priority` 模式下，错误 run 100% 落库，成功 run 按 rate 采样
- 链路：外部系统传入 `traceparent`，面板能看到跨系统调用链
- 脱敏：包含手机号的 `obs.emit('user_input', {text: '...13912345678...'})` 上报后 CH 中 `data` 字段手机号被掩码
- 错误归因：点击 'timeout' 错误类 → 列出最近 100 条 timeout trace，能看到集中在某个工具

**回滚**：各项独立开关，`SAMPLE_STRATEGY=none` / `W3C_ENABLED=false` / `REDACT_ENABLED=false`。

---

## 4. 阶段依赖图

```
Phase 0 (infra)
   ├─→ Phase 1 (MySQL 业务库)
   │       └─→ Phase 4 (用户/RBAC) ─→ Phase 5 (Agent 定义)
   │                                       └─→ (Phase 6 价格表 ACL)
   ├─→ Phase 2 (ClickHouse 监控库)
   │       ├─→ Phase 3 (Kafka + Worker) ─→ Phase 7 (分布式聚合)
   │       └─→ Phase 8 (冷归档)
   │       └─→ Phase 6 (Cost 核算)
   └─→ Phase 9 (增强, 独立可并行)
```

**可并行**：
- Phase 1 ∥ Phase 2（不同存储，互不依赖）
- Phase 9 全程可并行（SDK 侧改造，不依赖后端）
- Phase 5 与 Phase 6 可并行（Phase 6 仅依赖 Phase 2+4）

**关键路径**：Phase 0 → 2 → 3 → 7（分布式落地） + Phase 0 → 1 → 4 → 5（业务模型落地），两条线在 Phase 6 汇合。

---

## 5. 验收标准（整体）

| 维度 | 标准 |
|---|---|
| **功能** | OBSERVABILITY_GAP.md 列出的 11 项缺失全部实现并有对应面板入口 |
| **兼容** | 现有 SDK 协议不变；`BUSINESS_STORE=sqlite TRACE_STORE=sqlite MQ_ENABLED=false` 时行为与当前版本完全一致 |
| **性能** | 单 collector 实例 ingest 1000 req/s，P99 处理延迟 < 50ms；3 实例水平扩展到 3000 req/s |
| **可用** | 任一 collector/worker 实例宕机不影响整体；Redis 单点故障退化为本地窗口（降级不中断） |
| **留存** | 热数据 90 天 + 冷归档 1 年，查询 1 年范围 < 10s |
| **安全** | argon2id 密码哈希；JWT 短期 token + refresh；RBAC 三级权限；PII 默认脱敏 |
| **观测** | collector/worker 自身埋点（ingest 速率/Kafka lag/CH 写入延迟）上报到自身 |
| **回滚** | 每阶段可通过单个 env 开关退回上一形态，不丢数据 |

---

## 6. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| ClickHouse 写入瓶颈 | 高频 ingest 卡 worker | 批量 INSERT（≥1000 行/次）+ Buffer 表 + 异步 flush |
| Kafka 消费乱序 | 同 trace 的 span 跨 partition | partition key = `traceId` 保证同 trace 同 partition |
| Redis 聚合器精度 | 直方图跨实例合并误差 | 用 HLL 近似 + 文档说明；关键 P99 走 CH `quantile()` 直查 |
| 双写期数据不一致 | 比对脚本误判 | 容忍 token 数 ±1（浮点）；count 必须严格一致 |
| MySQL 单点 | 业务库宕机全站不可用 | ProxySQL + 主从；apps 表缓存到 collector 内存 LRU（5min TTL）降级 |
| 迁移脚本失败 | 升级卡住 | 每个迁移独立事务 + 版本号记录在 `schema_migrations` 表；失败可重试 |
| 面板改造成本 | 5 个新页面 | 复用现有 Antd 组件 + EChart；Agent 编辑器用 Monaco（已有依赖） |

---

## 7. 执行建议

1. **先做 Phase 0 + Phase 1 + Phase 2**（基础设施 + 双存储抽象），这是后续所有阶段的地基，且能立即获得"业务库/监控库分离"的价值
2. **Phase 9 全程并行**（SDK 侧改造，不阻塞后端）
3. **Phase 3 + Phase 7 一起做**（分布式落地，Kafka + Redis 聚合一起上避免两次大改）
4. **Phase 4 + Phase 5 一起做**（业务模型层，RBAC 和 Agent 定义耦合度高）
5. **Phase 6 + Phase 8 最后做**（增值功能，依赖前面基础就位）

每个 Phase 完成后：跑全量回归测试（`BUSINESS_STORE=sqlite` 模式）→ 跑该 Phase 验证脚本 → 更新 CHANGELOG → 打 tag。
