# S2 聚合存储实施文档（@aipack/observability）

> 对应 [observability.md](./observability.md) §5.1 档位 A（自建轻量）、§6 REST API、
> §8 S2 验收、附录 A SQLite 表结构。
>
> 前置：**S1 已实现**（[telemetry/index.ts](../packages/agent/telemetry/index.ts) 定义 6 类事件，
> runtime 已在 run/stream/tool/model/retry/permission 全路径埋点）。
> S2 是纯消费侧落地，**不改动框架**，仅新增一个可选包 + 一个独立收集服务应用。

---

## 1. 目标与验收

| 项   | 内容                                                                                                                                      |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 目标 | **埋点上报 + 后台统一收集**：客户端 SDK 一行接入（`appId + appSecret`），事件自动上报；独立收集服务完成 SQLite 落盘 + 内存聚合 + REST API |
| 验收 | 客户端跑一次 run → 收集服务 `GET /metrics/summary`、`GET /traces/:traceId` 返回正确数据；鉴权失败被拒；断网落缓存可补报                   |
| 原则 | 事件消费全异步、失败不阻断 run()；指标口径与 §3 一致；appId 白名单鉴权；零外部基础设施                                                    |

---

## 2. 总体架构（数据流）

```
【客户端 SDK】（@aipack/observability）
runtime emitTelemetry（6 类事件，S1 已埋）
  └─► ObservabilityTelemetry.onXxx        （实现 Telemetry 接口）
        └─► 原始记录（RunRecord / SpanRecord / ToolCallRecord / PermissionRecord）入队
              └─► 定时批量上报（默认 5s / 50 条）
                    └─► HttpReporter       POST {endpoint}/api/v1/ingest（x-app-id/x-app-secret 鉴权）
                          ├─ 成功 → 完成
                          └─ 失败 → 本地缓存文件（{cacheDir}/{appId}.json），下次自动补报

【收集服务】（apps/observability-server 独立部署）
POST /api/v1/ingest ──► 鉴权（appId+Secret 白名单）──► SQLiteStore.flush（事务批量落盘）
                                                    └─► Aggregator.ingestXxx（内存聚合，同步 O(1)）
GET  /metrics/*、/traces/* ──► 读 Aggregator（实时窗口）+ SQLiteStore（明细/历史）
```

**为什么上报原始事件、收集端统一聚合**（而不是客户端本地聚合上报）：

- 客户端最轻，只做"埋点 + 上报"，聚合口径在收集端统一，多端上报对账一致；
- p50/p95/p99 由收集端在线直方图维护，O(1) 插入，`summary` 响应无 SQL 聚合开销；
- SQLite 只存明细，承担"重启恢复"与"trace 下钻"，不做高并发分析；
- 事件路径同步快操作，上报走批量队列 + 失败本地缓存，不阻塞 run()。

---

## 3. 包结构（两个包：上报 SDK + 收集服务）

```
packages/observability/              # 上报 SDK（客户端，零重依赖）
├── src/
│   ├── telemetry.ts     # 事件 → 原始记录 → 上报队列（实现 Telemetry 接口）
│   ├── reporter.ts      # HttpReporter（POST ingest + 鉴权头 + 失败本地缓存补报）
│   ├── types.ts         # 记录类型（RunRecord/SpanRecord/ToolCallRecord/PermissionRecord/EventBatch）
│   └── index.ts         # createObservability({ appId, appSecret, endpoint })
├── test/observability.test.ts       # reporter 单元 + 事件→记录转换
├── package.json         # deps: 无运行时依赖（peer: @aipack/agent）
└── tsup.config.ts / tsconfig.json

packages/observability-server/       # 收集服务（独立部署，含 SQLite）
├── src/
│   ├── histogram.ts     # 在线对数直方图（p50/p95/p99）
│   ├── aggregator.ts    # 滑动窗口聚合器（ingestRun/ingestModelCall/ingestToolCall/ingestPermission）
│   ├── store.ts         # TraceStore 接口 + SQLiteStore（better-sqlite3）
│   ├── server.ts        # REST API 查询路由（5 个端点，node:http）
│   ├── collector.ts     # createCollector（ingest 鉴权 + 落盘 + 聚合 + 查询）
│   ├── types.ts         # 聚合结果 / API 响应类型
│   ├── index.ts         # createCollector() + 导出
│   ├── cli.ts           # 启动入口（bin: observability-server）
│   ├── config.ts        # PORT / DB_PATH / OBS_APPS 解析
│   └── loadEnv.ts       # 零依赖 .env 加载
├── test/observability-server.test.ts # 端到端验收（§9）
├── .env.example / README.md
└── package.json         # deps: @aipack/observability(workspace)、better-sqlite3
```

