# Observability 生产化补齐路线图

> 前置：S1 采集层 + S2 收集服务/面板已交付（[observability.md](./observability.md) / [observability-s2.md](./observability-s2.md)）。
> 本路线图按优先级补齐「生产级」缺口，**P0 = 数据生命周期（retention）+ 告警（alerting）**，
> P1/P2/P3 依次推进，每档独立可验收、可独立合入。

---

## 总览

| 档位 | 主题 | 缺口 | 验收要点 |
| --- | --- | --- | --- |
| **P0** | 数据生命周期 | SQLite 明细（runs/spans/tool_calls）无限增长 | 配置保留天数后过期数据定时清理，删除走索引不阻塞 |
| **P0** | 告警 | 指标只展示不触发 | 规则 CRUD + 定时评估 + webhook 通知 + 事件历史 |
| P1 | 日志关联 | 无应用日志采集，log↔trace 断裂 | host 侧 structured log 注入 traceId |
| P1 | 标准协议 | 自研 JSON API 生态自锁 | OTLP exporter（档位 B）+ Prometheus 格式端点 |
| P1 | 传输安全 | 明文 http、无限流 | TLS 强制开关 + ingest 每应用限流 |
| P2 | 采集覆盖 | 无自定义事件/采样/脱敏/进程指标 | SDK 扩展 |
| P2 | 重试细节 | `onRetry` 事件被 SDK 丢弃 | per-attempt 维度（429/5xx 分类、退避分布） |
| P2 | 部署运维 | 无容器化/healthcheck/备份 | Dockerfile + `/healthz` |
| P3 | 高可用/生态 | 单机单库、自研面板自锁 | TraceStore 可插拔（PG/ES）、Langfuse adapter |

---

## P0-1 · Retention（数据保留策略）

### 现状问题

[store.ts](../../packages/observability-server/src/store.ts) 的 runs / spans / tool_calls 三表只增不删：

- SQLite 文件无限膨胀，`/traces` 列表、Trace 下钻随数据量变慢；
- 无数据保留策略，无法对齐「明细保留 N 天」的运维/合规要求；
- 内存聚合器（[aggregator.ts](../../packages/observability-server/src/aggregator.ts)）有 60min 滑动窗口，但**明细**无任何清理。

### 设计

新增配置（[config.ts](../../packages/observability-server/src/config.ts) / `.env.example`）：

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `RETENTION_DAYS` | 30 | 明细保留天数 |
| `PRUNE_INTERVAL_MS` | 3_600_000 | 清理周期（1h） |
| `PRUNE_AT_STARTUP` | true | 启动时先清理一次 |
| `PRUNE_BACKUP` | false | 可选：清理前 `VACUUM INTO` 快照到 `backup/` |

核心改动：

1. **`SQLiteStore.prune(before: number): number`** —— 事务内按 `started_at` 批量删除 runs / spans 过期行，并清理孤儿 tool_calls，返回删除总数；
2. **新增 started_at 索引（删除性能前提）**：当前 spans 只有 trace 索引，按时间删除会全表扫。`tool_calls` 无时间戳字段（`ToolCallRecord` 未含 `startedAt`），故不建 started_at 索引，改随其 trace 的 runs 删除而清为孤儿（`NOT EXISTS` 子查询，走 runs 主键 + tool_calls trace 索引）：

   ```sql
   CREATE INDEX idx_spans_started ON spans(started_at);
   -- tool_calls 孤儿清理（不新增列，随 run 删除）：
   DELETE FROM tool_calls WHERE NOT EXISTS (SELECT 1 FROM runs WHERE runs.trace_id = tool_calls.trace_id);
   ```

3. **定时任务**：collector 层启动 `setInterval`（`unref()` 不阻塞进程退出），`close()` 时清除；
4. **文件收缩**（better-sqlite3 删除后文件不自动缩小）：
   - 新建库：建表前 `PRAGMA auto_vacuum = INCREMENTAL`，每次清理后 `PRAGMA incremental_vacuum(2000)`；
   - 存量库：不自动改该持久化 pragma（需 VACUUM 才生效），文档说明可在维护窗口手动 `VACUUM`。
5. 清理执行结果落一条服务日志（删除行数 / 耗时），便于对账。

### 改动文件

