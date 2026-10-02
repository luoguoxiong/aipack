import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { Alert, Card, Row, Col, Tag, Divider, Typography, Table } from 'antd';
import {
  ExperimentOutlined,
  RocketOutlined,
  ThunderboltOutlined,
  CodeOutlined,
  FileTextOutlined,
  BugOutlined,
  CloudServerOutlined,
  AimOutlined,
  SafetyCertificateOutlined,
  ApartmentOutlined,
  DeploymentUnitOutlined,
  LineChartOutlined,
  SettingOutlined,
  CheckCircleOutlined,
} from '@ant-design/icons';
import CodeBlock from '../components/CodeBlock';
import {
  evalQuickstartCode,
  evalCaseCode,
  evalMaxStepsCaseCode,
  evalMockToolsCode,
  evalLiveCode,
  evalLiveProgrammaticCode,
  evalScorersCode,
  evalCliCode,
  evalBaselineCode,
  evalBaselineProgrammaticCode,
  evalImportCode,
  evalHistoryCode,
  evalJudgeCode,
} from '../data/evalCode';

const { Title, Paragraph } = Typography;

const featureCards = [
  {
    icon: <BugOutlined />,
    title: 'Mock 模式（fixture replay）',
    desc: '脚本化 LLM 轮次回放 + 确定性 mock 工具集，零 API Key、零随机性，可跑死循环/错误恢复等极端场景',
  },
  {
    icon: <CloudServerOutlined />,
    title: 'Live 模式（真实 LLM）',
    desc: "provider/modelId 装配真实模型，工具仍走 mock 工具集保确定性；temperature 0 + repeats pass@k 消噪",
  },
  {
    icon: <AimOutlined />,
    title: '8 种规则评分器',
    desc: 'exact / contains / regex / json-field / tool-call / tools-used / success / stop-reason，M5 扩展 semantic / llm-judge',
  },
  {
    icon: <LineChartOutlined />,
    title: '报告与基线门禁',
    desc: 'Markdown/JSON 双报告 + baseline 回归阈值门禁 + JSONL 历史趋势 sparkline，可直接进 CI',
  },
  {
    icon: <ApartmentOutlined />,
    title: '多模型对比',
    desc: 'compare 子命令：同一组用例横评多个模型，输出对比报告，选型不再拍脑袋',
  },
  {
    icon: <DeploymentUnitOutlined />,
    title: 'Trace 回流入库',
    desc: '线上 export-eval 导出 → import 一键变成回归用例，按 origin 分组诊断分布漂移',
  },
];

const scorerColumns = [
  { title: '评分器', dataIndex: 'type', width: '18%' },
  { title: '断言内容', dataIndex: 'desc' },
  {
    title: '关键参数',
    dataIndex: 'params',
    render: (v: string) => <code style={{ fontSize: 12 }}>{v}</code>,
  },
];

const scorerData = [
  { type: 'exact', desc: '最终文本精确相等', params: 'value' },
  { type: 'contains', desc: '最终文本包含指定片段', params: 'value' },
  { type: 'regex', desc: '最终文本匹配正则', params: 'value, flags' },
  { type: 'json-field', desc: '最终文本解析 JSON 后取字段断言（点路径）', params: 'path, value?' },
  { type: 'tool-call', desc: '工具调用轨迹断言（参数部分匹配），order=exact 断言顺序', params: 'calls, order' },
  { type: 'tools-used', desc: '用过的工具集合覆盖断言', params: 'tools' },
  { type: 'success', desc: '运行成功与否', params: 'value?' },
  { type: 'stop-reason', desc: '结束原因断言（stop / max_turns / ...）', params: 'value' },
  {
    type: (
      <>
        semantic <Tag style={{ marginLeft: 4 }}>M5</Tag>
      </>
    ),
    desc: 'Embedding 余弦相似度断言（需配置 embed 模型）',
    params: 'value, threshold?',
  },
  {
    type: (
      <>
        llm-judge <Tag style={{ marginLeft: 4 }}>M5</Tag>
      </>
    ),
    desc: 'LLM-as-judge 评审（必须与被测模型异源）',
    params: 'rubric, ...',
  },
];

const configColumns = [
  { title: '字段', dataIndex: 'name', width: '22%' },
  { title: '类型', dataIndex: 'type', width: '16%' },
  { title: '默认', dataIndex: 'def', width: '14%' },
  { title: '说明', dataIndex: 'desc' },
];

