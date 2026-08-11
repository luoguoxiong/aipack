# @aipack/observability-server — aipack 可观测性收集服务（S2）

接收各应用 SDK（`@aipack/observability`）的埋点上报，统一完成 **SQLite 落盘 + 内存聚合 + REST 查询**。

## 启动

```bash
cp .env.example .env   # 修改 OBS_APPS 为你的 appId:appSecret 白名单
pnpm --filter @aipack/observability-server dev
```

或构建后全局安装使用 bin：`pnpm --filter @aipack/observability-server build && pnpm --global add .`

## 客户端接入（一行注入）

```ts
import { createObservability } from '@aipack/observability';

const obs = createObservability({
  appId: 'travel-app',
  appSecret: 'sk-travel123',        // 与收集服务 OBS_APPS 白名单匹配
  endpoint: 'http://localhost:8787', // 默认即此地址
});
createRuntime({ ..., telemetry: obs.telemetry });
```

上报失败自动写入本地缓存（`./.aipack/observability/{appId}.json`），收集服务恢复后自动补报。

## 查询 API

| 端点 | 说明 |
|---|---|
| `GET /metrics/summary?since&until&groupBy=model\|tool\|session` | 聚合摘要（requests/successRate/costUsd/p50/p95/p99/retryRate） |
| `GET /metrics/timeseries?since&until&step&metric` | 时间序列 |
| `GET /metrics/tools?since&until` | 工具成功率排行（升序） |
| `GET /traces?since&until&status&model&tool&page` | 运行列表 |
| `GET /traces/:traceId` | Trace 明细（spans 时间线） |

## 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `DB_PATH` | `.aipack/collector.db` | SQLite 文件 |
| `OBS_APPS` | 必填 | `appId:appSecret`，多应用逗号分隔 |

## 数据模型

- `runs`：一次 run/stream（trace 根）
- `spans`：run / model / tool 时间线（model span 含 attempts/cost/session_key）
- `tool_calls`：工具调用明细
- 权限拦截仅计入聚合计数（`summary.permissionDenied`），不落库
