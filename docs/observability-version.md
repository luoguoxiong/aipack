# Observability 版本维度与版本对比设计（V1）

> 现状：S1 采集层 + S2 收集服务/面板 + P0-P2（retention / alerting / 日志关联 / OTLP+Prometheus / TLS+限流 / 采集覆盖 / 重试细节 / 部署运维）已交付。
> 本方案在现有 `appId` / `model` / `tool` / `session` 维度之外，新增「发布版本」维度，支撑跨版本指标对比（性能、成功率、工具错误率等），形成「发布 → 观测 → 优化 → 再发布」的持续优化闭环。
>
> 决策（用户确认）：① 本期范围 = 方案文档，不改代码；② 版本注入 = 手动配置 `createObservability({ version })`。

---

## 1. 目标与非目标

### 1.1 目标

| #             | 目标                             | 验收落点                                                                                                         |
| ------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| G1            | 上报链路携带 `appVersion` 并落库 | RunRecord 字段 + runs 表列 + 迁移                                                                                |
| G2            | 按版本的聚合指标查询             | `GET /metrics/versions`（successRate / p50/p95/p99 / tokens / avgTurns / retryRate / 工具错误率 / errorClasses） |
| G3            | 面板支持版本维度查看与两版本对比 | Dashboard 版本筛选 + 对比卡片                                                                                    |
| G4（P1 可选） | 告警支持「版本回归」检测         | alerting 新增版本对比规则                                                                                        |

### 1.2 非目标

- **不做 SDK 自身版本（sdkVersion）自动上报**：字段预留但本期不实现，SDK 版本与业务优化目标无关。
- **不改 retention**：沿用现有保留策略，版本对比数据随明细过期而回收。
- **不做分布式链路聚合**：版本维度只服务单机收集服务。
- **权限拦截计数（permissionDenied）不按版本落库**：`PermissionRecord` 目前仅入内存聚合器不落库（[types.ts](../../packages/observability/src/types.ts) 注释），versions API 不提供该字段；如后续需要，单独落库权限表。

---

## 2. 数据模型

### 2.1 `RunRecord.appVersion?`

```ts
// packages/observability/src/types.ts
export interface RunRecord {
  // ...
  /** 发布版本（接入方 agent 应用版本，如 '1.3.0'）。可空：旧 SDK / 未配置时缺省，服务端归入 unknown */
  appVersion?: string;
}
```

- **放 run 级而非每条 span/toolCall**：run 是聚合主键，spans/toolCalls 通过 `traceId` 关联回 run，避免逐条冗余、避免"同一 run 跨版本"的分裂。
- **命名用 `appVersion`** 而非泛化 `version`：避免与 SDK 版本、协议版本混淆。

### 2.2 SDK 注入链

```
createObservability({ version: '1.3.0' })
  → HttpReporter 不变
  → ObservabilityTelemetry({ appVersion })     // 构造时注入，进程内恒一
  → onRunEnd → runRecord(info, queuedAt) 写入 RunRecord.appVersion
```

- **构造时注入而非每次 run 传参**：一个进程运行一个版本，避免重复传参与漏传。
- **语义约束**：`obs` 实例级版本；热升级需重建实例（`obs.close()` 后新版本重建），文档说明即可，不做动态切换。
- 缺省 `version` 时 `RunRecord` 不带该字段，完全向后兼容（旧 SDK 产物不变）。

---

## 3. 存储设计

### 3.1 runs 表新增 `version` 列

```sql
-- 新库 DDL 直接包含；存量库执行 ALTER TABLE 迁移（对齐 ensureAppIdColumns 的既有迁移模式）
ALTER TABLE runs ADD COLUMN version TEXT;
CREATE INDEX IF NOT EXISTS idx_runs_version ON runs(version);
```

- 迁移函数命名建议 `ensureVersionColumn(db)`，在 `SQLiteStore` 构造时探测 `PRAGMA table_info(runs)` 缺列则 ALTER。
- `queryRuns` 行映射带出 `version`（trace 列表/详情展示用）。
- 旧数据 `version` 为 `NULL`，查询时归入 `'unknown'`（对齐现有 `model ?? 'unknown'` 口径）。

### 3.2 为什么不复用内存聚合器（已实现：内存 version 维度作为补充）

[aggregator.ts](../../packages/observability-server/src/aggregator.ts) 是 **60min 滑动窗口**（1min 桶），只够"实时看"。跨版本对比是**长期视角**（周/月粒度），必须走 SQLite 落盘聚合（/metrics/versions）。

**已实现的补充**：内存聚合器新增 `version` 维度（`DimName='version'`），使**版本筛选对实时 KPI/时间序列/工具分析/错误分析生效**：

- `ingestRun` 时记录 `traceId → version` 映射，`ingestModelCall` / `ingestToolCall`（记录本身无版本字段）据此归入对应 version 维度桶；
- version 维度桶与全局桶**口径完全一致**（含工具调用计入 requests 的既有语义），保证"按版本查看"与"全部版本"数值可直接对照；
- `sweep` 同步清理窗口外的 trace→version 映射，防止无限增长；
- **边界**：model/tool/session 三个 groupBy 维度桶不按版本细分——`summary?groupBy=model` 在版本筛选下仍返回全部版本数据，面板模型排行卡片标注该口径（UI 说明）。