const configData = [
  { name: 'mode', type: "'mock' | 'live'", def: "'mock'", desc: '运行模式' },
  { name: 'model', type: 'string', def: 'AIPACK_EVAL_MODEL', desc: "live 被测模型（'provider/modelId'）" },
  { name: 'apiKey / baseUrl', type: 'string', def: '<PROVIDER>_API_KEY', desc: 'live 鉴权与端点覆盖（代理/兼容网关）' },
  { name: 'temperature', type: 'number', def: '0', desc: 'live 采样温度（消随机性）' },
  { name: 'streamFn / frameworkModel', type: 'StreamFn / Model', def: '—', desc: '直接注入流函数（自托管 provider/测试用）' },
  { name: 'suites', type: 'string[]', def: '全部', desc: '只跑指定套件' },
  { name: 'repeats', type: 'number', def: 'mock 1 / live 3', desc: '每用例重复次数（pass@k 判定：通过 1 次即过）' },
  { name: 'concurrency', type: 'number', def: '8', desc: '用例并发数' },
  { name: 'timeoutMs', type: 'number', def: '30000', desc: '单用例墙钟超时（case metadata 可覆盖）' },
  { name: 'maxSteps', type: 'number', def: '50', desc: '工具调用步数上限（映射 maxTurns）' },
  { name: 'maxTotalTokens', type: 'number', def: '—', desc: '全局 token 预算，超限熔断未开始的用例（防烧钱）' },
  { name: 'casesDir / reportDir', type: 'string', def: '—', desc: '用例目录 / 报告输出目录' },
  { name: 'baselinePath / updateBaseline', type: 'string / boolean', def: '—', desc: 'baseline 门禁对比 / 用本次结果更新 baseline' },
  { name: 'regressionThreshold', type: 'number', def: '0.02', desc: '通过率回归阈值' },
  { name: 'historyPath', type: 'string', def: '<reportDir>/history.jsonl', desc: '历史趋势 JSONL 路径（不配则不记录）' },
  { name: 'judgeModel / judgeApiKey', type: 'string', def: 'AIPACK_EVAL_JUDGE_*', desc: 'LLM-as-judge 模型（须与被测模型异源）' },
  { name: 'embedModel / embedApiKey', type: 'string', def: 'AIPACK_EVAL_EMBEDDING_*', desc: 'semantic 评分器的 embedding 模型（OpenAI 兼容）' },
];