| 文件 | 改动 |
| --- | --- |
| `src/config.ts` | 解析 4 个新配置项 |
| `src/store.ts` | `prune()` + 2 个新索引 + auto_vacuum（新库） |
| `src/collector.ts` | 装配 prune 定时器 + close 清理 |
| `test/observability-server.test.ts` | 预置过期/新鲜数据 → 触发 prune → 断言只删过期 |

### 验收

- `RETENTION_DAYS=0` + 预置 30 天前数据 → 启动后过期批次清空、新数据保留；
- 清理按索引执行，万级行数清理无明显阻塞；`close()` 后无残留定时器。

---

## P0-2 · Alerting（告警）

### 现状问题

[observability.md](./observability.md) §3 已定义告警阈值（成功率 <95%、P95 >30s、平均步数 >8、重试率 >20%、工具成功率 <80%、429 突增、权限拦截激增、成本超预算），但实现只到「面板展示」，**无触发、无通知、无历史**。

### 设计

指标来源全部复用现有内存聚合器（O(1) 评估，无需 SQL 聚合）：

| 指标 | 来源（[aggregator.ts](../../packages/observability-server/src/aggregator.ts)） | 规则示例 |
| --- | --- | --- |
| 成功率 | `summary(appId, since=now-lookback)` | < 95% 持续 ≥ 2 个评估周期 |
| P95 耗时 | `summary().p95Ms` | > 30s |
| 平均步数 | `summary().avgTurns` | > 8 |
| 重试率 | `summary().retryRate` | > 0.2 |
| 工具成功率 | `tools()` | 某工具 < 80% |
| 429/错误突增 | `summary().errorClasses['rate-limit']` | 单周期内新增 > N |
| 权限拦截 | `summary().permissionDenied` | 周期内 > N |
| token 消耗超预算 | `summary().totalTokens` / 按天 `timeseries` | 日消耗 > 预算 |

新增模块 `src/alerts/`：

| 模块 | 职责 |
| --- | --- |
| `rules.ts` | 规则模型 + 校验（appId、metric、比较符、阈值、lookback、cooldown、webhook） |
| `evaluator.ts` | 评估循环（默认每 60s）：算指标 → 状态机 `firing / recovered` + 冷却防重复通知 |
| `notify.ts` | 通知渠道：webhook JSON POST（企业微信/Slack/飞书通用格式）+ console 兜底；失败重试 2 次指数退避 |

持久化与 API（Bearer 会话，与面板一致）：

- `alert_rules` 表（面板 CRUD）+ `alert_events` 表（触发/恢复历史，含指标值与阈值）；
- `GET/POST/PUT/DELETE /api/alerts/rules`、`GET /api/alerts/events`、`POST /api/alerts/rules/:id/test`（手动触发测试通知）；
- 面板新增「告警规则」页：规则列表 + 创建/编辑 + 事件历史 + 测试通知。

装配方式：`createCollector` 可选注入 `alerts?` 配置（`enabled / evaluateIntervalMs / rulesFile 或 DB 表`），CLI 与嵌入宿主均可用。

### 改动文件

| 文件 | 改动 |
| --- | --- |
| `src/alerts/rules.ts`（新） | 规则模型/校验 |
| `src/alerts/evaluator.ts`（新） | 评估循环 + 状态机 |
| `src/alerts/notify.ts`（新） | webhook 通知 + 重试 |
| `src/store.ts` | alert_rules / alert_events 表 + CRUD |
| `src/server.ts` | `/api/alerts/*` 路由 |
| `src/collector.ts` | 装配 evaluator |
| `web/` 面板 | 告警规则页 + 事件页 |
| `test/observability-server.test.ts` | 规则 CRUD、阈值触发→firing、恢复→recovered、webhook 收到 payload（本地 mock 端口） |

### 验收

- 面板创建规则（appId、metric、阈值、lookback、cooldown、webhook）→ 构造低于阈值数据 → 规则转 `firing` 且 webhook 收到 payload；
- 数据恢复 → 转 `recovered` 并发送恢复通知；cooldown 内不重复通知；
- `test` 端点可手动触发一次测试通知。

---

## P1 · 日志关联 + 标准协议 + 传输安全（已实现）

