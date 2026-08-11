import { Alert, Divider, Tag } from 'antd';
import {
  LineChartOutlined,
  NodeIndexOutlined,
  DashboardOutlined,
  FireOutlined,
  ApiOutlined,
  ClockCircleOutlined,
  BugOutlined,
} from '@ant-design/icons';
import CodeBlock from '../components/CodeBlock';
import {
  obsTelemetryCode,
  obsTraceDesignCode,
  obsMetricsCode,
} from '../data/observabilityCode';

export default function ObservabilityPage() {
  return (
    <div>
      <h1 className="section-title">
        <LineChartOutlined style={{ color: '#6366f1' }} /> 可观测性
      </h1>
      <p className="section-subtitle">
        aipack 内置 <b>Telemetry</b> 轻量埋点接口：token 成本、成功率、响应耗时、
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
                    turns / tokens / costUsd / queuedMs / success / errorClass
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
                    attempts / tokens / costUsd / durationMs / stream
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
                errorClass / costUsd / tokens / ttftMs
              </td>
            </tr>
            <tr>
              <td><span className="param-name">onModelCall</span></td>
              <td>每次模型调用完成</td>
              <td>traceId / spanId / modelId / <b>attempts</b> / inputTokens / outputTokens / durationMs / stream / errorClass / costUsd</td>
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
          成本已按 <code>model.cost</code>（每百万 token 费率，含缓存价）在 provider 层算好，
          无需自行计价。
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

      <Divider />
      <div style={{ padding: 24, background: '#f0fdf4', borderRadius: 12, border: '1px solid #bbf7d0' }}>
        <h3 style={{ marginTop: 0, color: '#166534' }}>💡 与 Extension 的分工</h3>
        <ul style={{ color: '#14532d', lineHeight: 2 }}>
          <li>要"观测"（指标、Trace、成本） → <b>Telemetry</b>（本页）</li>
          <li>要"干预"（改请求/上下文、block/terminate 工具） → <b>Extension / Tool Hooks</b></li>
          <li>需要持久化指标与 Trace？可自行实现 Telemetry 落地（内存聚合 + SQLite + REST API）</li>
        </ul>
      </div>
    </div>
  );
}