export default function EvalPage() {
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
        <ExperimentOutlined style={{ color: '#6366f1' }} /> Eval 评测体系
      </h1>
      <p className="section-subtitle">
        <b>@aipack-ai/eval</b> 提供 Agent 评测闭环：EvalCase 用例格式 → Runner（mock replay / live 真实 LLM）→
        规则/LLM 评分器 → Markdown 报告 + baseline 门禁 + 历史趋势。轨迹优先——工具调用轨迹是 Agent 框架最值得断言的信号。
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
          message="零配置启动"
          description="mock 模式不需要任何 API Key：LLM 回放脚本、工具走确定性 mock 工具集。加一个用例 JSON 就能跑出报告，report + baseline + history 可直接挂进 CI 门禁。"
          style={{ marginBottom: 32 }}
        />
      </div>

      {/* 1. 快速开始 */}
      <div id="quickstart" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <RocketOutlined /> 1. 快速开始
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          编程接入只需三步：<code>loadCases()</code> 加载用例、<code>runEval()</code> 运行、
          <code>renderMarkdown()</code> 渲染报告。CLI 也可以直接 <code>aipack-eval run</code>。
        </Paragraph>
        <CodeBlock code={evalQuickstartCode} language="typescript" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 2. 用例格式 */}
      <div id="case" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <FileTextOutlined /> 2. 用例格式（EvalCase）
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          用例是纯 JSON，放在 <code>eval/cases/&lt;suite&gt;/</code> 目录下。四个核心字段：
          <code>input</code>（输入 + mock 脚本）、<code>expected</code> / <code>scorers</code>（期望与评分器）、
          <code>origin</code>（数据来源）、<code>metadata</code>（maxSteps / timeoutMs / maxTokens 等运行约束）。
        </Paragraph>
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={12}>
            <Card size="small" title="典型用例：工具轨迹 + 文本断言" style={{ height: '100%' }}>
              <CodeBlock code={evalCaseCode} language="json" />
            </Card>
          </Col>
          <Col xs={24} lg={12}>
            <Card size="small" title="极端用例：死循环被 maxTurns 截断" style={{ height: '100%' }}>
              <CodeBlock code={evalMaxStepsCaseCode} language="json" />
            </Card>
          </Col>
        </Row>
        <Divider orientation="left">关键字段说明</Divider>
        <Title level={5} style={{ marginTop: 8 }}>EvalCase</Title>
        <table className="params-table">
          <thead>
            <tr>
              <th style={{ width: '20%' }}>字段</th>
              <th style={{ width: '18%' }}>类型</th>
              <th style={{ width: '12%' }}>默认</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><span className="param-name">id</span></td>
              <td><span className="param-type">string</span></td>
              <td>必填</td>
              <td>全局唯一，如 <code>tool-calling/read-then-answer</code></td>
            </tr>
            <tr>
              <td><span className="param-name">suite</span></td>
              <td><span className="param-type">string</span></td>
              <td>必填</td>
              <td>套件名（agent-e2e / tool-calling / text-output / ...），报告按套件聚合</td>
            </tr>
            <tr>
              <td><span className="param-name">mode</span></td>
              <td><span className="param-type">'mock' | 'live'</span></td>
              <td><code>—</code></td>
              <td>模式约束：缺省时按是否有 <code>input.mock</code> 自动判定；不匹配的用例被跳过且不计入通过率</td>
            </tr>
            <tr>
              <td><span className="param-name">input.message</span></td>
              <td><span className="param-type">string</span></td>
              <td>必填</td>
              <td>用户消息</td>
            </tr>
            <tr>
              <td><span className="param-name">input.tools</span></td>
              <td><span className="param-type">string[]</span></td>
              <td>全部标准工具</td>
              <td>注册的 mock 工具名列表</td>
            </tr>
            <tr>
              <td><span className="param-name">input.fs</span></td>
              <td><span className="param-type">Record&lt;string,string&gt;</span></td>
              <td><code>{'{}'}</code></td>
              <td>预置 mock 文件系统（readFile / writeFile / listDir / search 消费）</td>
            </tr>
            <tr>
              <td><span className="param-name">input.mock</span></td>
              <td><span className="param-type">MockScript</span></td>
              <td>—</td>
              <td>脚本化 LLM 轮次；<code>infiniteTool</code> 可模拟死循环配合 maxSteps 断言</td>
            </tr>
            <tr>
              <td><span className="param-name">expected</span></td>
              <td><span className="param-type">ExpectedResult</span></td>
              <td>—</td>
              <td>声明式期望，loader 自动归一化为 scorers，可与 scorers 并存</td>
            </tr>
            <tr>
              <td><span className="param-name">scorers</span></td>
              <td><span className="param-type">ScorerConfig[]</span></td>
              <td>—</td>
              <td>显式评分器配置，<code>weight</code> 影响加权分</td>
            </tr>
            <tr>
              <td><span className="param-name">origin</span></td>
              <td><span className="param-type">CaseOrigin</span></td>
              <td>必填</td>
              <td>handwritten / trace / synthetic / dataset / bugfix —— 报告按来源分组诊断分布漂移</td>
            </tr>
            <tr>
              <td><span className="param-name">metadata.maxSteps</span></td>
              <td><span className="param-type">number</span></td>
              <td><code>50</code></td>
              <td>工具调用步数上限（映射 RuntimeOptions.maxTurns）</td>
            </tr>
            <tr>
              <td><span className="param-name">metadata.timeoutMs</span></td>
              <td><span className="param-type">number</span></td>
              <td><code>30000</code></td>
              <td>单用例墙钟超时</td>
            </tr>
            <tr>
              <td><span className="param-name">metadata.maxTokens</span></td>
              <td><span className="param-type">number</span></td>
              <td>—</td>
              <td>usage.total token 上限（预算熔断）</td>
            </tr>
          </tbody>
        </table>
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 3. Mock 模式 */}
      <div id="mock" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <BugOutlined /> 3. Mock 模式（fixture replay）
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          mock 模式下 LLM 按 <code>input.mock.turns</code> 逐轮回放，工具走内置的确定性 mock 工具集。
          由于输入输出完全确定，mock 用例适合做回归测试与 CI 门禁。
        </Paragraph>
        <CodeBlock code={evalMockToolsCode} language="typescript" />
        <Alert
          type="info"
          showIcon
          message="按 case 隔离"
          description="每次 createMockTools 都返回独立 fs 副本（深拷贝），用例之间互不影响；轮次耗尽后回放 fallbackText（缺省 'done'）。"
          style={{ marginTop: 16 }}
        />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 4. Live 模式 */}
      <div id="live" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <CloudServerOutlined /> 4. Live 模式（真实 LLM）
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          live 模式把 <code>provider/modelId + apiKey + baseUrl</code> 装配成真实 StreamFn；
          <b>工具仍走 mock 工具集</b>，保证环境确定性、只测模型能力。
          随机性消解：temperature 缺省 0 + repeats 重复（pass@k：通过 1 次即算过）。
        </Paragraph>
        <CodeBlock code={evalLiveCode} language="bash" />
        <CodeBlock code={evalLiveProgrammaticCode} language="typescript" />
        <Alert
          type="warning"
          showIcon
          message="成本控制"
          description="live 模式建议配置 --max-tokens 全局预算（超限熔断剩余用例）与 --timeout 单用例超时；报告会记录每用例 usage.total。"
          style={{ marginTop: 16 }}
        />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 5. 评分器 */}
      <div id="scorers" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <AimOutlined /> 5. 评分器
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          评分器消费 <code>RunTrace</code>（完整运行轨迹：最终文本 + 工具调用时序 + usage）。
          规则评分器输出 0/1，加权平均得到用例分。工具轨迹断言的 <code>args</code> 为<b>部分匹配</b>——只断言列出的字段。
        </Paragraph>
        <CodeBlock code={evalScorersCode} language="typescript" />
        <Table
          style={{ marginTop: 24 }}
          size="small"
          columns={scorerColumns}
          dataSource={scorerData}
          pagination={false}
          rowKey="type"
        />
        <Divider orientation="left">semantic / llm-judge（M5）</Divider>
        <CodeBlock code={evalJudgeCode} language="bash" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 6. CLI 用法 */}
      <div id="cli" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <CodeOutlined /> 6. CLI 用法（aipack-eval）
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          四个子命令：<code>run</code> / <code>compare</code> / <code>import</code> / <code>history</code>。
          退出码即 CI 信号：0 = 全过且无回归，1 = 有失败或回归，2 = 用法错误。
        </Paragraph>
        <CodeBlock code={evalCliCode} language="bash" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 7. Baseline 门禁 */}
      <div id="baseline" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <SafetyCertificateOutlined /> 7. Baseline 门禁
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          把一次「全绿」运行的通过率固化为 baseline，之后每次运行自动对比：
          整体或任一套件通过率回归超过阈值（缺省 2%）即退出码 1，防患于未然。
        </Paragraph>
        <CodeBlock code={evalBaselineCode} language="bash" />
        <CodeBlock code={evalBaselineProgrammaticCode} language="typescript" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 8. 模型对比 */}
      <div id="compare" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <ApartmentOutlined /> 8. 模型对比（compare）
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          <code>compare</code> 让多个模型跑<b>同一组用例</b>，输出横评报告（Markdown + JSON 落盘），
          配合 <code>llm-judge</code> / <code>semantic</code> 评分器可以做非规则维度的质量对比。
        </Paragraph>
        <CodeBlock code={`aipack-eval compare \\
  --models deepseek/deepseek-chat,openai/gpt-4o-mini,anthropic/claude-sonnet-4-5 \\
  --mode live --suite agent-e2e-live \\
  --repeats 3 \\
  --report-dir ./eval-results`} language="bash" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 9. Trace 回流 */}
      <div id="import" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <DeploymentUnitOutlined /> 9. Trace 回流入库
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          线上 badcase 是最宝贵的评测资产。<code>import</code> 把 <code>export-eval</code> 导出的
          trace JSON 一键变成回归用例，bug 一旦修好就永远有回归护栏。
        </Paragraph>
        <CodeBlock code={evalImportCode} language="bash" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 10. 历史趋势 */}
      <div id="history" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <LineChartOutlined /> 10. 历史趋势（日环比）
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          每次运行追加一条 JSONL 历史记录，<code>history</code> 子命令渲染 sparkline 趋势，
          直观看到通过率随时间的变化（接 CI 定时跑即可积累）。
        </Paragraph>
        <CodeBlock code={evalHistoryCode} language="typescript" />
        <CodeBlock code={`$ aipack-eval history --limit 10
date        runId       pass-rate  trend
2026-09-28  run-a1b2c3  97.6%      ▃▅
2026-09-29  run-d4e5f6  100.0%     ▅▇
2026-09-30  run-g7h8i9  95.2%      ▇▂  ← 回归`} language="bash" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 11. RunConfig 全览 */}
      <div id="config" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <SettingOutlined /> 11. RunConfig 全览
        </h2>
        <Table
          size="small"
          columns={configColumns}
          dataSource={configData}
          pagination={false}
          rowKey="name"
        />
        <Alert
          type="success"
          showIcon
          icon={<CheckCircleOutlined />}
          message="报告结构（EvalReport）"
          description="runId / startedAt / mode / model + totals（cases/passed/skipped/passRate/avgScore/usageTotal）+ bySuite + byOrigin + results（每用例明细，含 repeats 聚合与 passCount）+ skipped（模式不匹配的用例）。"
          style={{ marginTop: 24 }}
        />
      </div>

      <Paragraph style={{ marginTop: 40, color: '#94a3b8', fontSize: 12 }}>
        更多细节见 <code>packages/eval/index.ts</code> 导出面与 <code>EVAL_PLAN.md</code> 设计文档。
      </Paragraph>
    </div>
  );
}
