import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { Alert, Card, Row, Col, Tag, List, Divider, Typography } from 'antd';
import {
  ApartmentOutlined,
  RocketOutlined,
  ThunderboltOutlined,
  CodeOutlined,
  NodeIndexOutlined,
  ShareAltOutlined,
  DeploymentUnitOutlined,
  ForkOutlined,
  ApiOutlined,
  DatabaseOutlined,
  AimOutlined,
  CheckCircleOutlined,
  BugOutlined,
} from '@ant-design/icons';
import CodeBlock from '../components/CodeBlock';
import {
  maInstallCode,
  maQuickstartCode,
  maNodeDefCode,
  maEdgeDefCode,
  maSharedContextCode,
  maPipelineCode,
  maRouterCode,
  maSupervisorCode,
  maDebateCode,
  maMapReduceCode,
  maCustomGraphCode,
  maStreamCode,
  maMcpBridgeCode,
  maDebuggerCode,
  maSharedDataCode,
} from '../data/multiAgentCode';

const { Paragraph } = Typography;

const featureCards = [
  {
    icon: <ApartmentOutlined />,
    title: '声明式 AgentGraph',
    desc: 'addNode / addEdge / setEntry / setFinish 链式定义图，条件边实现分支与循环',
  },
  {
    icon: <ShareAltOutlined />,
    title: 'Runtime 即 Agent',
    desc: '不发明新 Agent 抽象，直接复用 @aipack-ai/agent 的 Runtime 实例',
  },
  {
    icon: <DatabaseOutlined />,
    title: 'SharedContext 黑板',
    desc: 'Blackboard 键值存储 + EventBus 事件总线 + ToolRegistry 工具共享',
  },
  {
    icon: <ForkOutlined />,
    title: '5 种编排模板',
    desc: 'Pipeline / Router / Supervisor / Debate / MapReduce，覆盖主流编排场景',
  },
  {
    icon: <ThunderboltOutlined />,
    title: '原生流式事件',
    desc: 'AsyncGenerator 产出 10 类 MultiAgentEvent，实时进度与并行批次可观测',
  },
  {
    icon: <DeploymentUnitOutlined />,
    title: 'MCP 互操作',
    desc: 'MCPBridge 把编排图暴露为 MCP 工具，外部客户端可直接调用',
  },
];

const patternRows = [
  {
    icon: '➡️',
    name: 'Pipeline',
    tag: '线性链',
    structure: 'A → B → C',
    scenario: '翻译→润色→校对 · 需求→编码→测试',
    color: 'blue',
  },
  {
    icon: '🔀',
    name: 'Router',
    tag: '条件分发',
    structure: 'Router → (匹配) → Target',
    scenario: '客服意图路由 · 代码语言路由',
    color: 'green',
  },
  {
    icon: '⭐',
    name: 'Supervisor',
    tag: '层级委派',
    structure: 'Supervisor → Workers',
    scenario: 'PM 分配给前端/后端/QA',
    color: 'orange',
  },
  {
    icon: '🔄',
    name: 'Debate',
    tag: '对抗评审',
    structure: 'Proposer ↔ Reviewer',
    scenario: '代码生成→Review→修复循环',
    color: 'red',
  },
  {
    icon: '📐',
    name: 'MapReduce',
    tag: '并行聚合',
    structure: 'split → Mappers → Reducer',
    scenario: '多文件并行分析→汇总报告',
    color: 'purple',
  },
];

