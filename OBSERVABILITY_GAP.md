# observability-server 与目标架构差距分析

> 目标架构（自上而下）：
>
> ```
> Agent → SDK/Collector → MQ/Buffer(Kafka/NATS)
>                            ├─→ 实时/业务数据 (MySQL/PostgreSQL)：配置/用户/项目/Agent 定义
>                            └─→ 监控事件 (ClickHouse)：Trace / Token / Latency / Cost / Tool / Error Metrics
>                                  ↓
>                              Dashboard
> ```

本文档对照该目标架构，盘点 `@aipack-ai/observability-server` 当前实现与未实现项，并给出演进路径。

---

## 1. 当前实现盘点（已落地）

observability-server 当前是一个 **单进程、零依赖、开箱即用** 的可观测性 MVP，覆盖了目标架构最末端的「收集 → 落盘 → 查询 → Dashboard」链路。

| 层 | 实现 | 入口文件 |
|---|---|---|
| SDK | `@aipack-ai/observability`：6 类埋点事件（runs/spans/toolCalls/permissions/retries/events）+ HTTP 批量上报 + 本地缓存补报 + OTLP 旁路导出 + 采样率/脱敏钩子 + 版本字段 | [packages/observability/src/index.ts](file:///Users/peroluo/Document/github/aipack/packages/observability/src/index.ts) |
| 收集服务 | 单进程 `node:http`，同步落盘 + 内存聚合；支持 TLS、ingest 限流、静态文件托管 | [packages/observability-server/src/collector.ts](file:///Users/peroluo/Document/github/aipack/packages/observability-server/src/collector.ts) |
| 存储 | 单文件 SQLite（better-sqlite3，WAL）；表：apps / runs / spans / tool_calls / events / retry_attempts / alert_rules / alert_events | [packages/observability-server/src/store.ts](file:///Users/peroluo/Document/github/aipack/packages/observability-server/src/store.ts) |
| 聚合 | 内存滑动窗口（默认 60min，1min 桶）+ 在线对数直方图（p50/p95/p99）+ 多维度（model/tool/session/version）+ per-appId 隔离 | [packages/observability-server/src/aggregator.ts](file:///Users/peroluo/Document/github/aipack/packages/observability-server/src/aggregator.ts) |
| 查询 REST | `/metrics/{summary,timeseries,tools,versions}` `/traces` `/traces/:id`，支持 appId / version / 时间范围 / 状态 / 模型 / 工具过滤 | [packages/observability-server/src/server.ts](file:///Users/peroluo/Document/github/aipack/packages/observability-server/src/server.ts) |
| Prometheus | `/metrics/prometheus` 文本格式导出（counter/gauge，按 app_id 拆分） | [packages/observability-server/src/prometheus.ts](file:///Users/peroluo/Document/github/aipack/packages/observability-server/src/prometheus.ts) |
| 告警 | 规则 CRUD + 评估器（10 类指标 + 版本回归 regress_by）+ webhook 通知（指数退避重试，4xx 放弃）+ 冷却防抖 + 空数据防护 | [packages/observability-server/src/alerts/](file:///Users/peroluo/Document/github/aipack/packages/observability-server/src/alerts/rules.ts) |
| 面板 | React + Antd + ECharts：Dashboard / Traces / Alerts / Apps / Login 五页面 | [packages/observability-server/web/src/pages](file:///Users/peroluo/Document/github/aipack/packages/observability-server/web/src/pages) |
| 鉴权 | SDK 上报：appId + appSecret（恒时比较）；面板：username/password + HMAC 无状态 token（P2-3） | [packages/observability-server/src/auth.ts](file:///Users/peroluo/Document/github/aipack/packages/observability-server/src/auth.ts) |
| 数据保留 | `RETENTION_DAYS` 默认 30 天，定时 prune + 可选 VACUUM INTO 备份 | [packages/observability-server/src/collector.ts](file:///Users/peroluo/Document/github/aipack/packages/observability-server/src/collector.ts) |
| 健康检查 | `/healthz` 就绪探针 | [packages/observability-server/src/collector.ts](file:///Users/peroluo/Document/github/aipack/packages/observability-server/src/collector.ts) |

---

## 2. 对照目标架构 — 缺失项

| 目标架构层 | 现状 | 缺失内容 |
|---|---|---|
| **MQ / Buffer（Kafka/NATS）** | ❌ 无 | 当前为直 HTTP 同步落盘，无消息队列缓冲。大流量 / 收集服务宕机时只能靠 SDK 本地文件缓存补报（默认 2000 条上限）。**缺**：削峰、跨实例消费、事件订阅下游、回放能力 |
| **实时/业务数据 MySQL/PostgreSQL** | ❌ 无 | 当前只有 SQLite 单表 `apps`（appId/appSecret/name）。**完全没有**：用户表、组织/团队表、项目表、Agent 定义表（system prompt / tools 白名单 / model / 参数）、ACL/权限关系表。无 RBAC，多租户只靠 appId 字符串隔离 |
| **监控事件 ClickHouse** | ❌ 无 | 当前 SQLite 装所有明细（runs/spans/tool_calls/events/retry_attempts）。监控事件未走列式存储。**无法支撑**：亿级 Trace 检索、按 token/cost 维度的高基数聚合、长周期（>30 天）留存查询。已内置 `retention.days=30` 默认清理 |
| **水平扩展** | ❌ 无 | 聚合器是进程内 `Map`，多实例会丢窗口数据；SQLite 不支持并发写。无法横向扩 collector |
| **Dashboard：Token / Cost / Latency 火焰图** | 🟡 部分 | 已有 requests/successRate/p95/p99/retryRate/工具成功率/版本对比。**缺失**：①Token 成本核算（无模型价格表，无法换算 $）②Trace 瀑布图（仅有 spans 列表，无时间轴可视化）③Tool 调用链路剖析 ④错误归因下钻 ⑤Session 维度轨迹回放 |
| **Agent 定义生命周期** | ❌ 无 | Agent 配置（system prompt、tool 白名单、模型、参数）无存储、无版本化，无法在面板编辑/发布/回滚。`apps` 表只管上报鉴权，不管 Agent 定义 |
| **多用户/多项目** | ❌ 无 | 只有单个 `ADMIN_USER/ADMIN_PASS`。无用户注册、无项目分组、无「某用户在某项目下看哪些 appId」的授权模型 |
| **历史数据归档/冷热分层** | ❌ 无 | 只有 `VACUUM INTO` 一次性全库备份，无冷数据归档到对象存储/ClickHouse 的管线 |
| **采样策略** | 🟡 简单 | SDK 已有 `sampleRate`（仅对 spans/toolCalls 采样，runs/events 全量）。**缺**：按错误优先采样、按慢请求采样、按 traceId 一致性采样（head-based） |
| **链路关联** | 🟡 部分 | 已有 traceId / spanId / sessionKey。**缺**：跨进程上下文传播（W3C Trace Context / B3）、与外部 OpenTelemetry 链路打通 |
| **PII 脱敏** | 🟡 钩子 | SDK 已暴露 `redact` 钩子。**缺**：内置脱敏规则（手机号/邮箱/身份证）、字段级策略、面板可配置 |

---

## 3. 演进路径（按优先级）

### 阶段 A — 存储分层（解耦业务 vs 监控）

- `TraceStore` 接口已抽象（[store.ts#L58](file:///Users/peroluo/Document/github/aipack/packages/observability-server/src/store.ts#L58)），新增 `ClickHouseTraceStore` 实现，保留 `SQLiteStore` 作为零依赖默认
- 业务库用 PostgreSQL（users / projects / project_apps / agent_definitions / acl），collector 通过依赖注入切换 store
- 兼容性：collector 不感知后端类型，仅按接口编程

### 阶段 B — 用户/项目/Agent 定义模型

- 新增表（建议放 PostgreSQL）：
  - `users`（id / email / password_hash / created_at）
  - `projects`（id / name / owner_id）
  - `project_apps`（project_id / app_id）— 把现有 `apps` 接入项目层级
  - `agent_definitions`（id / project_id / name / version / system_prompt / tools / model / params / created_by / created_at）
  - `acl`（user_id / project_id / role: owner|editor|viewer）
- 面板加 RBAC：用户 → 项目 → appId 三层授权
- 面板加 Agent 定义编辑器（YAML/JSON + 模板），发布即生成新 version，支持回滚

### 阶段 C — Cost 核算 + Trace 瀑布图

- 引入 `model_prices` 表（model_id / input_per_1k / output_per_1k / cache_read_per_1k / cache_write_per_1k / currency / effective_at）
- span 落盘时记录 `cost_cents`，summary 加 `totalCost` 维度，Dashboard 加成本卡片与趋势图
- `TracesPage` 已有 spans 数据，前端加 ECharts Gantt 瀑布图（无需后端改动）

### 阶段 D — MQ 引入（仅在流量超出单机承载时）

- collector ingest → Kafka/NATS topic → worker 消费落盘；SDK 协议不变
- 多 worker 实例并行消费，写入 ClickHouse 批量提交
- 当前 HTTP + 本地缓存方案在中小流量下已足够，**过早引入 MQ 会增加运维成本**，建议按需启动

### 阶段 E — 多实例部署 + 长周期留存

- 聚合器抽到 Redis（共享滑动窗口）或改为全走 ClickHouse 直查（牺牲实时性换无状态）
- 冷数据归档管线：SQLite/CH 热表 → 30 天后归档到对象存储（S3/OSS）Parquet 格式
- 长周期查询走 Parquet（Athena/Presto/ClickHouse S3 表引擎）

---

## 4. 一句话总结

当前 observability-server 是一个**单进程、零依赖、开箱即用**的可观测性 MVP（SQLite + 内存聚合 + REST + 面板 + 告警 + Prometheus 导出），覆盖了目标架构最末端的「收集 → 落盘 → 查询 → Dashboard」链路。

**未实现的部分集中在分布式扩容层**（MQ / 关系型业务库 / 列式监控库 / 多租户 RBAC / Agent 定义管理 / Cost 核算），这些是把它从「单团队工具」升级为「平台型可观测服务」所必需的能力。

按阶段 A → B → C → D → E 渐进演进，每一步都向后兼容（接口抽象已就位，SQLiteStore 始终保留为零依赖默认实现）。
