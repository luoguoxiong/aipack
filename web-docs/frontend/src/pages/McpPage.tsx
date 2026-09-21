import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { Alert, Card, Row, Col, Divider, Typography } from 'antd';
import {
  DeploymentUnitOutlined,
  RocketOutlined,
  ThunderboltOutlined,
  SettingOutlined,
  ApiOutlined,
  ShareAltOutlined,
  SyncOutlined,
  SafetyCertificateOutlined,
  CloudServerOutlined,
  CodeOutlined,
  LinkOutlined,
  CheckCircleOutlined,
  BulbOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import CodeBlock from '../components/CodeBlock';
import {
  mcpQuickstartCode,
  mcpJsonConfigCode,
  mcpServerConfigCode,
  mcpTransportsCode,
  mcpLifecycleCode,
  mcpAdapterCode,
  mcpProtocolCode,
  mcpSamplingCode,
  mcpServerHostCode,
  mcpStdioEntryCode,
  mcpSecurityCode,
  mcpCliCode,
  mcpDiagnosticsCode,
} from '../data/mcpCode';

const { Paragraph } = Typography;

const featureCards = [
  {
    icon: <ApiOutlined />,
    title: '双向打通生态',
    desc: '客户端方向消费外部 MCP Server 工具；服务端方向把 aipack 工具反向暴露给 Claude Desktop / Cursor',
  },
  {
    icon: <LinkOutlined />,
    title: '远端工具即原生 Tool',
    desc: 'MCP 工具一经包装即获得 runtime 全套能力：权限审批 / 超时 / 钩子 / telemetry / 并行调用',
  },
  {
    icon: <CodeOutlined />,
    title: '零运行时依赖',
    desc: '自研 JSON-RPC 2.0 编解码 + MCP 核心协议子集，不引入官方 SDK，对齐仓库零依赖约定',
  },
  {
    icon: <ShareAltOutlined />,
    title: '三种传输层',
    desc: 'stdio（子进程）/ Streamable HTTP / legacy SSE，本地与远程 server 全覆盖',
  },
  {
    icon: <SettingOutlined />,
    title: '.mcp.json 生态兼容',
    desc: '社区事实标准格式（Claude Code / Cursor 通用），项目级优先于用户级，CLI 自动生效',
  },
  {
    icon: <SyncOutlined />,
    title: '惰性连接 + 热刷新',
    desc: 'beforeRun 懒连接零模板代码；refresh() 重连断线并完整移除已消失工具，list_changed 自动同步',
  },
];

const serverConfigRows = [
  { name: 'name', type: 'string', def: '—', desc: '唯一标识；默认同时作为工具名前缀' },
  { name: 'transport', type: 'McpTransportConfig', def: '—', desc: '传输层配置：stdio / http / sse（见「传输层」）' },
  { name: 'enabled', type: 'boolean', def: 'true', desc: 'false 时跳过连接，配置文件中保留条目' },
  { name: 'toolPrefix', type: 'string', def: '= name', desc: '工具名前缀；传空字符串可禁用前缀' },
  { name: 'toolFilter', type: 'string[] | (rawName) => boolean', def: '—', desc: '工具白名单，按 MCP 原始名匹配' },
  { name: 'timeoutMs', type: 'number', def: 'runtime.toolTimeoutMs', desc: '该 server 单次调用超时' },
  { name: 'permissions', type: 'string[]', def: `['mcp:<name>']`, desc: '覆盖包装工具的权限标记' },
];

const pluginRows = [
  { name: 'registry', desc: 'McpRegistry：多 server 管理、程序化 callTool / getStatus' },
  { name: 'extensions', desc: 'Extension[]：注入 Runtime 即生效' },
  { name: 'diagnostics', desc: '当前诊断快照（连接错误 / 冲突 / 警告）' },
  { name: 'ready()', desc: '预热连接（可选；不调用则首次 run 时懒连接）' },
  { name: 'refresh()', desc: '热刷新：断线重连 + 重新拉取工具列表' },
  { name: 'dispose()', desc: '关闭所有子进程 / HTTP 连接' },
  { name: 'install()', desc: '供 aipack.config.js 展开的 extensions' },
];

export default function McpPage() {
  const location = useLocation();

  useEffect(() => {
    const id = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
    if (!id) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    const tryScroll = () => {
      const el = document.getElementById(id);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return true;
      }
      return false;
    };
    if (!tryScroll()) {
      setTimeout(tryScroll, 50);
    }
  }, [location.hash]);

  return (
    <div>
      <h1 className="section-title">
        <DeploymentUnitOutlined style={{ color: '#6366f1' }} /> MCP 生态互操作
      </h1>
      <p className="section-subtitle">
        <b>@aipack-ai/mcp</b> 双向打通 Model Context Protocol 生态：客户端方向连接外部 MCP Server
        并把远端工具包装为原生 <code>Tool</code>；服务端方向把 aipack 工具反向暴露为标准 MCP Server。
        零运行时依赖，自研 JSON-RPC 2.0 编解码 + MCP 核心协议子集。
      </p>

      {/* 特性矩阵 */}
      <div id="overview" style={{ scrollMarginTop: 100 }}>
        <Row gutter={[16, 16]} style={{ marginBottom: 32 }}>
          {featureCards.map((f, i) => (
            <Col xs={24} sm={12} md={8} key={i}>
              <Card size="small" className="feature-card" style={{ height: '100%' }}>
                <div style={{ color: '#6366f1', fontSize: 22, marginBottom: 8 }}>{f.icon}</div>
                <div style={{ fontWeight: 700, marginBottom: 4, color: '#0f172a' }}>{f.title}</div>
                <div style={{ fontSize: 12, lineHeight: 1.6, color: '#64748b' }}>{f.desc}</div>
              </Card>
            </Col>
          ))}
        </Row>

        <Alert
          type="success"
          showIcon
          message="零侵入向后兼容"
          description="不配置任何 server 时行为与未安装完全一致（空 extensions 场景零影响）。单个 server 连接失败只产诊断、不中断整体，其余 server 正常工作。"
          style={{ marginBottom: 32 }}
        />
      </div>

      {/* 1. 快速开始 */}
      <div id="quickstart" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <RocketOutlined /> 1. 快速开始
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          <code>createMcpPlugin()</code> 声明外部 server 列表，把 <code>plugin.extensions</code> 注入
          Runtime 即完成接线。MCP 连接是异步的，插件通过 <code>beforeRun</code> 钩子在首轮请求前
          <b>懒连接</b>并注册工具（幂等、并发合并），无需任何模板代码；也可用{' '}
          <code>plugin.ready()</code> 预热。
        </Paragraph>
        <CodeBlock code={mcpQuickstartCode} language="typescript" />

        <Divider orientation="left" plain>
          McpPlugin 返回对象
        </Divider>
        <table className="params-table">
          <thead>
            <tr>
              <th style={{ width: '28%' }}>成员</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            {pluginRows.map((r) => (
              <tr key={r.name}>
                <td>
                  <span className="param-name">{r.name}</span>
                </td>
                <td>{r.desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 2. .mcp.json 配置 */}
      <div id="config" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <SettingOutlined /> 2. .mcp.json 配置（生态兼容）
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          采用社区事实标准 <code>.mcp.json</code>（Claude Code / Cursor 通用）。项目级{' '}
          <code>&lt;cwd&gt;/.mcp.json</code> 优先于用户级 <code>~/.aipack/mcp.json</code>，
          同名 server 项目级覆盖用户级。stdio 条目有 <code>command</code> 即识别；http/sse
          条目需 <code>type</code> + <code>url</code>。CLI 下放置该文件即自动生效。
        </Paragraph>
        <CodeBlock code={mcpJsonConfigCode} language="jsonc" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 3. Server 配置项 */}
      <div id="server-config" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <ApiOutlined /> 3. McpServerConfig 配置项
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          程序化接入时逐字段可配；<code>McpPluginOptions</code> 另含 <code>servers</code>、
          <code>clientInfo</code>（默认 <code>{'{ name: "aipack-mcp", version: "0.1.0" }'}</code>）、
          <code>requestTimeoutMs</code>（默认 30s）。
        </Paragraph>
        <CodeBlock code={mcpServerConfigCode} language="typescript" />
        <Divider orientation="left" plain>
          字段说明
        </Divider>
        <table className="params-table">
          <thead>
            <tr>
              <th style={{ width: '18%' }}>字段</th>
              <th style={{ width: '30%' }}>类型</th>
              <th style={{ width: '18%' }}>默认</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            {serverConfigRows.map((r) => (
              <tr key={r.name}>
                <td>
                  <span className="param-name">{r.name}</span>
                </td>
                <td>
                  <span className="param-type">{r.type}</span>
                </td>
                <td style={{ color: '#64748b' }}>{r.def}</td>
                <td>{r.desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 4. 传输层 */}
      <div id="transports" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <ShareAltOutlined /> 4. 传输层
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          <b>stdio</b> 通过 <code>child_process</code> 拉起本地子进程、行分隔 JSON-RPC 通信；
          <b> Streamable HTTP</b> 覆盖远程 server（会话头、协议版本头、SSE 响应、202 Accepted）；
          <b> legacy SSE</b> 兼容旧 server。远程 server 支持静态 header / bearer token。
        </Paragraph>
        <CodeBlock code={mcpTransportsCode} language="typescript" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 5. 连接生命周期 */}
      <div id="lifecycle" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <SyncOutlined /> 5. 连接生命周期
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          <code>Extension.setup</code> 是同步的、MCP 连接是异步的——插件把连接放在{' '}
          <code>beforeRun</code>（runtime run loop 之前触发，本轮注册的工具对模型可见）。
          <code>setup</code> 阶段先同步注册内部工具 <code>mcp_status</code>，供随时查看状态。
        </Paragraph>
        <CodeBlock code={mcpLifecycleCode} language="text" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 6. 协议与容错 */}
      <div id="protocol" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <CodeOutlined /> 6. 工具适配与协议容错
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          协议子集：<code>initialize</code> / <code>tools/list</code> / <code>tools/call</code> /{' '}
          <code>ping</code> / <code>cancelled</code> / <code>list_changed</code> /{' '}
          <code>resources/*</code> / <code>prompts/*</code> / <code>sampling</code>。
        </Paragraph>
        <CodeBlock code={mcpAdapterCode} language="typescript" />
        <Divider orientation="left" plain>
          容错约定
        </Divider>
        <CodeBlock code={mcpProtocolCode} language="typescript" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 7. Sampling 双向 */}
      <div id="sampling" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <BulbOutlined /> 7. Sampling 双向（server ↔ client LLM）
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          Sampling 允许外部 server 借助客户端（宿主）的大模型完成补全。客户端方向通过{' '}
          <code>onSampling</code> 应答 <code>sampling/createMessage</code>，设置后在{' '}
          <code>initialize</code> 中宣告 <code>sampling</code> 能力；服务端方向{' '}
          <code>createMcpServerHost({'{ sampling: true }'})</code> 后，工具可经{' '}
          <code>host.sampleLLM()</code> 反向请求 client。
        </Paragraph>
        <CodeBlock code={mcpSamplingCode} language="typescript" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 8. 服务端方向 */}
      <div id="server" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <CloudServerOutlined /> 8. 服务端方向：把 aipack 工具暴露为 MCP Server
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          <code>createMcpServerHost()</code> 把原生 <code>Tool[]</code>（+ 可选{' '}
          <code>resources</code> / <code>prompts</code>）反向暴露为标准 MCP Server。
          <code>handleRequest</code> 为传输层无关入口；<code>runStdioServer</code> 驱动
          stdin/stdout 循环。工具调用经可选 <code>authorize</code> 钩子裁决，
          <code>ToolResult.details.error</code> 存在 → MCP <code>isError</code>。
        </Paragraph>
        <CodeBlock code={mcpServerHostCode} language="typescript" />

        <Divider orientation="left" plain>
          stdio 进程入口（Claude Desktop 直接拉起）
        </Divider>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          工具来源优先取环境变量 <code>AIPACK_MCP_TOOLS</code> 指向的 ESM 模块；未设置时回退内置演示工具
          （<code>echo</code> / <code>add</code> / <code>ask_llm</code>），开箱即用。
        </Paragraph>
        <CodeBlock code={mcpStdioEntryCode} language="jsonc" />
        <Alert
          type="info"
          showIcon
          icon={<LinkOutlined />}
          message="与 multi-agent MCPBridge 的关系"
          description={
            <span>
              <code>@aipack-ai/mcp</code> 提供面向任意 <code>Tool[]</code> 的通用服务端实现；
              <code>multi-agent</code> 的 <code>MCPBridge</code> 已统一——新增 <code>asTools()</code> /{' '}
              <code>toMcpServerHost()</code> 与 <code>createMultiAgentMcpServerHost(graph)</code> 工厂，
              可把 <code>AgentGraph</code> 经 <code>McpServerHost</code> + <code>runStdioServer</code>{' '}
              拉起为 stdio MCP Server（补齐原缺失的传输层），legacy API 保持不变。
            </span>
          }
          style={{ marginTop: 24 }}
        />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 9. 安全与权限 */}
      <div id="security" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <SafetyCertificateOutlined /> 9. 安全与权限
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          <CheckCircleOutlined style={{ color: '#10b981', marginRight: 8 }} />
          包装工具默认 <code>permissions: ['mcp:&lt;server&gt;']</code>（外部进程 / 网络调用，不可默认放行）。
          <code>createPermissionPolicy</code> 为 <b>deny-by-default</b>：库用户需自行追加一条{' '}
          <code>permission: 'mcp'</code> 规则（前缀匹配）才能放行，否则 MCP 工具被拒（fail-closed）。
          CLI 已内置该规则 → confirm 档。
        </Paragraph>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          <WarningOutlined style={{ color: '#f59e0b', marginRight: 8 }} />
          环境变量最小化泄漏面：<code>env</code> 支持 <code>${'{VAR}'}</code> 展开，变量未定义即跳过该
          server（不静默传空串）；不透传宿主全量环境变量。stdio 子进程除 JSON-RPC 通道外默认{' '}
          <code>ignore</code>，防止污染宿主 stdout。
        </Paragraph>
        <CodeBlock code={mcpSecurityCode} language="typescript" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 10. CLI 集成 */}
      <div id="cli" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <ThunderboltOutlined /> 10. CLI 集成
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          在 <code>aipack</code> 交互模式下，项目根放置 <code>.mcp.json</code> 即自动加载并完成权限接线
          （MCP 工具默认 confirm 审批）。
        </Paragraph>
        <CodeBlock code={mcpCliCode} language="bash" />
        <Divider orientation="left" plain>
          状态与诊断
        </Divider>
        <CodeBlock code={mcpDiagnosticsCode} language="typescript" />
      </div>
    </div>
  );
}