## 4. API 设计

### 4.1 `GET /metrics/versions?appId&since&until`

返回每个版本的聚合指标（DB 直查，非内存窗口）。需要面板登录（与现有 /metrics/\* 一致）。

**响应**：

```jsonc
{
  "items": [
    {
      "version": "1.3.0",
      "requests": 120,
      "successRate": 0.975,
      "p50Ms": 820,
      "p95Ms": 2100,
      "p99Ms": 3600,
      "totalTokens": 105000,
      "avgTurns": 2.1,
      "retryRate": 0.08,
      "errorClasses": { "rate_limit": 3 },
      "tools": {
        "echo": { "calls": 40, "successRate": 1, "avgMs": 120, "errors": 0 },
        "scrape": {
          "calls": 30,
          "successRate": 0.8,
          "avgMs": 980,
          "errors": 6,
        },
      },
    },
    // ... unknown 缺省版本归入 "unknown"
  ],
}
```

**实现要点**（`SQLiteStore.queryVersionMetrics(filter)`）：

- 基础聚合 `SELECT version, COUNT(*), SUM(...) FROM runs WHERE started_at 范围 [AND app_id=?] GROUP BY version`：
  - `successRate` = `status='success' AND error_class IS NULL` 占比（口径对齐 [aggregator.ts](../../packages/observability-server/src/aggregator.ts) `recordRun`）；
  - `totalTokens` = `input_tokens + output_tokens + COALESCE(cache_read,0) + COALESCE(cache_write,0)`（run 级四类 token 之和 = 模型 span 之和，口径一致）；
  - `avgTurns` = `AVG(turns)`。
- **分位数（p50/p95/p99）**：SQLite 无 percentile 聚合，`SELECT duration_ms ... ORDER BY duration_ms` 后在 JS 侧计算（或复用 [histogram.ts](../../packages/observability-server/src/histogram.ts)）；中等数据量（万级）毫秒级可接受，文档标注复杂度即可。
- **工具统计**：`JOIN tool_calls tc ON tc.trace_id = r.trace_id` 按 `tc.status` 分组（ok/error 计入分母，blocked/skipped 不计，口径对齐现有 /metrics/tools）。
- **retryRate**：`JOIN spans s ON s.trace_id = r.trace_id AND s.kind='model'`，`Σ(s.attempts-1) / model 调用数`。

### 4.2 对比：前端计算，不单独开 `/metrics/compare`

- 后端只提供 `versions` 数据源；**对比逻辑 = 前端纯函数** `compareVersions(a, b)`（同 key 相减/相除出 delta），面板一次拉全量即可本地渲染。
- 优点：避免后端双实现；告警侧（P1）如需对比，可在评估器内复用同一 `queryVersionMetrics` 查询。

### 4.3 采样口径说明

`sampleRate` 只采样 model/tool spans 与 toolCalls，**runs 全量**（[telemetry.ts](../../packages/observability/src/telemetry.ts) 既有设计）。因此：

- `requests / successRate / 耗时 / totalTokens` 不受采样影响，版本对比口径可靠；
- 工具错误率、retryRate 在小采样率下可能偏差（与现有 /metrics/tools 同类，属既有行为，不扩散）。

---

## 5. 面板设计（web/）

### 5.1 版本筛选（已实现）

- Dashboard 顶部「版本」筛选（与 appId 平级，单选 + "全部"），切换后 `summary / timeseries / tools` 附 `version` 过滤（依赖 §3.2 内存 version 维度）→ **KPI 卡片、时间序列、工具分析、错误分析随版本变化**；
- **模型排行（groupBy=model）不受版本筛选影响**（model 维度不按版本细分），卡片下方标注"模型维度数据未按版本细分，模型排行含全部版本"；
- 版本下拉选项来自 `GET /metrics/versions`（当前 appId + 时间范围内有数据的版本，DB 全量）。
- Traces 列表新增「版本」列（`appVersion`），并支持 `GET /traces?version=` 过滤（DB 直查，含 `unknown` 归并）。

### 5.2 版本对比卡片（已实现）

- 「版本对比」区块：选 vA / vB（缺省取最近两个有数据的版本，versions 按 `lastSeenAt` 倒序）→ 前端纯函数 `compareVersions(a, b)` 渲染 delta 表：

| 指标                                                                     | vA (1.2.0) | vB (1.3.0) | Δ   |
| ------------------------------------------------------------------------ | ---------- | ---------- | --- |
| 请求量 / 成功率 / P95 耗时 / Token 每请求 / 平均步数 / 重试率 / 错误次数 | …          | …          | …   |
| 工具成功率 · echo / scrape（合并两版本工具，按总调用量 Top 8）           | …          | …          | …   |