**依赖方向**：`observability-server` → 依赖 `observability`（记录类型共享），
反向无依赖。客户端只装 SDK 包，不带 better-sqlite3。

> **SQLite 选型**：本机 Node v18.20.8 无内置 `node:sqlite`（需 22.5+），
> 采用 `better-sqlite3`（同步 API、Node 18 有 prebuilt binary）。
> `TraceStore` 为接口抽象，未来可换 `ElasticsearchStore` / OTLP 导出，消费侧零改动。

---

## 4. 模块设计

### 4.1 histogram.ts — 在线对数直方图

对数分桶（覆盖 0.1ms ~ 10min），插入无需保留原始值，任意时刻可查分位数。

```ts
export class Histogram {
  /** 插入一个样本（O(1)） */
  insert(v: number): void;
  count(): number;
  /** 分位数：q=0.5 → p50、0.95 → p95、0.99 → p99；无样本返回 0 */
  quantile(q: number): number;
  /** 窗口合并用（过期桶整体丢弃，不合并） */
  merge(other: Histogram): void;
}
```

### 4.2 aggregator.ts — 内存聚合器

- **时间桶**：`bucketMs`（默认 1min）粒度切片，窗口 `windowMs`（默认 60min），
  事件到达时惰性清理过期桶（`now - windowMs` 之前的桶整体丢弃）；
- **维度统计**：`model` / `tool` / `session` 三个维度表，每个维度维护请求量、
  成功数、错误分类计数、成本、耗时直方图、turnCount 分布、重试次数；
- **工具统计**：`tools` 表按工具名维护 calls / ok / error / avgMs；
  成功率分母 = ok + error，**blocked/skipped 不计入**（§3 关键坑）。

```ts
export interface SummaryFilter {
  since?: number;
  until?: number;
}

export interface AggregatedMetrics {
  requests: number;
  successRate: number; // status='success' 且无 errorClass 占比
  costUsd: number;
  costUnknown: number; // 未配费率调用数
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  avgTurns: number;
  retryRate: number; // (attempts-1) 总和 / 模型调用数
  permissionDenied: number;
}

export interface ToolStat {
  tool: string;
  calls: number;
  successRate: number; // ok / (ok + error)，blocked/skipped 排除
  avgMs: number;
  errors: number;
}

export class Aggregator {
  constructor(opts?: { windowMs?: number; bucketMs?: number });
  // record 驱动（收集端 ingest 后喂入，不再依赖 @aipack/agent 类型）
  ingestRun(r: RunRecord): void;
  ingestModelCall(s: SpanRecord): void; // s.kind === 'model'
  ingestToolCall(t: ToolCallRecord): void;
  ingestPermission(p: PermissionRecord): void;
  summary(
    filter: SummaryFilter,
    groupBy?: 'model' | 'tool' | 'session',
  ): AggregatedMetrics | Record<string, AggregatedMetrics>;
  timeseries(
    filter: SummaryFilter,
    stepMs: number,
    metric: 'requests' | 'successRate' | 'costUsd',
  ): Array<{ t: number; v: number }>;
  tools(filter: SummaryFilter): ToolStat[]; // 按成功率升序
}
```

### 4.3 store.ts — TraceStore 接口 + SQLiteStore

`TraceStore` 接口抽象存储，默认 `SQLiteStore`（附录 A DDL 原样建表，含索引）。