> 三项目标均已落地。与初稿相比的**实现偏差**：
>
> 1. **OTLP 采用无外部依赖的手写 JSON 方案**（未引 `@opentelemetry/exporter-trace-otlp-http`）：直接按 protobuf JSON 编码把 `EventBatch` 映射为 `ExportTraceServiceRequest`，POST 到 Collector 的 `/v1/traces`。由于 SDK 的 traceId/spanId 是任意字符串，用 md5 做 16/8 字节的确定性映射（同一字符串恒得同一 base64 字节序列）。理由：零新增依赖、体积最小；若需完整 W3C traceparent 传播语义留待 P3 换正式 exporter。
> 2. **`GET /metrics/prometheus` 设计为无鉴权**（方案未明确）：只暴露聚合窗口指标、不含明细，便于 Prometheus/Blackbox 抓取；`/metrics/*` 面板查询仍走 Bearer 会话。
> 3. **限流默认宽松**：`INGEST_RATE=100/s`、burst=200（误伤概率低），429 时客户端 `HttpReporter` 走缓存补报无缝衔接。
> 4. **日志关联只约定输出格式与 traceId 注入**（host 侧结构化日志），不做日志上报，避免与现有上报链路耦合。

### P1-1 日志关联

- SDK 新增 `createLogger(opts)`（[logger.ts](../../packages/observability/src/logger.ts)）：logfmt/JSON 两种格式、`level` 过滤、`child()` 派生、敏感字段自动脱敏（`secret|token|password|key|authorization|apikey` → `***`）；
- `telemetry.currentContext()` 返回 in-flight run 的 traceId（[telemetry.ts](../../packages/observability/src/telemetry.ts)：onRunStart 入栈、onRunEnd 出栈，并发时取最近开始）；
- `createObservability` 直接暴露 `obs.logger`，默认 `context: () => telemetry.currentContext()`，run 内日志自动带 `traceId=`；
- 服务端：`LOG_STREAM_URL_TEMPLATE`（`%s` 替换 traceId）+ `GET /api/meta`，面板 Trace 详情抽屉在配置后显示「查看日志」跳转按钮。

### P1-2 标准协议

- **OTLP**（[otlp.ts](../../packages/observability/src/otlp.ts)）：`createObservability({ otlp: { endpoint, serviceName, headers } })` 可选启用；旁路导出（best-effort，失败仅 warn 不影响主上报）；无 trace 数据的纯 tool/permission 批次不产生请求。
- **Prometheus**（[prometheus.ts](../../packages/observability-server/src/prometheus.ts)）：`GET /metrics/prometheus` → `text/plain; version=0.0.4`，导出全局 + 每应用（`app_id` 标签）共 12 类指标（requests/success_ratio/retry_rate/avg_turns/p50-99_ms/tokens_total/permission_denied/errors{class}/tool_calls{tool}/tool_success_ratio）。语义：counter 类按聚合窗口计数近似导出（重启/窗口滑动会跳变，严格 counter 留待 P3）。

### P1-3 传输安全

- **TLS**：`TLS_KEY`/`TLS_CERT` 都配置时 `createCollectorServer` 以 `https.createServer` 提供（面板 + ingest + 查询全加密）；新增公共导出 `createCollectorServer(collector, tls?)` 供 CLI 与宿主复用；
- **限流**（[rate-limit.ts](../../packages/observability-server/src/rate-limit.ts)）：ingest per-appId 令牌桶（容量=burst、每秒补充 rate，30min 空闲自动清理），超限 `429 + Retry-After: 1`，且客户端对 429 自动缓存补报。

### 改动文件

| 包 | 文件 | 改动 |
| --- | --- | --- |
| SDK | `src/logger.ts`（新） | 结构化 logger |
| SDK | `src/otlp.ts`（新） | OTLP/JSON exporter + `toOtlpJsonTraces` |
| SDK | `src/telemetry.ts` | `currentContext()`（in-flight traceId） |
| SDK | `src/index.ts` | `otlp?` 配置接线 + 导出 `logger`/`createOtlpTraceExporter` |
| SDK | `test/observability.test.ts` | logger/currentContext/OTLP 用例（+8） |
| Server | `src/prometheus.ts`（新） | Prometheus 文本渲染 |
| Server | `src/rate-limit.ts`（新） | TokenBucket + RateLimiter |
| Server | `src/collector.ts` | `/metrics/prometheus` 路由、限流装配、`createCollectorServer`、`/api/meta` 路由 |
| Server | `src/admin.ts` | `GET /api/meta` |
| Server | `src/config.ts` | TLS/rateLimit/logStreamUrlTemplate 解析 |
| Server | `src/cli.ts` | HTTPS 支持 + banner |
| Server | `web/` 面板 | `api.meta()` + Trace 详情「查看日志」入口 |
| Server | `test/observability-server.test.ts` | prometheus/限流/meta/TLS 用例（+6） |