- 语义标注：Δ 列 ↑ 变好（绿）/ ↓ 变差（红）/ — 持平；工具行单侧无调用显示 "—"；
- 数据源为 DB 全量聚合（非窗口内），基于当前 appId 与时间范围。

---

## 6. 告警「版本回归」检测（G4，P1 可选）

目标：新版本发布后指标相对上一版本出现明显退化时主动告警，形成"持续优化"的自动化闭环。

设计草案：

- alerting 规则 `metric` 扩展 `versionSuccessRate`（或 `versionP95Ms`），新增算子 `regress_by`（对比最近两个版本，delta 超阈值触发）；
- evaluator 评估时调用 `queryVersionMetrics()` 取最近两个版本聚合做差；
- 冷启动防护：不足两个版本、任一版本请求量 < 阈值时不评估（对齐现有空数据防护）；
- 落 alert_rules/alert_events，webhook 载荷携带 `{ vA, vB, delta }`。

> 复杂度高于常规指标规则（涉及"最近两个版本"的状态判定），单独立项，不与本期 G1-G3 混排。

---

## 7. 兼容性与迁移

| 项                      | 处理                                                                    |
| ----------------------- | ----------------------------------------------------------------------- |
| 旧 SDK（无 appVersion） | 不上报该字段，`RunRecord` 可空                                          |
| 存量库                  | `ALTER TABLE runs ADD COLUMN version`（`ensureVersionColumn` 探测迁移） |
| 存量数据                | `version IS NULL` 归入 `'unknown'`                                      |
| 采样率                  | runs 全量，核心版本指标不受采样影响（§4.3）                             |
| 权限计数                | 不按版本提供（§1.2），文档标注                                          |

---

## 8. 改动文件清单与分阶段

### 阶段 1 — 数据链路（核心闭环）

| 包                   | 文件                                | 改动                                                                                          |
| -------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------- |
| observability        | `src/types.ts`                      | `RunRecord.appVersion?: string`                                                               |
| observability        | `src/index.ts`                      | `CreateObservabilityOptions.version` 透传                                                     |
| observability        | `src/telemetry.ts`                  | `FlushQueueOptions.appVersion` + `runRecord()` 注入                                           |
| observability        | `test/observability.test.ts`        | 版本透传 / 缺省不携带 用例                                                                    |
| observability-server | `src/store.ts`                      | runs `version` 列 + `ensureVersionColumn` + 索引 + `queryRuns` 带出 + `queryVersionMetrics()` |
| observability-server | `src/types.ts`                      | `VersionMetrics` 类型                                                                         |
| observability-server | `src/server.ts`                     | `GET /metrics/versions` 路由（鉴权 + appId 过滤）                                             |
| observability-server | `test/observability-server.test.ts` | versions 聚合 / appId 隔离 / unknown 归并 / 迁移 用例                                         |

### 阶段 2 — 对比展示

| 文件                              | 改动                                                |
| --------------------------------- | --------------------------------------------------- |
| `web/src/types.ts` / `api.ts`     | VersionMetrics 类型 + `versions()` 请求             |
| `web/src/pages/DashboardPage.tsx` | 版本筛选 + 版本对比卡片（`compareVersions` 纯函数） |
| `web/src/pages/TracesPage.tsx`    | 版本列展示                                          |

### 阶段 3（可选）— 告警版本回归（§6，单独立项）

---

## 9. 验收要点

- SDK：`createObservability({ version })` 后 run 上报带 `appVersion`；未配置时不带字段（兼容回归）。
- Server：两版本数据上报 → `GET /metrics/versions` 返回两行，successRate / 分位 / tokens / 工具错误率口径与现有聚合一致；`?appId` 隔离正确；存量库 ALTER 后 `NULL` 归 `unknown`。
- 面板：版本筛选与对比卡片 delta 数值正确（↑/↓ 语义标注）。
- 全链路：`pnpm typecheck` + 两包 `test` + `pnpm build` 全绿（沿用现有验证基线）。

---

## 10. 决策记录

| 决策         | 结论                                                                    | 理由                                                                                         |
| ------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 版本注入方式 | 手动配置 `createObservability({ version })`                             | 语义清晰、可控；自动读 package.json 语义可能不准                                             |
| 字段名       | `appVersion`                                                            | 避免与 SDK/协议版本混淆                                                                      |
| 版本放哪一层 | RunRecord（run 级）                                                     | 聚合主键，spans/toolCalls 经 traceId 关联，免冗余                                            |
| 对比数据源   | SQLite 直查（/metrics/versions）                                        | 内存聚合仅 60min 窗口，长期对比必须落盘                                                      |
| 对比计算位置 | 前端纯函数，后端不开 /metrics/compare                                   | 避免双实现；告警侧复用同一查询                                                               |
| 实时版本筛选 | 内存聚合器新增 version 维度（traceId→version 映射归入 spans/toolCalls） | 让"版本筛选"对 KPI/时间序列/工具/错误分析真实生效，而非死区；groupBy 维度不细分，UI 标注口径 |