```ts
export interface RunRecord {
  traceId: string;
  startedAt: number;
  endedAt: number;
  sessionKey: string;
  channel?: string;
  model?: string;
  status: 'success' | 'error' | 'validation';
  errorClass?: string;
  turns: number;
  durationMs: number;
  activeMs: number;
  queuedMs: number;
  ttftMs?: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead?: number;
  cacheWrite?: number;
  costUsd?: number;
}
export interface SpanRecord {
  traceId: string;
  spanId: string;
  kind: 'run' | 'model' | 'tool';
  name: string; // model:<id> / tool:<name> / run
  startedAt: number;
  durationMs: number;
  status: 'ok' | 'error';
  errorClass?: string;
  attempts?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  sessionKey?: string; // 支撑 session 维度成本统计（新增）
}
export interface ToolCallRecord {
  traceId: string;
  spanId: string;
  toolName: string;
  status: 'ok' | 'error' | 'blocked' | 'skipped';
  durationMs: number;
  errorClass?: string;
}

export interface TraceStore {
  insertRun(r: RunRecord): void;
  insertSpan(s: SpanRecord): void;
  insertToolCall(t: ToolCallRecord): void;
  queryRuns(filter: {
    since?: number;
    until?: number;
    status?: string;
    model?: string;
    tool?: string;
    sessionKey?: string;
    offset: number;
    limit: number;
  }): { total: number; items: RunRecord[] };
  queryTrace(
    traceId: string,
  ):
    | { run: RunRecord; spans: SpanRecord[]; tools: ToolCallRecord[] }
    | undefined;
  close(): void;
}

export class SQLiteStore implements TraceStore {
  constructor(dbPath: string); // 自动建表
  /** 批量写入（事务），由收集端 ingest 调用 */
  flush(batch: {
    runs: RunRecord[];
    spans: SpanRecord[];
    toolCalls: ToolCallRecord[];
    permissions: PermissionRecord[]; // 仅聚合计数，不落库
  }): void;
  close(): void;
}
```

### 4.4 telemetry.ts — Telemetry 接口实现（客户端）

事件 → 原始记录映射（**startedAt 推导**：载荷只有 durationMs，
用 `Date.now() - durationMs`；run 级用 `onRunStart.queuedAt`）：

| 事件                 | 入队记录                                                  | 说明                              |
| -------------------- | --------------------------------------------------------- | --------------------------------- |
| `onRunStart`         | 记录 queuedAt（供排队时长校验）                           | 不产生记录                        |
| `onRunEnd`           | `RunRecord` + `SpanRecord`（kind='run'）                  | status 由 success/errorClass 推导 |
| `onModelCall`        | `SpanRecord`（kind='model'，含 attempts/cost/sessionKey） | 重试率由 attempts 统计            |
| `onToolCall`         | `SpanRecord`（kind='tool'）+ `ToolCallRecord`             | blocked/skipped 原样透传          |
| `onRetry`            | —（attempts 已含在 span）                                 | 不重复上报                        |
| `onPermissionDenied` | `PermissionRecord`（收集端仅计数）                        | 不落库                            |

```ts
export class ObservabilityTelemetry implements Telemetry {
  constructor(
    reporter: { send(batch: EventBatch): Promise<boolean> },
    opts?: {
      intervalMs?: number; // 上报周期，默认 5000
      batchSize?: number; // 积攒条数触发，默认 50
    },
  );
  onRunStart(info: RunStartTelemetryInfo): void;
  onRunEnd(info: RunTelemetryInfo): void; // 同步转 record 入队，无 await
  onToolCall(info: ToolTelemetryInfo): void;
  onModelCall(info: ModelTelemetryInfo): void;
  onRetry(info: RetryTelemetryInfo): void;
  onPermissionDenied(info: PermissionDeniedTelemetryInfo): void;
  flush(): void; // fire-and-forget 触发上报
  close(): Promise<void>; // 停止定时器并等残留上报完成
}
```

### 4.5 reporter.ts — HttpReporter（客户端上报）

- `POST {endpoint}/api/v1/ingest`，携带 `x-app-id` / `x-app-secret` 头；
- 失败分级：网络错误 / 5xx / 429 → **本地缓存补报**；4xx（鉴权/参数）→ 丢弃并 warn（重试无意义）；
- 缓存文件 `{cacheDir}/{appId}.json`（默认 `./.aipack/observability/`），下次 send 前先补报缓存，全部成功才删除；
- 缓存条数上限 `maxCacheSize`（默认 2000），超出丢弃最旧；
- 串行发送锁：重复调用合并为一次。

```ts
export class HttpReporter {
  constructor(opts: {
    endpoint: string;
    appId: string;
    appSecret: string;
    cacheDir?: string;
    maxCacheSize?: number;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  });
  send(batch: EventBatch): Promise<boolean>; // 失败自动落缓存，返回是否成功
}
```

### 4.6 collector.ts — 收集端工厂

```ts
export function createCollector(opts: {
  dbPath: string; // SQLite 文件路径（必填）
  apps: Record<string, string>; // appId -> appSecret 白名单（必填）
  windowMs?: number;
  bucketMs?: number;
}): {
  handler: (req, res) => Promise<void>; // POST /api/v1/ingest + GET /metrics /traces
  close(): Promise<void>;
};
```