### 验收

- 应用内 `obs.logger.info(...)` 在 run 进行中自动带 `traceId`，run 结束后不带；
- 配置 `LOG_STREAM_URL_TEMPLATE` 后面板 Trace 详情出现「查看日志」且链接含该 traceId；
- 配置 `otlp.endpoint` 后每次上报旁路 POST `/v1/traces`，Collector 拒绝/断连不影响主上报；
- `curl /metrics/prometheus` 无鉴权返回 `text/plain; version=0.0.4` 且含 `aipack_requests_total{app_id="..."}`；
- `TLS_KEY/TLS_CERT` 配置后服务变 `https://`，HTTPS ingest 正常；`INGEST_RATE=1` 时同一 app 连续第二次上报返回 429 + `Retry-After`。

## P2 · 采集覆盖 + 重试细节 + 部署运维（已实现）

> 状态：**已实现**（2026-08）。范围：P2 全量（采集覆盖 + 重试细节 + 部署运维）；
> 采样语义 = **明细采样**（spans/toolCalls 采样、runs 全量保聚合）；自定义事件在
> 面板 **Trace 详情时间轴**展示；会话持久化 = **SESSION_SECRET 无状态签名 token**
> （重启不失效、零文件状态；未配置时保留内存会话）。
>
> 落地要点：
> - 链路全通：agent `spanId` → SDK `onRetry`/`emit` → server `retry_attempts`/`events`
>   表 + `aggregator.ingestRetry` → Prometheus `aipack_retries_total{status=}` /
>   `aipack_retry_backoff_p50_ms` → 面板重试链 + 事件时间轴 + 聚合页重试分布；
> - 修复：`HttpReporter.mergeBatches`/`isEmpty`/`count`/`trimBatch` 补齐 retries/events
>   （此前 pending 队列合并会静默丢弃新字段）；
> - 验证：SDK 24 用例 + Server 33 用例全绿，agent/observability/observability-server
>   typecheck 通过，server build（tsup + vite 面板）通过。
>
> 设计细节与验收标准见下表。

### P2-1 采集覆盖（SDK @aipack-ai/observability）

| 项 | 设计 |
| --- | --- |
| 自定义事件 `obs.emit('event', { name, data? })` | 新 `EventRecord { traceId?, sessionKey?, name, data?, timestamp }`；run 内调用自动注入 `currentContext().traceId`，run 外仅记 sessionKey（如提供）；入 `EventBatch.events`。server 新表 `events(trace_id, session_key, name, data_json, ts)`，ingest 解析 + 落盘，面板 Trace 详情按 ts 与 span 时间轴混排显示事件徽标 |
| 采样率 `sampleRate` | `createObservability({ sampleRate: 0.1 })`（0–1，缺省 1）。**明细采样**：只对 `kind=model/tool` 的 spans 与 toolCalls 随机丢弃（命中采样）；runs / permissions / events 全量，保证聚合、告警、成本统计不失真 |
| 脱敏钩子 `redact` | `createObservability({ redact? })`：`(batch: EventBatch) => EventBatch`，send 前作用；示例改写 sessionKey/toolName/model 防 PII 明文上报；文档给出常用脱敏写法（复用 logger 的 REDACTED_KEYS 思路） |

### P2-2 重试细节（性能监控核心）

全链路打通 per-attempt 重试维度（当前仅 `retryRate` 一个聚合数）：