export default function MultiAgentPage() {
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
        <ApartmentOutlined style={{ color: '#6366f1' }} /> 多 Agent 编排
      </h1>
      <p className="section-subtitle">
        <b>@aipack-ai/multi-agent</b> 提供声明式 AgentGraph 与 5 种预设编排模板（Pipeline / Router /
        Supervisor / Debate / MapReduce）。每个 Runtime 实例就是一个 Agent，多个 Runtime 通过图与
        SharedContext 协作，复用 @aipack-ai/agent 的会话、权限、压缩等能力，零新外部依赖。
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
          message="设计哲学：Runtime 即 Agent"
          description="不发明新的 Agent 抽象，直接把现有 Runtime 实例作为图中的 Agent 节点。会话持久化、权限策略、上下文压缩、流式输出等能力全部复用，区别于全部 Python 方案。"
          style={{ marginBottom: 32 }}
        />
      </div>

      {/* 架构总览 */}
      <div id="architecture" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <ApartmentOutlined /> 架构总览
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          三层架构：编排模板（预设工厂） → 核心层（AgentGraph / GraphExecutor / SharedContext） →
          基础设施（N 个 Runtime 实例）。图定义只描述流转逻辑，真正的模型调用、工具执行、会话管理
          都委托给各节点的 Runtime。
        </Paragraph>
        <div className="arch-container" style={{ marginTop: 16 }}>
          <div className="arch-layers">
            <div className="arch-layer">
              <div className="arch-label">编排模板</div>
              <div className="arch-boxes">
                <div className="arch-box arch-box-extension">
                  <ForkOutlined style={{ fontSize: 20 }} />
                  <div style={{ fontWeight: 700, marginTop: 4 }}>5 种预设</div>
                  <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4 }}>
                    Pipeline / Router / Supervisor / Debate / MapReduce
                  </div>
                </div>
                <div className="arch-box arch-box-extension">
                  <CodeOutlined style={{ fontSize: 20 }} />
                  <div style={{ fontWeight: 700, marginTop: 4 }}>createAgentGraph</div>
                  <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4 }}>
                    自由定义图（节点 + 边 + 条件 + 循环）
                  </div>
                </div>
              </div>
            </div>
            <div className="arch-arrow">▼</div>
            <div className="arch-layer">
              <div className="arch-label">核心层</div>
              <div className="arch-boxes">
                <div className="arch-box arch-box-core">
                  <NodeIndexOutlined style={{ fontSize: 20 }} />
                  <div style={{ fontWeight: 700, marginTop: 4 }}>AgentGraph</div>
                  <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4 }}>
                    声明式图定义 + run() / stream()
                  </div>
                </div>
                <div className="arch-box arch-box-core">
                  <ThunderboltOutlined style={{ fontSize: 20 }} />
                  <div style={{ fontWeight: 700, marginTop: 4 }}>GraphExecutor</div>
                  <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4 }}>
                    入口遍历 + 条件边 + 防死循环
                  </div>
                </div>
                <div className="arch-box arch-box-core">
                  <ShareAltOutlined style={{ fontSize: 20 }} />
                  <div style={{ fontWeight: 700, marginTop: 4 }}>SharedContext</div>
                  <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4 }}>
                    Blackboard + EventBus + ToolRegistry
                  </div>
                </div>
              </div>
            </div>
            <div className="arch-arrow">▼</div>
            <div className="arch-layer">
              <div className="arch-label">基础设施</div>
              <div className="arch-boxes">
                <div className="arch-box arch-box-storage">
                  <DeploymentUnitOutlined style={{ fontSize: 20 }} />
                  <div style={{ fontWeight: 700, marginTop: 4 }}>Runtime × N</div>
                  <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4 }}>
                    每个 Agent 节点 = 一个 Runtime 实例
                  </div>
                </div>
                <div className="arch-box arch-box-storage">
                  <DatabaseOutlined style={{ fontSize: 20 }} />
                  <div style={{ fontWeight: 700, marginTop: 4 }}>Session / 权限</div>
                  <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4 }}>
                    复用 @aipack-ai/agent 能力
                  </div>
                </div>
                <div className="arch-box arch-box-storage">
                  <BugOutlined style={{ fontSize: 20 }} />
                  <div style={{ fontWeight: 700, marginTop: 4 }}>扩展层</div>
                  <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4 }}>
                    MCPBridge + GraphDebugger
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 1. 快速开始 */}
      <div id="quickstart" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <RocketOutlined /> 1. 快速开始
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          安装后导入编排工厂，定义各阶段 Agent（每个 Agent 就是一个带 <code>runtime</code> 的对象），
          用 <code>createPipeline</code> 串联即可。前一个 Agent 的输出自动作为后一个的输入。
        </Paragraph>
        <CodeBlock code={maInstallCode} language="bash" />
        <CodeBlock code={maQuickstartCode} language="typescript" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 2. 核心概念 */}
      <div id="concepts" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <CodeOutlined /> 2. 核心概念
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          整个框架围绕三个核心抽象构建：<b>AgentNode</b>（图中的 Agent 节点）、
          <b>AgentEdge</b>（Agent 间流转边）、<b>SharedContext</b>（共享上下文）。
          所有预设模板最终都生成一个 <b>AgentGraph</b> 实例。
        </Paragraph>

        {/* AgentNode */}
        <h3 style={{ marginTop: 24, color: '#1e293b' }}>AgentNode —— 图中的 Agent 节点</h3>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          一个节点 = 一个 Agent 身份。通过 <code>inputMapping</code> 从共享上下文取输入，
          通过 <code>outputMapping</code> 把结果写回共享上下文，实现 Agent 间解耦的数据流。
        </Paragraph>
        <CodeBlock code={maNodeDefCode} language="typescript" />
        <Divider orientation="left">AgentNode 字段</Divider>
        <table className="params-table">
          <thead>
            <tr>
              <th style={{ width: '22%' }}>字段</th>
              <th style={{ width: '24%' }}>类型</th>
              <th style={{ width: '12%' }}>必填</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><span className="param-name">id</span><span className="param-required">必填</span></td>
              <td><span className="param-type">string</span></td>
              <td>是</td>
              <td>节点唯一标识，边和路由通过 id 引用</td>
            </tr>
            <tr>
              <td><span className="param-name">name</span><span className="param-required">必填</span></td>
              <td><span className="param-type">string</span></td>
              <td>是</td>
              <td>节点显示名（出现在流式事件中）</td>
            </tr>
            <tr>
              <td><span className="param-name">description</span></td>
              <td><span className="param-type">string</span></td>
              <td>—</td>
              <td>Agent 描述，注入到 systemPrompt</td>
            </tr>
            <tr>
              <td><span className="param-name">runtime</span><span className="param-required">必填</span></td>
              <td><span className="param-type">Runtime | RuntimeOptions</span></td>
              <td>是</td>
              <td>Runtime 实例（已配置好模型/会话），或创建选项（自动 createRuntime）</td>
            </tr>
            <tr>
              <td><span className="param-name">tools</span></td>
              <td><span className="param-type">Tool[]?</span></td>
              <td>—</td>
              <td>该 Agent 专有工具（除共享 ToolRegistry 外）</td>
            </tr>
            <tr>
              <td><span className="param-name">inputMapping</span></td>
              <td><span className="param-type">(ctx) =&gt; string | Request</span></td>
              <td>—</td>
              <td>输入转换：从 SharedContext 提取该 Agent 需要的输入</td>
            </tr>
            <tr>
              <td><span className="param-name">outputMapping</span></td>
              <td><span className="param-type">(result, ctx) =&gt; void</span></td>
              <td>—</td>
              <td>输出转换：把 Agent 结果写入 SharedContext</td>
            </tr>
          </tbody>
        </table>

        {/* AgentEdge */}
        <h3 style={{ marginTop: 32, color: '#1e293b' }}>AgentEdge —— Agent 间流转边</h3>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          边定义了 Agent 之间的流转关系。<code>condition</code> 实现条件分支（多边择一），
          <code>transform</code> 在边上传入下一个 Agent 前改写输入。无 <code>condition</code> 的边默认始终匹配。
        </Paragraph>
        <CodeBlock code={maEdgeDefCode} language="typescript" />
        <Divider orientation="left">AgentEdge 字段</Divider>
        <table className="params-table">
          <thead>
            <tr>
              <th style={{ width: '22%' }}>字段</th>
              <th style={{ width: '26%' }}>类型</th>
              <th style={{ width: '12%' }}>必填</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><span className="param-name">from</span><span className="param-required">必填</span></td>
              <td><span className="param-type">string</span></td>
              <td>是</td>
              <td>源 Agent ID</td>
            </tr>
            <tr>
              <td><span className="param-name">to</span><span className="param-required">必填</span></td>
              <td><span className="param-type">string</span></td>
              <td>是</td>
              <td>目标 Agent ID</td>
            </tr>
            <tr>
              <td><span className="param-name">condition</span></td>
              <td><span className="param-type">(result, ctx) =&gt; boolean</span></td>
              <td>—</td>
              <td>条件：满足才走这条边（默认 always true，实现分支/循环）</td>
            </tr>
            <tr>
              <td><span className="param-name">transform</span></td>
              <td><span className="param-type">(result, ctx) =&gt; string | Request</span></td>
              <td>—</td>
              <td>边上的转换：改写传递给下一个 Agent 的输入</td>
            </tr>
          </tbody>
        </table>

        {/* SharedContext */}
        <h3 style={{ marginTop: 32, color: '#1e293b' }}>SharedContext —— 共享上下文</h3>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          Agent 间数据流通的三件套：<b>Blackboard</b>（键值存储，最常用）、
          <b>EventBus</b>（发布订阅）、<b>ToolRegistry</b>（工具共享）。通常由图执行时自动创建，
          也可手动初始化后注入。
        </Paragraph>
        <CodeBlock code={maSharedContextCode} language="typescript" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 3. 编排模板 */}
      <div id="patterns" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <ForkOutlined /> 3. 编排模板
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          5 种预设工厂函数，覆盖主流编排场景。每个都返回一个 <code>AgentGraph</code> 实例，
          支持 <code>run()</code> / <code>stream()</code> / <code>getState()</code>。
        </Paragraph>

        {/* 模式一览 */}
        <Row gutter={[16, 16]} style={{ marginBottom: 8 }}>
          {patternRows.map((p) => (
            <Col xs={24} sm={12} md={8} key={p.name}>
              <Card size="small" style={{ height: '100%' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 18 }}>{p.icon}</span>
                  <span style={{ fontWeight: 700, color: '#0f172a' }}>{p.name}</span>
                  <Tag color={p.color} style={{ marginLeft: 'auto' }}>{p.tag}</Tag>
                </div>
                <div style={{ fontSize: 12, color: '#6366f1', fontFamily: 'monospace', marginBottom: 6 }}>
                  {p.structure}
                </div>
                <div style={{ fontSize: 12, color: '#64748b', lineHeight: 1.6 }}>{p.scenario}</div>
              </Card>
            </Col>
          ))}
        </Row>

        {/* Pipeline */}
        <div id="pattern-pipeline" style={{ scrollMarginTop: 100, marginTop: 32 }}>
          <h3 style={{ color: '#1e293b' }}>3.1 Pipeline — 顺序链</h3>
          <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
            将多个 Agent 按顺序串联：<code>A → B → C</code>。前一个 Agent 的输出自动作为后一个的输入。
            适合执行顺序固定的流水线（翻译→润色→校对、需求→编码→测试）。
          </Paragraph>
          <CodeBlock code={maPipelineCode} language="typescript" />
          <Divider orientation="left">PipelineOpts</Divider>
          <table className="params-table">
            <thead>
              <tr>
                <th style={{ width: '24%' }}>字段</th>
                <th style={{ width: '24%' }}>类型</th>
                <th style={{ width: '14%' }}>默认</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><span className="param-name">passFullResult</span></td>
                <td><span className="param-type">boolean?</span></td>
                <td><code>false</code></td>
                <td>是否传递前一个 Agent 的完整 Result（默认只传 content 文本）</td>
              </tr>
              <tr>
                <td><span className="param-name">outputTransform</span></td>
                <td><span className="param-type">(result, ctx) =&gt; string</span></td>
                <td>—</td>
                <td>节点间输出转换（全局，优先级低于 AgentNode.outputMapping）</td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Router */}
        <div id="pattern-router" style={{ scrollMarginTop: 100, marginTop: 32 }}>
          <h3 style={{ color: '#1e293b' }}>3.2 Router — 条件路由</h3>
          <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
            路由器 Agent 根据输入选择目标 Agent 执行。通过 <code>resolve</code> 函数从路由器输出解析目标
            Agent ID，匹配到哪个目标就走哪条边。适合意图分发、分类处理（客服系统、文档类型路由）。
          </Paragraph>
          <CodeBlock code={maRouterCode} language="typescript" />
          <Divider orientation="left">RouterOpts</Divider>
          <table className="params-table">
            <thead>
              <tr>
                <th style={{ width: '24%' }}>字段</th>
                <th style={{ width: '30%' }}>类型</th>
                <th style={{ width: '12%' }}>必填</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><span className="param-name">resolve</span><span className="param-required">必填</span></td>
                <td><span className="param-type">(routerResult) =&gt; string</span></td>
                <td>是</td>
                <td>从路由 Agent 输出中解析目标 Agent ID</td>
              </tr>
              <tr>
                <td><span className="param-name">defaultTarget</span></td>
                <td><span className="param-type">string?</span></td>
                <td>—</td>
                <td>未匹配时的默认路由 Agent ID</td>
              </tr>
              <tr>
                <td><span className="param-name">passOriginalInput</span></td>
                <td><span className="param-type">boolean?</span></td>
                <td><code>true</code></td>
                <td>是否传原始用户输入给目标（false 则传路由器输出）</td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Supervisor */}
        <div id="pattern-supervisor" style={{ scrollMarginTop: 100, marginTop: 32 }}>
          <h3 style={{ color: '#1e293b' }}>3.3 Supervisor — 层级委派</h3>
          <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
            Supervisor Agent 先拆解任务并写入 SharedContext，Worker Agents 按调度策略执行，
            最后汇总。支持 <code>parallel</code> / <code>sequential</code> / <code>auto</code> 三种调度。
            适合上下级分工（PM 分配给前端/后端/QA、CTO 拆解架构）。
          </Paragraph>
          <CodeBlock code={maSupervisorCode} language="typescript" />
          <Divider orientation="left">SupervisorOpts</Divider>
          <table className="params-table">
            <thead>
              <tr>
                <th style={{ width: '22%' }}>字段</th>
                <th style={{ width: '22%' }}>类型</th>
                <th style={{ width: '14%' }}>默认</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><span className="param-name">schedule</span></td>
                <td><span className="param-type">'parallel' | 'sequential' | 'auto'</span></td>
                <td><code>parallel</code></td>
                <td>
                  parallel：全部并行；sequential：按顺序依次；auto：无 inputMapping 的先并行，
                  有 inputMapping（依赖其他 worker 结果）的后顺序执行
                </td>
              </tr>
              <tr>
                <td><span className="param-name">concurrency</span></td>
                <td><span className="param-type">number?</span></td>
                <td><code>Infinity</code></td>
                <td>并行执行时的最大并发数，避免 API 限流</td>
              </tr>
              <tr>
                <td><span className="param-name">passOriginalInput</span></td>
                <td><span className="param-type">boolean?</span></td>
                <td><code>true</code></td>
                <td>是否将原始用户输入写入 blackboard.__original_input__</td>
              </tr>
            </tbody>
          </table>
          <Alert
            type="info"
            showIcon
            style={{ marginTop: 16 }}
            message="Worker 任务分配约定"
            description={(
              <span style={{ lineHeight: 1.8 }}>
                Worker 无 <code>inputMapping</code> 时，自动从 <code>blackboard.tasks</code> 中按
                <code> assignee === worker.id</code> 取任务；找不到则回退到
                <code> __original_input__</code>。每个 worker 执行后，结果自动写入
                <code>{'blackboard[`${worker.id}_result`]'}</code>，方便下游 worker 读取。
              </span>
            )}
          />
        </div>

        {/* Debate */}
        <div id="pattern-debate" style={{ scrollMarginTop: 100, marginTop: 32 }}>
          <h3 style={{ color: '#1e293b' }}>3.4 Debate — 对抗评审</h3>
          <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
            Proposer 与 Reviewer 循环辩论：Proposer 生成 → Reviewer 审查 → 若未收敛则把反馈转为
            Proposer 下一轮输入，直到满足收敛条件或达最大轮次。适合生成↔Review 循环、安全审计↔修复。
          </Paragraph>
          <CodeBlock code={maDebateCode} language="typescript" />
          <Divider orientation="left">DebateOpts</Divider>
          <table className="params-table">
            <thead>
              <tr>
                <th style={{ width: '24%' }}>字段</th>
                <th style={{ width: '30%' }}>类型</th>
                <th style={{ width: '12%' }}>默认</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><span className="param-name">maxRounds</span></td>
                <td><span className="param-type">number?</span></td>
                <td><code>3</code></td>
                <td>最大辩论轮数</td>
              </tr>
              <tr>
                <td><span className="param-name">convergeWhen</span><span className="param-required">必填</span></td>
                <td><span className="param-type">(reviewerResult) =&gt; boolean</span></td>
                <td>—</td>
                <td>收敛条件：reviewer 输出满足时提前结束</td>
              </tr>
              <tr>
                <td><span className="param-name">feedbackTransform</span></td>
                <td><span className="param-type">(reviewerResult, proposerResult) =&gt; string</span></td>
                <td>拼接反馈</td>
                <td>把 reviewer 反馈转为下一轮 proposer 输入（默认拼为修复指令）</td>
              </tr>
            </tbody>
          </table>
          <Alert
            type="info"
            showIcon
            style={{ marginTop: 16 }}
            message="执行细节"
            description={(
              <span style={{ lineHeight: 1.8 }}>
                Reviewer 的输入是 Proposer 当前轮的 <code>content</code>；最终结果取最后一次 Proposer 输出。
                <code>stopReason</code> 为 <code>converged_at_round_N</code>（收敛）或
                <code> max_rounds_reached</code>（达上限）。各轮结果按
                <code> agentId_rN</code> 存入 agentResults。
              </span>
            )}
          />
        </div>

        {/* MapReduce */}
        <div id="pattern-mapreduce" style={{ scrollMarginTop: 100, marginTop: 32 }}>
          <h3 style={{ color: '#1e293b' }}>3.5 MapReduce — 并行聚合</h3>
          <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
            将输入拆分为多个子任务，用同一个 Mapper Agent 并行处理，再用 Reducer Agent 汇总。
            适合批量分析（多文件分析→汇总报告、多源搜索→综合报告）。
          </Paragraph>
          <CodeBlock code={maMapReduceCode} language="typescript" />
          <Divider orientation="left">MapReduceOpts</Divider>
          <table className="params-table">
            <thead>
              <tr>
                <th style={{ width: '22%' }}>字段</th>
                <th style={{ width: '30%' }}>类型</th>
                <th style={{ width: '14%' }}>默认</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><span className="param-name">split</span><span className="param-required">必填</span></td>
                <td><span className="param-type">(input) =&gt; string[]</span></td>
                <td>—</td>
                <td>将输入拆分为多个子任务（返回空数组会报错）</td>
              </tr>
              <tr>
                <td><span className="param-name">concurrency</span></td>
                <td><span className="param-type">number?</span></td>
                <td><code>Infinity</code></td>
                <td>并行执行上限，避免 API 限流</td>
              </tr>
              <tr>
                <td><span className="param-name">reduceInputFormat</span></td>
                <td><span className="param-type">(mapperResults) =&gt; string</span></td>
                <td>按子任务拼接</td>
                <td>Reducer 的输入格式化（默认按 "--- 子任务 N ---" 拼接）</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 4. 自定义 AgentGraph */}
      <div id="custom-graph" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <NodeIndexOutlined /> 4. 自定义 AgentGraph
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          预设模板不满足时，用 <code>createAgentGraph()</code> 自由定义图。通过条件边实现分支与循环
          （如 Review→Coder 打回重做），通过 <code>setFinish</code> 自定义终止条件。执行器内置
          防死循环保护（单节点最多访问 10 次）。
        </Paragraph>
        <CodeBlock code={maCustomGraphCode} language="typescript" />
        <Divider orientation="left">AgentGraph 接口</Divider>
        <table className="params-table">
          <thead>
            <tr>
              <th style={{ width: '22%' }}>方法</th>
              <th style={{ width: '34%' }}>签名</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><span className="param-name">addNode</span></td>
              <td><span className="param-type">(node) =&gt; this</span></td>
              <td>添加 Agent 节点</td>
            </tr>
            <tr>
              <td><span className="param-name">addEdge</span></td>
              <td><span className="param-type">(edge) =&gt; this</span></td>
              <td>添加流转边（可带 condition / transform）</td>
            </tr>
            <tr>
              <td><span className="param-name">setEntry</span></td>
              <td><span className="param-type">(agentId) =&gt; this</span></td>
              <td>设置入口 Agent</td>
            </tr>
            <tr>
              <td><span className="param-name">setFinish</span></td>
              <td><span className="param-type">(condition) =&gt; this</span></td>
              <td>设置终止条件（基于 SharedContext 判定）</td>
            </tr>
            <tr>
              <td><span className="param-name">run</span></td>
              <td><span className="param-type">(input) =&gt; Promise&lt;MultiAgentResult&gt;</span></td>
              <td>同步执行图，返回最终结果</td>
            </tr>
            <tr>
              <td><span className="param-name">stream</span></td>
              <td><span className="param-type">(input) =&gt; AsyncGenerator&lt;MultiAgentEvent&gt;</span></td>
              <td>流式执行，产出事件</td>
            </tr>
            <tr>
              <td><span className="param-name">getState</span></td>
              <td><span className="param-type">() =&gt; GraphExecutionState</span></td>
              <td>获取执行状态快照</td>
            </tr>
            <tr>
              <td><span className="param-name">abort</span></td>
              <td><span className="param-type">() =&gt; void</span></td>
              <td>中止执行</td>
            </tr>
            <tr>
              <td><span className="param-name">on</span></td>
              <td><span className="param-type">(event, listener) =&gt; this</span></td>
              <td>事件监听</td>
            </tr>
          </tbody>
        </table>
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 5. 数据流 */}
      <div id="data-flow" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <ShareAltOutlined /> 5. Agent 间数据流
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          Agent 间数据流通有三种方式，最常用的是 <b>Blackboard</b>（黑板模式）：上游 Agent 通过
          <code> outputMapping</code> 写入，下游通过 <code>inputMapping</code> 读取，无需消息序列化。
        </Paragraph>
        <CodeBlock code={maSharedDataCode} language="typescript" />
        <Divider orientation="left">三种数据流方式对比</Divider>
        <Row gutter={[16, 16]}>
          <Col xs={24} md={8}>
            <Card size="small" title="Blackboard 黑板" style={{ height: '100%' }}>
              <List size="small" dataSource={[
                '最常用，outputMapping/inputMapping 配对',
                '键值存储，无需序列化',
                '适合结构化数据传递',
              ]} renderItem={(item) => (
                <List.Item style={{ padding: '4px 0', border: 'none' }}>
                  <CheckCircleOutlined style={{ color: '#10b981', marginRight: 8 }} />
                  <span style={{ fontSize: 13, color: '#475569' }}>{item}</span>
                </List.Item>
              )} />
            </Card>
          </Col>
          <Col xs={24} md={8}>
            <Card size="small" title="EventBus 事件总线" style={{ height: '100%' }}>
              <List size="small" dataSource={[
                '发布/订阅异步通知',
                '适合旁路监听（日志/统计）',
                '同步执行，监听器异常不中断',
              ]} renderItem={(item) => (
                <List.Item style={{ padding: '4px 0', border: 'none' }}>
                  <CheckCircleOutlined style={{ color: '#6366f1', marginRight: 8 }} />
                  <span style={{ fontSize: 13, color: '#475569' }}>{item}</span>
                </List.Item>
              )} />
            </Card>
          </Col>
          <Col xs={24} md={8}>
            <Card size="small" title="ToolRegistry 工具共享" style={{ height: '100%' }}>
              <List size="small" dataSource={[
                '跨 Agent 共享同一组工具',
                'register / get / getAll',
                'Agent 也可配 tools 字段为专有',
              ]} renderItem={(item) => (
                <List.Item style={{ padding: '4px 0', border: 'none' }}>
                  <CheckCircleOutlined style={{ color: '#fb923c', marginRight: 8 }} />
                  <span style={{ fontSize: 13, color: '#475569' }}>{item}</span>
                </List.Item>
              )} />
            </Card>
          </Col>
        </Row>
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 6. 流式事件 */}
      <div id="streaming" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <ThunderboltOutlined /> 6. 流式事件
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          所有编排模式都同时支持 <code>run()</code>（同步）与 <code>stream()</code>（AsyncGenerator 流式）。
          流式产出 10 类 <code>MultiAgentEvent</code>，可实时展示执行进度、并行批次、辩论轮次，适合接入 UI。
        </Paragraph>
        <CodeBlock code={maStreamCode} language="typescript" />
        <Divider orientation="left">MultiAgentEvent 类型一览</Divider>
        <table className="params-table">
          <thead>
            <tr>
              <th style={{ width: '22%' }}>type</th>
              <th style={{ width: '20%' }}>触发时机</th>
              <th>关键字段</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><span className="param-name">agent_start</span></td>
              <td>某 Agent 开始执行</td>
              <td>agentId / agentName</td>
            </tr>
            <tr>
              <td><span className="param-name">agent_result</span></td>
              <td>某 Agent 执行完成</td>
              <td>agentId / agentName / result</td>
            </tr>
            <tr>
              <td><span className="param-name">agent_error</span></td>
              <td>某 Agent 执行失败</td>
              <td>agentId / agentName / error</td>
            </tr>
            <tr>
              <td><span className="param-name">edge_traversed</span></td>
              <td>边流转</td>
              <td>from / to</td>
            </tr>
            <tr>
              <td><span className="param-name">parallel_start</span></td>
              <td>并行批次开始</td>
              <td>agentIds[]</td>
            </tr>
            <tr>
              <td><span className="param-name">parallel_done</span></td>
              <td>并行批次完成</td>
              <td>results: Map</td>
            </tr>
            <tr>
              <td><span className="param-name">round_start</span></td>
              <td>Debate 新一轮开始</td>
              <td>round</td>
            </tr>
            <tr>
              <td><span className="param-name">converged</span></td>
              <td>Debate 提前收敛</td>
              <td>round / reason</td>
            </tr>
            <tr>
              <td><span className="param-name">graph_done</span></td>
              <td>整个图执行完成</td>
              <td>result: MultiAgentResult</td>
            </tr>
            <tr>
              <td><span className="param-name">graph_error</span></td>
              <td>图执行错误</td>
              <td>error</td>
            </tr>
          </tbody>
        </table>
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 7. MCPBridge */}
      <div id="mcp-bridge" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <DeploymentUnitOutlined /> 7. MCPBridge 扩展
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          <code>MCPBridge</code> 把一个 <code>AgentGraph</code> 暴露为 MCP（Model Context Protocol）工具，
          使外部 MCP 客户端可直接调用多 Agent 编排图。设计原则：不依赖外部 MCP SDK，仅输出符合 MCP 规范的
          JSON 结构，由宿主环境（如 aipack CLI）负责实际传输层。
        </Paragraph>
        <CodeBlock code={maMcpBridgeCode} language="typescript" />
        <Divider orientation="left">暴露的 MCP 工具</Divider>
        <table className="params-table">
          <thead>
            <tr>
              <th style={{ width: '22%' }}>工具名</th>
              <th style={{ width: '24%' }}>参数</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><span className="param-name">{`${'{prefix}'}run`}</span></td>
              <td><span className="param-type">input: string</span></td>
              <td>运行编排图，返回 success / content / stepsCompleted / totalUsage 等</td>
            </tr>
            <tr>
              <td><span className="param-name">{`${'{prefix}'}status`}</span></td>
              <td>—</td>
              <td>获取当前图执行状态（currentAgentId / nodeStates / finished）</td>
            </tr>
          </tbody>
        </table>
        <Divider orientation="left">MCPBridgeOpts</Divider>
        <table className="params-table">
          <thead>
            <tr>
              <th style={{ width: '24%' }}>字段</th>
              <th style={{ width: '20%' }}>类型</th>
              <th style={{ width: '18%' }}>默认</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><span className="param-name">serverName</span></td>
              <td><span className="param-type">string?</span></td>
              <td><code>aipack-multi-agent</code></td>
              <td>MCP Server 名称</td>
            </tr>
            <tr>
              <td><span className="param-name">serverVersion</span></td>
              <td><span className="param-type">string?</span></td>
              <td><code>1.0.0</code></td>
              <td>MCP Server 版本</td>
            </tr>
            <tr>
              <td><span className="param-name">toolPrefix</span></td>
              <td><span className="param-type">string?</span></td>
              <td><code>''</code></td>
              <td>工具名前缀（多图共存时区分）</td>
            </tr>
          </tbody>
        </table>
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 8. GraphDebugger */}
      <div id="debugger" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <BugOutlined /> 8. GraphDebugger 扩展
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          <code>GraphDebugger</code> 提供可视化调试能力：导出 <b>DOT 格式</b>图结构（可用 Graphviz 渲染）、
          运行并记录 <b>GraphTrace</b>（逐步追踪每个 Agent 的耗时/输入/输出/状态）、导出 JSON 或可读日志。
        </Paragraph>
        <CodeBlock code={maDebuggerCode} language="typescript" />
        <Divider orientation="left">GraphDebugger 方法</Divider>
        <table className="params-table">
          <thead>
            <tr>
              <th style={{ width: '22%' }}>方法</th>
              <th style={{ width: '32%' }}>签名</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><span className="param-name">toDOT</span></td>
              <td><span className="param-type">() =&gt; string</span></td>
              <td>导出 DOT 格式（条件边虚线、入口节点高亮）</td>
            </tr>
            <tr>
              <td><span className="param-name">trace</span></td>
              <td><span className="param-type">(input) =&gt; Promise&lt;GraphTrace&gt;</span></td>
              <td>执行图并记录 Trace（基于 stream 事件）</td>
            </tr>
            <tr>
              <td><span className="param-name">traceToJSON</span></td>
              <td><span className="param-type">(trace) =&gt; string</span></td>
              <td>把 Trace 转为 JSON 字符串</td>
            </tr>
            <tr>
              <td><span className="param-name">traceToLog</span></td>
              <td><span className="param-type">(trace) =&gt; string</span></td>
              <td>把 Trace 转为可读执行日志</td>
            </tr>
            <tr>
              <td><span className="param-name">setGraphMeta</span></td>
              <td><span className="param-type">(nodes, edges, entryId?) =&gt; void</span></td>
              <td>设置图元数据（预设模板无法直接访问内部结构时用）</td>
            </tr>
          </tbody>
        </table>
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 9. 模板选择指南 */}
      <div id="template-guide" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <AimOutlined /> 9. 模板选择指南
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          根据任务特征选择合适的编排模板。复杂场景可组合多个模板（如 Router 分流后接入 Debate 或 Supervisor）。
        </Paragraph>

        <Divider orientation="left">决策树</Divider>
        <div className="code-block" style={{ background: '#0d1117' }}>
          <pre style={{ margin: 0, color: '#e6edf3', fontSize: 13, lineHeight: 1.7 }}>
{`你的任务需要几个 Agent？
│
├─ 2-3 个，且执行顺序固定
│   └─ ✅ Pipeline
│       例：翻译→润色→校对 | 需求→编码→测试
│
├─ 需要根据输入动态选择不同 Agent
│   └─ ✅ Router
│       例：客服意图分发 | 代码语言路由 | 文档分类
│
├─ 一个"管理者"需要拆解任务并分配给多个"执行者"
│   └─ ✅ Supervisor
│       例：PM 分配给前端/后端/QA | CTO 拆解架构
│
├─ 需要多个 Agent 反复对抗/交叉审核直到达标
│   └─ ✅ Debate
│       例：代码生成↔Review 循环 | 安全审计↔修复
│
└─ 多个独立子任务可并行，最后合并结果
    └─ ✅ MapReduce
        例：多文件并行分析→汇总 | 多源搜索→报告`}
          </pre>
        </div>

        <Divider orientation="left">关键判据对比</Divider>
        <table className="params-table">
          <thead>
            <tr>
              <th style={{ width: '18%' }}>判据</th>
              <th>Pipeline</th>
              <th>Router</th>
              <th>Supervisor</th>
              <th>Debate</th>
              <th>MapReduce</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><b>Agent 关系</b></td>
              <td>上下游</td>
              <td>平行互斥</td>
              <td>上下级</td>
              <td>对等对抗</td>
              <td>平行互补</td>
            </tr>
            <tr>
              <td><b>执行顺序</b></td>
              <td>固定线性</td>
              <td>动态单选</td>
              <td>动态多选</td>
              <td>循环往返</td>
              <td>并行后汇聚</td>
            </tr>
            <tr>
              <td><b>子任务依赖</b></td>
              <td>强依赖</td>
              <td>互斥</td>
              <td>可依赖</td>
              <td>互依赖</td>
              <td>完全独立</td>
            </tr>
            <tr>
              <td><b>终止条件</b></td>
              <td>最后 Agent 完成</td>
              <td>选中 Agent 完成</td>
              <td>Supervisor 判定</td>
              <td>收敛/达轮次</td>
              <td>Reducer 完成</td>
            </tr>
            <tr>
              <td><b>典型 Agent 数</b></td>
              <td>2-5</td>
              <td>1+N</td>
              <td>1+2~5</td>
              <td>2-3</td>
              <td>N+1</td>
            </tr>
          </tbody>
        </table>

        <Divider orientation="left">场景速查</Divider>
        <Row gutter={[16, 16]}>
          <Col xs={24} md={12}>
            <Card size="small" title="推荐模板" style={{ height: '100%' }}>
              <List size="small" dataSource={[
                ['代码生成 + Review', 'Debate'],
                ['客服系统', 'Router'],
                ['内容生产流水线', 'Pipeline'],
                ['项目开发', 'Supervisor'],
                ['批量文档分析', 'MapReduce'],
                ['数据 ETL', 'Pipeline'],
                ['专家会诊', 'Supervisor + Debate'],
                ['多语言翻译', 'MapReduce'],
              ]} renderItem={(item: string[]) => (
                <List.Item style={{ padding: '4px 0', border: 'none' }}>
                  <span style={{ fontSize: 13, color: '#475569' }}>{item[0]}</span>
                  <Tag color="blue" style={{ marginLeft: 'auto' }}>{item[1]}</Tag>
                </List.Item>
              )} />
            </Card>
          </Col>
          <Col xs={24} md={12}>
            <Card size="small" title="复合模式示例" style={{ height: '100%', border: '2px solid #6366f1' }}>
              <div className="code-block" style={{ background: '#0d1117', margin: 0 }}>
                <pre style={{ margin: 0, color: '#e6edf3', fontSize: 12, lineHeight: 1.7 }}>
{`例：代码开发系统

Router（需求分类）
├─ bug 修复 → Debate（生成↔Review）
├─ 新功能  → Supervisor（PM→Dev→QA）
└─ 重构   → MapReduce（多文件分析）

判断口诀：
· 顺序走 → Pipeline
· 分叉走 → Router
· 有人管 → Supervisor
· 互相挑 → Debate
· 一起干 → MapReduce`}
                </pre>
              </div>
            </Card>
          </Col>
        </Row>
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 10. 运行结果 */}
      <div id="result" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <ApiOutlined /> 10. 运行结果 MultiAgentResult
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          所有编排模式的 <code>run()</code> 都返回统一的 <code>MultiAgentResult</code>，包含最终输出、
          各 Agent 结果、累计用量、执行步数与共享上下文快照。
        </Paragraph>
        <Divider orientation="left">MultiAgentResult 字段</Divider>
        <table className="params-table">
          <thead>
            <tr>
              <th style={{ width: '22%' }}>字段</th>
              <th style={{ width: '30%' }}>类型</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><span className="param-name">content</span></td>
              <td><span className="param-type">string</span></td>
              <td>最终输出文本（最后一个执行 Agent 的输出）</td>
            </tr>
            <tr>
              <td><span className="param-name">lastAgentId</span></td>
              <td><span className="param-type">string</span></td>
              <td>最后执行的 Agent ID</td>
            </tr>
            <tr>
              <td><span className="param-name">agentResults</span></td>
              <td><span className="param-type">Map&lt;string, Result&gt;</span></td>
              <td>各 Agent 执行结果（Debate 按 agentId_rN 存）</td>
            </tr>
            <tr>
              <td><span className="param-name">totalUsage</span></td>
              <td><span className="param-type">Record&lt;string, number&gt;</span></td>
              <td>累计 token 用量</td>
            </tr>
            <tr>
              <td><span className="param-name">stepsCompleted</span></td>
              <td><span className="param-type">number</span></td>
              <td>执行步数</td>
            </tr>
            <tr>
              <td><span className="param-name">stopReason</span></td>
              <td><span className="param-type">string</span></td>
              <td>停止原因（completed / converged_at_round_N / max_rounds_reached / error / finish_condition）</td>
            </tr>
            <tr>
              <td><span className="param-name">context</span></td>
              <td><span className="param-type">SharedContext</span></td>
              <td>共享上下文快照（含 blackboard）</td>
            </tr>
            <tr>
              <td><span className="param-name">success</span></td>
              <td><span className="param-type">boolean</span></td>
              <td>是否成功</td>
            </tr>
            <tr>
              <td><span className="param-name">error</span></td>
              <td><span className="param-type">string?</span></td>
              <td>错误信息（仅失败时）</td>
            </tr>
          </tbody>
        </table>
      </div>

      <Divider />

      <div style={{ padding: 24, background: '#f0fdf4', borderRadius: 12, border: '1px solid #bbf7d0' }}>
        <h3 style={{ marginTop: 0, color: '#166534' }}>💡 模板速查</h3>
        <ul style={{ color: '#14532d', lineHeight: 2 }}>
          <li>顺序流水线 → <b>createPipeline([A, B, C])</b>（翻译→润色→校对）</li>
          <li>意图分发 → <b>createRouter(dispatcher, targets, {'{ resolve }'})</b>（客服路由）</li>
          <li>上下级分工 → <b>createSupervisor(pm, workers, {'{ schedule }'})</b>（PM→前端/后端/QA）</li>
          <li>生成↔审核循环 → <b>createDebate(coder, reviewer, {'{ convergeWhen }'})</b>（代码 Review）</li>
          <li>批量并行 → <b>createMapReduce(mapper, reducer, {'{ split }'})</b>（多文件分析）</li>
          <li>自由编排 → <b>createAgentGraph()</b> 链式定义节点+边+条件+循环</li>
          <li>暴露给外部 MCP → <b>new MCPBridge(graph, opts)</b></li>
          <li>可视化调试 → <b>new GraphDebugger(graph)</b> 导出 DOT / 记录 Trace</li>
        </ul>
      </div>

      <div style={{ height: 80 }} />
    </div>
  );
}