ingest 流程：校验 `x-app-id`/`x-app-secret` 匹配白名单（否则 401）→ 解析
`{ appId, runs, spans, toolCalls, permissions }`（body appId 必须与头一致）→
`SQLiteStore.flush`（事务落盘）+ `Aggregator.ingestXxx`（实时聚合）。

### 4.7 server.ts — REST API（§6 原样）

原生 `node:http`，`(req, res) => Promise<void>`，收集端查询路由。

```ts
export function createApiHandler(deps: {
  aggregator: Aggregator;
  store: TraceStore;
}): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
```

路由契约与响应示例见 §7。

### 4.8 index.ts — 工厂

```ts
export interface CreateObservabilityOptions {
  appId: string; // 应用标识（必填）
  appSecret: string; // 应用密钥（必填），与收集端 apps 白名单匹配
  endpoint?: string; // 收集服务地址，默认 http://localhost:8787
  cacheDir?: string; // 失败缓存目录，默认 ./.aipack/observability
  maxCacheSize?: number; // 缓存条数上限，默认 2000
  flushIntervalMs?: number; // 上报周期，默认 5000
  flushBatchSize?: number; // 积攒条数触发，默认 50
}

export interface Observability {
  telemetry: Telemetry; // 注入 RuntimeOptions.telemetry
  flush(): void; // 立即上报残留
  close(): Promise<void>; // 停止定时器并等残留上报完成
}

export function createObservability(
  opts: CreateObservabilityOptions,
): Observability;
export function createCollector(opts: CollectorOptions): Collector; // 收集端
```

---

## 5. 指标口径（对齐 §3，防止对不上账）

| 指标       | 口径                                                                                                                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 请求量     | `onRunEnd` 计数（含 stream）                                                                                                                                                                                                          |
| 成功率     | `success=true` 且**无 errorClass** 占比（实现偏差：文档 §3 写 stopReason='completed'，但 buildResult 实际取最后一个 assistant 的 stopReason，真实 provider 为 'stop'/'end_turn'，故改用 errorClass 判定，避免真实数据下成功率恒为 0） |
| 工具成功率 | `status='ok' / (ok + error)`，**blocked/skipped 不计入分母**                                                                                                                                                                          |
| 响应耗时   | `durationMs`（端到端）、`queuedMs`（排队）单独统计，排队不计入模型耗时                                                                                                                                                                |
| 重试率     | `onModelCall.attempts - 1` 求和 / 模型调用数                                                                                                                                                                                          |
| 成本       | 直接读 `usage.cost.total`（S1 已透传 `costUsd`），未配费率返回 0 时标记 `costUnknown`                                                                                                                                                 |
| step 长度  | `turnCount` 分布，>10 步视为"循环风险"（仅统计口径，不告警）                                                                                                                                                                          |

---

## 6. SQLite 表结构（附录 A 原样，含索引）

```sql
CREATE TABLE runs (
  trace_id     TEXT PRIMARY KEY,
  started_at   INTEGER,
  ended_at     INTEGER,
  session_key  TEXT,
  channel      TEXT,
  model        TEXT,
  status       TEXT,              -- success / error / validation
  error_class  TEXT,
  turns        INTEGER,
  duration_ms  INTEGER,
  active_ms    INTEGER,
  queued_ms    INTEGER,
  ttft_ms      INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read   INTEGER,
  cache_write  INTEGER,
  cost_usd     REAL
);
CREATE INDEX idx_runs_started ON runs(started_at);
CREATE INDEX idx_runs_session ON runs(session_key);

CREATE TABLE spans (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id     TEXT NOT NULL,
  span_id      TEXT,
  kind         TEXT,              -- run / model / tool
  name         TEXT,              -- model:<id> / tool:<name>
  started_at   INTEGER,
  duration_ms  INTEGER,
  status       TEXT,              -- ok / error
  error_class  TEXT,
  attempts     INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd     REAL,
  session_key  TEXT               -- 新增：session 维度成本统计
);
CREATE INDEX idx_spans_trace ON spans(trace_id);
CREATE INDEX idx_spans_session ON spans(session_key);

CREATE TABLE tool_calls (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id     TEXT NOT NULL,
  span_id      TEXT,
  tool_name    TEXT,
  status       TEXT,              -- ok / error / blocked / skipped
  duration_ms  INTEGER,
  error_class  TEXT
);
CREATE INDEX idx_tool_calls_trace ON tool_calls(trace_id);
```