1. **agent**：[RetryTelemetryInfo](../../packages/agent/telemetry/index.ts#L118) 加可选 `spanId`，runtime 转发时带出 `streamModelEvents` 的局部 spanId；
2. **SDK**：`onRetry` 实现 → `RetryRecord { traceId, spanId, provider, modelId, attempt, errorClass, status?, delayMs, timestamp }`，入 `EventBatch.retries`；
3. **server**：
   - 新表 `retry_attempts(id, trace_id, span_id, provider, model_id, attempt, error_class, status, delay_ms, ts)`；
   - aggregator 新增 `ingestRetry(rec)`：状态分布（按 status / errorClass 分类计数）+ delayMs 分位（P50/P95）；
   - Prometheus 扩展：`aipack_retries_total{status=}`、`aipack_retry_backoff_p50_ms`；
   - 查询：traceDetail 返回该 trace 的重试链（哪次 attempt、退避多久、最终成败）；summary 加重试分布；
4. **面板**：Trace 详情显示重试链；聚合页「重试分布」卡片；
5. **retention**：`prune()` 同步清理 events / retry_attempts（按 started 过期 + 孤儿）。

### P2-3 部署运维

| 项 | 设计 |
| --- | --- |
| Dockerfile | observability-server 单镜像：`pnpm build`（tsup + vite）→ `dist/` + `web/dist` 静态面板，`node dist/cli.js` 启动，EXPOSE 8787 |
| `/healthz` 就绪探针 | GET（无鉴权）：store 可达 → 200 `{ ok: true }`；DB 打开失败 → 503 |
| 面板会话持久化 | SessionManager 增加**无状态签名 token**模式：显式 `SESSION_SECRET`（缺省由 ADMIN_PASS 派生）时 token 改为 HMAC 签名（含过期时间），重启不失效、零文件状态；未配置时保留现有内存 Map（行为不变） |
| 备份 | docs 补充运维说明：`PRUNE_BACKUP`（VACUUM INTO）+ cron/手动备份示例 |

### 改动文件

| 包 | 文件 | 改动 |
| --- | --- | --- |
| agent | `telemetry/index.ts`、`runtime/index.ts` | RetryTelemetryInfo 加 spanId + 转发带出 |
| SDK | `types.ts` | EventRecord / RetryRecord + EventBatch 扩展 |
| SDK | `telemetry.ts` | onRetry 实现、emit()、采样、redact 挂载 |
| SDK | `index.ts` | createObservability 暴露 emit/采样/redact 接线 |
| SDK | `reporter.ts` | 合并/判空/计数/裁剪补齐 retries/events（修复静默丢弃） |
| SDK | `test/` | emit/采样/redact/onRetry、合并批次保留新字段用例 |
| Server | `store.ts` | events / retry_attempts 表 + flush + prune + 查询 |
| Server | `aggregator.ts` | ingestRetry + 重试分布聚合 |
| Server | `collector.ts` | ingest 解析新字段、/healthz 路由 |
| Server | `prometheus.ts` | retries/backoff 指标 |
| Server | `server.ts` / `auth.ts` | traceDetail 重试链、summary 分布、签名 token |
| Server | `web/` 面板 | Trace 详情事件时间轴 + 重试链、聚合页重试分布 |
| Server | `Dockerfile`（新） + `docs` | 容器化 / 备份运维说明 |
| Server | `test/` | events/retries、healthz、签名 token、retention 新表 |

### 验收

- 应用内 `obs.emit('event', {...})` → Trace 详情时间轴出现事件徽标（带 data 展示）；
- `sampleRate: 0.5` 时模型/tool span 与 toolCalls 上报量约为原来一半，run/成本聚合不变；
- `redact` 回调把 sessionKey 改写后，ingest 落库值为改写值；
- provider 重试一次 → Trace 详情出现「第 1 次重试（429，退避 500ms）」链，`/metrics/prometheus` 出现 `aipack_retries_total{status="429"} 1`；
- `RETENTION_DAYS` 清理后 events/retry_attempts 同步清空；
- `curl /healthz` 无鉴权 200；配 `SESSION_SECRET` 后重启进程 token 仍有效；`docker build` 可出镜像并启动。

## P3 · 高可用 / 生态对接（可选）

7. **高可用/存储可插拔**：`TraceStore` 增加 Postgres / Elasticsearch 实现（接口已预留，[store.ts](../../packages/observability-server/src/store.ts)），支撑多实例与全文检索。
8. **LLM 平台零代码备选**：Langfuse / Helicone adapter（只传 `traceId`，[observability.md](./observability.md) §5 档位 C）。
9. **面板增强**：成功/失败 trace 并排对比，快速定位回归点。
