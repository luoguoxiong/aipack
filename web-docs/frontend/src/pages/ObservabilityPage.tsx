import { Alert, Divider, Tag } from 'antd';
import {
  LineChartOutlined,
  NodeIndexOutlined,
  DashboardOutlined,
  FireOutlined,
  ApiOutlined,
  ClockCircleOutlined,
  BugOutlined,
  DatabaseOutlined,
} from '@ant-design/icons';
import CodeBlock from '../components/CodeBlock';
import {
  obsTelemetryCode,
  obsTraceDesignCode,
  obsMetricsCode,
  obsS2SetupCode,
  obsS2CollectorCode,
  obsS2RestApiCode,
} from '../data/observabilityCode';

export default function ObservabilityPage() {
  return (
    <div>
      <h1 className="section-title">
        <LineChartOutlined style={{ color: '#6366f1' }} /> 可观测性
      </h1>
      <p className="section-subtitle">
        aipack 内置 <b>Telemetry</b> 轻量埋点接口：token 消耗量、成功率、响应耗时、
        step 长度、重试次数、工具成功率等生产指标开箱即出，一次 run 的完整链路
        可通过 <b>traceId</b> 回放。
      </p>

      {/* 事件时间线 */}
      <div style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <NodeIndexOutlined /> 事件时间线
        </h2>
        <div className="arch-container" style={{ marginTop: 16 }}>
          <div className="arch-layers">
            <div className="arch-layer">
              <div className="arch-label">run 级</div>
              <div className="arch-boxes">
                <div className="arch-box arch-box-core">
                  <ApiOutlined style={{ fontSize: 20 }} />
                  <div style={{ fontWeight: 700, marginTop: 4 }}>onRunStart</div>
                  <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4 }}>
                    入队时刻 queuedAt，配合 onRunEnd 求排队时长
                  </div>
                </div>
                <div className="arch-box arch-box-extension">
                  <DashboardOutlined style={{ fontSize: 20 }} />
                  <div style={{ fontWeight: 700, marginTop: 4 }}>onRunEnd</div>
                  <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4 }}>
                    turns / tokens / queuedMs / success / errorClass
                  </div>
                </div>
              </div>
            </div>
            <div className="arch-arrow">▼</div>
            <div className="arch-layer">
              <div className="arch-label">span 级</div>
              <div className="arch-boxes">
                <div className="arch-box arch-box-adapter">
                  <FireOutlined style={{ fontSize: 20 }} />
                  <div style={{ fontWeight: 700, marginTop: 4 }}>onModelCall</div>
                  <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4 }}>
                    attempts / tokens / durationMs / stream
                  </div>
                </div>
                <div className="arch-box arch-box-storage">
                  <BugOutlined style={{ fontSize: 20 }} />
                  <div style={{ fontWeight: 700, marginTop: 4 }}>onToolCall</div>
                  <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4 }}>
                    status: ok / error / blocked / skipped
                  </div>
                </div>
                <div className="arch-box arch-box-core">
                  <ClockCircleOutlined style={{ fontSize: 20 }} />
                  <div style={{ fontWeight: 700, marginTop: 4 }}>onRetry</div>
                  <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4 }}>
                    provider 内部退避重试，per-attempt 粒度
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <Alert
          type="info"
          showIcon
          message="全可选、不阻断"
          description="Telemetry 的每个回调都可选实现；上报失败不影响主流程。与 Extension 正交：Extension 面向'干预/注入'，Telemetry 面向'观测'。"
          style={{ marginBottom: 16 }}
        />
      </div>

      {/* 接入方式 */}
      <div id="setup" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <ApiOutlined /> 1. 接入方式
        </h2>
        <p style={{ lineHeight: 1.8, color: '#475569' }}>
          在 <code>createRuntime</code> 传入 <code>telemetry</code> 即可，
          无需改造业务代码。所有事件携带同一个 <code>traceId</code>，
          用于串联一次 run 内的模型/工具调用。
        </p>
        <CodeBlock code={obsTelemetryCode} language="typescript" />
      </div>

      {/* 事件一览 */}
      <div id="events" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <DashboardOutlined /> 2. 事件一览
        </h2>
        <table className="params-table">
          <thead>
            <tr>
              <th style={{ width: '22%' }}>事件</th>
              <th style={{ width: '18%' }}>触发时机</th>
              <th>关键字段</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><span className="param-name">onRunStart</span></td>
              <td>run()/stream() 入队</td>
              <td>traceId / sessionKey / queuedAt</td>
            </tr>
            <tr>
              <td><span className="param-name">onRunEnd</span></td>
              <td>run 完成（成功或失败均触发）</td>
              <td>
                traceId / <b>turnCount</b> / durationMs / queuedMs / activeMs / success /{' '}
                errorClass / tokens / ttftMs
              </td>
            </tr>
            <tr>
              <td><span className="param-name">onModelCall</span></td>
              <td>每次模型调用完成</td>
              <td>traceId / spanId / modelId / <b>attempts</b> / inputTokens / outputTokens / cacheRead / cacheWrite / durationMs / stream / errorClass</td>
            </tr>
            <tr>
              <td><span className="param-name">onToolCall</span></td>
              <td>每次工具执行完成</td>
              <td>traceId / spanId / toolName / durationMs / <b>status</b>（ok/error/blocked/skipped）/ success / errorClass</td>
            </tr>
            <tr>
              <td><span className="param-name">onRetry</span></td>
              <td>provider 内部退避重试</td>
              <td>traceId / provider / modelId / attempt / status（HTTP）/ delayMs / errorClass</td>
            </tr>
            <tr>
              <td><span className="param-name">onPermissionDenied</span></td>
              <td>权限策略拒绝工具</td>
              <td>traceId / toolName / permissions / args / reason</td>
            </tr>
          </tbody>
        </table>
        <Divider orientation="left">错误分类 errorClass</Divider>
        <p style={{ lineHeight: 1.8, color: '#475569' }}>
          复用 ai 层 <span className="param-type">AgentErrorCategory</span>：
          <Tag color="blue">retryable</Tag>
          <Tag color="orange">timeout</Tag>
          <Tag color="red">auth</Tag>
          <Tag color="purple">context-overflow</Tag>
          <Tag color="volcano">rate-limit</Tag>
          <Tag color="cyan">invalid-request</Tag>
          <Tag>unknown</Tag>
          <br />
          另加三类非模型错误：<Tag color="green">tool_error</Tag>
          <Tag color="geekblue">terminated</Tag>
          <Tag color="magenta">validation</Tag>
        </p>
      </div>

      {/* Trace 设计 */}
      <div id="trace" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <NodeIndexOutlined /> 3. Trace 设计
        </h2>
        <p style={{ lineHeight: 1.8, color: '#475569' }}>
          一次 run = 一条 Trace，模型/工具调用 = Span。所有 span 共享 traceId，
          无需手动传递；traceId 同时写入 <code>Result.metadata.traceId</code> 与会话消息，
          历史会话可回放复盘。
        </p>
        <CodeBlock code={obsTraceDesignCode} language="typescript" compact />
      </div>

      {/* 指标口径 */}
      <div id="metrics" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <LineChartOutlined /> 4. 生产指标口径
        </h2>
        <p style={{ lineHeight: 1.8, color: '#475569' }}>
          所有指标都来自 telemetry 事件，可直接对账到 Dashboard 与 SLO。
          token 消耗量在 provider 层按 input/output/cacheRead/cacheWrite 四类还原，
          无需自行汇总。
        </p>
        <CodeBlock code={obsMetricsCode} language="typescript" compact />
        <Alert
          type="warning"
          showIcon
          message="两个口径坑"
          description={
            <span>
              ① 工具成功率只认 <b>ok</b>，blocked/skipped 不计入分母；
              <br />
              ② 重试次数看 <b>attempts-1</b>（attempts 含首次调用），重试耗尽场景由
              <b>attempts + errorClass</b> 兜底（onRetry 仅在真正重试时触发）。
            </span>
          }
          style={{ marginBottom: 16 }}
        />
      </div>

      {/* S2 聚合存储 */}
      <div id="s2" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <DatabaseOutlined /> 5. 埋点上报与后台收集（双包）
        </h2>
        <p style={{ lineHeight: 1.8, color: '#475569' }}>
          生产落地拆两个包：<b>@aipack-ai/observability</b>（上报 SDK，零重依赖）+
          <b> @aipack-ai/observability-server</b>（收集服务，独立部署）。客户端只需{' '}
          <code>appId + appSecret</code>，6 类 telemetry 事件自动批量 POST 到收集服务；
          收集端统一完成 SQLite 落盘（runs / spans / tool_calls）+ 内存聚合
          （p50/p95/p99 在线直方图），并提供 REST 查询 API。上报失败自动写本地缓存，
          收集服务恢复后补报——事件路径零阻塞、失败不阻断 run()。
        </p>
        <h3 className="subsection-title" style={{ fontSize: 16, marginTop: 24 }}>
          客户端接入（@aipack-ai/observability）
        </h3>
        <CodeBlock code={obsS2SetupCode} language="typescript" />
        <h3 className="subsection-title" style={{ fontSize: 16, marginTop: 24 }}>
          后台收集服务（@aipack-ai/observability-server）
        </h3>
        <CodeBlock code={obsS2CollectorCode} language="bash" />
        <h3 className="subsection-title" style={{ fontSize: 16, marginTop: 24 }}>
          查询 API
        </h3>
        <CodeBlock code={obsS2RestApiCode} language="bash" compact />
        <Alert
          type="info"
          showIcon
          message="鉴权与存储可替换"
          description="上报采用 appId + appSecret 鉴权（收集端 OBS_APPS 白名单）。存储抽象为 TraceStore 接口（insert / query runs/spans/tool_calls），后续可换成 Elasticsearch 或对接 OTLP → Prometheus/Tempo，聚合器与 REST API 无需改动。指标口径与第 4 节一致，可直接对账。"
          style={{ marginTop: 16 }}
        />
      </div>

      <Divider />
      <div style={{ padding: 24, background: '#f0fdf4', borderRadius: 12, border: '1px solid #bbf7d0' }}>
        <h3 style={{ marginTop: 0, color: '#166534' }}>💡 与 Extension 的分工</h3>
        <ul style={{ color: '#14532d', lineHeight: 2 }}>
          <li>要"观测"（指标、Trace、token 消耗量） → <b>Telemetry</b>（本页）+ <b>@aipack-ai/observability</b>（第 5 节：聚合 + SQLite + REST API）</li>
          <li>要"干预"（改请求/上下文、block/terminate 工具） → <b>Extension / Tool Hooks</b></li>
          <li>指标口径与 token 汇总已内置（provider 还原 input/output/cache 四类 token），无需自行实现</li>
        </ul>
      </div>
    </div>
  );
}