> 与附录 A 的差异：增加 `idx_runs_session`（`/traces?sessionKey=` 筛选用）、
> `spans.session_key`（session 维度成本统计）与 `spans.name` 语义说明，其余原样。

---

## 7. REST API 契约

```text
POST /api/v1/ingest
  头: x-app-id: <appId>, x-app-secret: <appSecret>, content-type: application/json
  体: { appId, runs: RunRecord[], spans: SpanRecord[], toolCalls: ToolCallRecord[], permissions: PermissionRecord[] }
  → 200 { ok: true } | 401 { error } | 400 { error }

GET /metrics/summary?since=&until=&groupBy=model|tool|session
  → 无 groupBy: { requests, successRate, costUsd, p50Ms, p95Ms, p99Ms, avgTurns, retryRate, permissionDenied }
  → 有 groupBy: { [key]: { ...同上 } }

GET /metrics/timeseries?since=&until=&step=5m&metric=requests|successRate|costUsd
  → [{ t: 1690000000000, v: 12 }, ...]           // step 最小 1m

GET /metrics/tools?since=&until=
  → [{ tool, calls, successRate, avgMs, errors }]  // 按 successRate 升序

GET /traces?since=&until=&status=&model=&tool=&sessionKey=&page=1&pageSize=20
  → { page, pageSize, total,
      items: [{ traceId, startedAt, durationMs, status, turns,
                tokens: { input, output }, costUsd, retries, sessionKey }] }

GET /traces/:traceId
  → { traceId,
      spans: [{ kind, name, startedAt, durationMs, status, errorClass,
                attempts, tokens: { input, output }, costUsd }] }
```

- 时间参数为 epoch ms；缺省 `since=now-windowMs`、`until=now`；
- 非法 traceId → 404 `{ error: 'trace not found' }`；
- 所有响应 `Content-Type: application/json; charset=utf-8`。

---

## 8. 接入方式

### 8.1 客户端（apps 一处注入）

```ts
// apps/xxx/src/server.ts
import { createObservability } from '@aipack/observability';

const obs = createObservability({
  appId: 'travel-app',
  appSecret: 'sk-travel123', // 与收集服务 OBS_APPS 白名单匹配
  endpoint: 'http://localhost:8787', // 收集服务地址（默认即此）
});

// 1. runtime 注入 telemetry（可多个 runtime 共享同一 obs）
createRuntime({ ..., telemetry: obs.telemetry });

// 2. 进程退出前上报残余
process.on('SIGINT', () => { await obs.close(); process.exit(0); });
```

### 8.2 收集服务（独立部署）

```bash
# packages/observability-server/.env
PORT=8787
DB_PATH=.aipack/collector.db
OBS_APPS=travel-app:sk-travel123,blog-app:sk-blog456

pnpm --filter @aipack/observability-server dev
# 或构建后全局安装：pnpm --filter @aipack/observability-server build && pnpm --global add .
```

### 8.3 备份与恢复、容器部署（P2-3）

**保留周期自动备份**（`PRUNE_BACKUP=true`）：每次 retention 清理前先执行
`VACUUM INTO <PRUNE_BACKUP_DIR>/obs-<时间戳>.db` 快照，再删过期明细。
只做新增、失败不影响主库清理；配合 `RETENTION_DAYS` 实现"细粒度保留 + 粗粒度归档"。

```bash
# .env
RETENTION_DAYS=30          # 明细保留 30 天
PRUNE_INTERVAL_MS=3600000  # 每小时清一次
PRUNE_BACKUP=true          # 清理前先快照
PRUNE_BACKUP_DIR=.aipack/backup
```

**手动备份（cron 示例）**：SQLite 热备份用 `VACUUM INTO`（不锁写），无需停服。

```bash
# 每天 03:30 全量快照，保留最近 7 份
30 3 * * *  cd /srv/obs && /usr/bin/sqlite3 .aipack/collector.db \
  "VACUUM INTO '.aipack/backup/obs-$(date +\%F).db'" && \
  ls -t .aipack/backup/obs-*.db | tail -n +8 | xargs -r rm --
```

**容器部署**（`packages/observability-server/Dockerfile`，上下文为仓库根）：

```bash
docker build -f packages/observability-server/Dockerfile -t aipack/observability-server .
docker run -d --name obs --restart unless-stopped \
  -p 8787:8787 -v obs-data:/data \
  -e ADMIN_PASS=change-me \
  -e SESSION_SECRET=$(openssl rand -hex 32) \
  aipack/observability-server
```

- 数据卷 `/data` 落 DB 与备份目录；镜像含 `/healthz` 健康检查（HEALTHCHECK 自动探测）。
- `SESSION_SECRET` 显式配置（推荐 `openssl rand -hex 32`）后，面板登录 token 改为
  无状态 HMAC 签名（含过期时间），重启不失效、零文件状态、不占内存；
  缺省时若 `ADMIN_PASS` 为显式配置则以之派生；两者都缺省（密码自动生成）回退内存会话。

**恢复**：停服 → 把快照 db 复制回 `DB_PATH` → 启动即可（快照含全部表与索引，路径无关）。

---

## 9. 测试与验收（对齐 §8 S2 验收）

沿用 [telemetry.test.ts](../packages/agent/test/telemetry.test.ts) 的 mock streamFn 手法：
起真实收集服务（`createCollector` + `http.createServer().listen(0)`），
客户端 `createObservability({ appId, appSecret, endpoint })` 注入 runtime 跑一次 run，
`await obs.close()` 等上报完成后查询收集服务 API 断言。

| 用例          | 断言                                                                                                             |
| ------------- | ---------------------------------------------------------------------------------------------------------------- |
| run 成功      | `/metrics/summary`：`requests=1`、`successRate=1`；`/traces/:id` 含 run + model span；落盘持久化（重开 db 仍在） |
| 工具循环 2 轮 | `avgTurns=2`；`/metrics/tools` 出现工具且 `successRate=1`                                                        |
| 工具抛错      | 该工具 `successRate=0`、`errors=1`；tool span.status='error'                                                     |
| 权限拒绝      | `summary.permissionDenied=1`；工具统计**不计入**该调用                                                           |
| 模型重试      | mock streamFn 首次抛可重试错误 → span.attempts=2、`retryRate=1`                                                  |
| 流式请求      | run 落库可查询（durationMs）                                                                                     |
| 校验失败请求  | `/traces?status=validation` 命中；`successRate=0`                                                                |
| cost 透传     | usage.cost.total 出现在 summary.costUsd 与 span.costUsd                                                          |
| 鉴权失败      | 错误 secret → 401，数据不入库，客户端丢弃且**不缓存**（重试无意义）                                              |
| 缓存补报      | 断网（死端口）落缓存 → 收集服务恢复后补报成功、缓存删除、数据可查                                                |
| 缓存裁剪      | 超过 maxCacheSize 丢弃最旧记录（保留最新）                                                                       |

**验证命令**：

```bash
pnpm --filter @aipack/observability test      # 上报 SDK 测试（6 用例）
pnpm --filter @aipack/observability typecheck
pnpm --filter @aipack/observability-server test      # 收集服务端到端（10 用例）
pnpm --filter @aipack/observability-server typecheck
pnpm --filter @aipack/agent test              # 回归（框架零改动，应全绿）
```

---

## 10. 扩展边界（不在此步实现）

| 场景              | 方案                                                       | 触发条件                    |
| ----------------- | ---------------------------------------------------------- | --------------------------- |
| 多实例部署        | traceId 注入请求头 + 进程 id（§4 文档）；本步不处理        | 单机部署先够用              |
| 海量明细/全文检索 | 实现 `ElasticsearchStore` 替换 `SQLiteStore`（接口已预留） | 每天数万次 run 且需全文搜索 |
| 已有观测基础设施  | 档位 B：OTLP exporter → Prometheus/Tempo/Grafana           | 团队已有 Grafana            |
| 不想自研面板      | Langfuse / Helicone，只传 `traceId`（§5 零代码备选）       | 需要评估/回放功能           |

> 当前 S2 只交付档位 A。以上任一方案都通过 `Telemetry` 接口 / `TraceStore` 接口接入，
> 聚合器与 REST API 无需改动。

## 11. 面板（observability-web）实现

在 S2 基础上补齐档位 A 的自研面板：**登录 + 应用管理 + Dashboard 观测**。

### 11.1 包结构

前端作为 **observability-server 包内的静态资源**（`packages/observability-server/web`），
`build` 时 vite 产出到 `dist/public`，server 启动时自动托管——无需单独部署前端。

```
packages/observability-server/     # 单包：收集服务 + 内嵌面板
  ├── src/                         # 后端（auth 会话 + 应用管理 + 聚合 + 静态托管）
  ├── web/                         # 面板前端源码（React 18 + Vite 5 + antd 5 + echarts 5 + react-router 6）
  │   ├── src/pages/LoginPage.tsx  # 登录（POST /api/auth/login → token 存 localStorage）
  │   ├── src/pages/DashboardPage.tsx  # 总览：KPI 卡 + 时间序列 + 模型排行 + 工具分析 + 错误饼图
  │   ├── src/pages/AppsPage.tsx   # 应用管理：创建（生成 appId/appSecret）、重置密钥、删除
  │   ├── src/pages/TracesPage.tsx # Trace 列表 + 抽屉下钻 span 时间线
  │   ├── src/api.ts               # fetch 封装：自动带 Bearer token；401 触发全局登出
  │   └── src/auth.tsx             # AuthContext：启动校验 /api/auth/me，未登录重定向 /login
  └── dist/public/                 # build 产物（后端 dist/ + 前端 public/），files 一并发布
```

构建与开发：

- `pnpm --filter @aipack/observability-server build` → tsup 后端到 `dist/` + vite 前端到 `dist/public/`
- `pnpm --filter @aipack/observability-server dev:web` → vite dev（5175，代理 /api /metrics /traces → :8787）

### 11.2 关键设计

- **动态应用鉴权**：`apps` 表替代静态 `OBS_APPS` 必填白名单（后者降级为启动种子，`INSERT OR IGNORE`）。
  上报时 `verifyApp(appId, secret)` 用 `timingSafeEqual` 恒时比较；密钥可重置（旧密钥立即失效）。
- **按应用数据隔离**：runs/spans/tool_calls 落盘带 `app_id` 列；内存聚合维护 `global + byApp Map` 两套
  Aggregator；`/metrics/*` 与 `/traces` 均支持 `appId` 查询参数过滤。
  旧库迁移：`ensureAppIdColumns` 用 `PRAGMA table_info` 检测缺列后 `ALTER TABLE` 补充。
- **面板会话**：`ADMIN_USER`/`ADMIN_PASS`（密码缺省自动生成并打印）；除登录外所有面板 API 需
  `Authorization: Bearer <token>`。查询类端点（/metrics、/traces）也要求登录。
- **静态托管**：前端构建产物内嵌在包内 `dist/public`，`config.ts` 缺省自动定位（无需配 STATIC_DIR），
  `GET /` 返回面板（SPA 回退 index.html，含路径穿越防护）。开发模式用 `dev:web`（Vite 代理
  `/api`、`/metrics`、`/traces` → :8787）。

### 11.3 面板 API（新增）

| 方法   | 路径                               | 说明                                        |
| ------ | ---------------------------------- | ------------------------------------------- |
| POST   | /api/auth/login                    | 登录，返回 `{ token, username }`（公开）    |
| POST   | /api/auth/logout                   | 登出（销毁会话）                            |
| GET    | /api/auth/me                       | 校验当前 token，返回用户名                  |
| GET    | /api/apps                          | 应用列表                                    |
| POST   | /api/apps                          | 创建应用，返回 AppRecord（appId/appSecret） |
| GET    | /api/apps/:appId/secret            | 查看密钥                                    |
| POST   | /api/apps/:appId/regenerate-secret | 重置密钥（旧密钥立即失效）                  |
| DELETE | /api/apps/:appId                   | 删除应用（该 app 数据不再可查）             |

### 11.4 指标口径补充

- `AggregatedMetrics` 增加 `errorClasses: Record<string, number>`（前端错误分析饼图）。
- Dashboard KPI 阈值：成功率 <95% 红、P95 >30s 红、平均步数 >8 红；工具成功率分母排除
  blocked/skipped。

### 11.5 验收

- 后端：`pnpm --filter @aipack/observability-server test` 15/15 通过（含登录/创建应用/数据隔离/
  删除应用后 ingest 401/重置密钥用例）。
- 前端：`pnpm --filter @aipack/observability-server typecheck`（后端 + web）+ `build` 通过。
- 启动方式：`ADMIN_PASS=xxx pnpm --filter @aipack/observability-server dev`，
  浏览器打开 `http://localhost:8787` 登录 → 创建应用 → SDK 上报 → Dashboard 出数据 → Trace 下钻。
