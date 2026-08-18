import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { Alert, Card, Row, Col, Tag, List, Divider, Typography } from 'antd';
import {
  DatabaseOutlined,
  RocketOutlined,
  ThunderboltOutlined,
  CodeOutlined,
  ExperimentOutlined,
  SafetyCertificateOutlined,
  CheckCircleOutlined,
  CloudSyncOutlined,
  BulbOutlined,
  SearchOutlined,
  ToolOutlined,
  DeleteOutlined,
  MergeCellsOutlined,
  ClockCircleOutlined,
} from '@ant-design/icons';
import CodeBlock from '../components/CodeBlock';
import {
  memQuickstartCode,
  memCaptureCode,
  memInjectionCode,
  memHybridRetrievalCode,
  memToolsCode,
  memConsolidationCode,
  memStoreApiCode,
  memCustomStoreCode,
  memEventSinkCode,
  memTtlCode,
} from '../data/memoryCode';

const { Title, Paragraph } = Typography;

const featureCards = [
  {
    icon: <CloudSyncOutlined />,
    title: '自动捕获',
    desc: '每轮对话结束自动提取要点存为可检索记忆，零 LLM 或可选 LLM 摘要',
  },
  {
    icon: <SearchOutlined />,
    title: '自动注入',
    desc: '每轮开始自动检索相关记忆，sentinel 机制防累积，检索统计实时更新',
  },
  {
    icon: <ExperimentOutlined />,
    title: 'BM25 + 向量混合',
    desc: '零依赖 BM25（CJK bigram 分词），配置 Embedder 后升级双路混合检索',
  },
  {
    icon: <MergeCellsOutlined />,
    title: '记忆合并',
    desc: '增量去重、相似合并、TTL 过期修剪，置信度 max + 小奖励防饱和',
  },
  {
    icon: <ToolOutlined />,
    title: '4 个 Agent 工具',
    desc: 'save_memory / search_memory / list_memories / delete_memory',
  },
  {
    icon: <SafetyCertificateOutlined />,
    title: '并发安全',
    desc: 'keyed mutex 串行化同 id 写操作，temp + rename 原子替换',
  },
];

export default function MemoryPage() {
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
        <DatabaseOutlined style={{ color: '#6366f1' }} /> 持久化记忆
      </h1>
      <p className="section-subtitle">
        <b>@aipack-ai/memory</b> 提供完整的记忆闭环：capture → compress → index → recall/inject → consolidate。
        自动捕获每轮对话要点、跨会话检索注入、BM25 + 向量双路混合召回，一行代码接入即可使用。
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
          message="零依赖启动"
          description="默认使用 FileMemoryStore + 纯 BM25 检索，无需任何外部服务或 API Key。配置 Embedder 后自动升级为混合检索。"
          style={{ marginBottom: 32 }}
        />
      </div>

      {/* 1. 快速开始 */}
      <div id="quickstart" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <RocketOutlined /> 1. 快速开始
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          <code>createMemoryPlugin()</code> 一行创建，<code>install()</code> 拿到 extensions / transformers / tools，
          注入 Runtime 即可。默认配置开箱即用：自动捕获 + 自动注入 + 4 个记忆工具。
        </Paragraph>
        <CodeBlock code={memQuickstartCode} language="typescript" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 2. 数据流闭环 */}
      <div id="pipeline" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <ThunderboltOutlined /> 2. 数据流闭环
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          记忆系统围绕 5 个阶段构成闭环，覆盖从捕获到整合的完整生命周期：
        </Paragraph>
        <div className="arch-container" style={{ marginTop: 16 }}>
          <div className="arch-layers">
            <div className="arch-layer">
              <div className="arch-label">写入</div>
              <div className="arch-boxes">
                <div className="arch-box arch-box-extension">
                  <CloudSyncOutlined style={{ fontSize: 20 }} />
                  <div style={{ fontWeight: 700, marginTop: 4 }}>Capture</div>
                  <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4 }}>
                    每轮对话结束，Extension 自动提取要点 → save
                  </div>
                </div>
                <div className="arch-box arch-box-core">
                  <ToolOutlined style={{ fontSize: 20 }} />
                  <div style={{ fontWeight: 700, marginTop: 4 }}>Tool</div>
                  <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4 }}>
                    Agent 主动调用 save_memory 显式保存
                  </div>
                </div>
              </div>
            </div>
            <div className="arch-arrow">▼</div>
            <div className="arch-layer">
              <div className="arch-label">索引</div>
              <div className="arch-boxes">
                <div className="arch-box arch-box-adapter">
                  <SearchOutlined style={{ fontSize: 20 }} />
                  <div style={{ fontWeight: 700, marginTop: 4 }}>Index</div>
                  <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4 }}>
                    BM25 倒排索引 + 可选向量索引（增量更新）
                  </div>
                </div>
              </div>
            </div>
            <div className="arch-arrow">▼</div>
            <div className="arch-layer">
              <div className="arch-label">读取</div>
              <div className="arch-boxes">
                <div className="arch-box arch-box-storage">
                  <SearchOutlined style={{ fontSize: 20 }} />
                  <div style={{ fontWeight: 700, marginTop: 4 }}>Recall</div>
                  <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4 }}>
                    HybridRetriever：BM25 / 向量 / 混合检索
                  </div>
                </div>
                <div className="arch-box arch-box-core">
                  <ThunderboltOutlined style={{ fontSize: 20 }} />
                  <div style={{ fontWeight: 700, marginTop: 4 }}>Inject</div>
                  <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4 }}>
                    Transformer 自动注入 top-K 到 user 消息
                  </div>
                </div>
              </div>
            </div>
            <div className="arch-arrow">▼</div>
            <div className="arch-layer">
              <div className="arch-label">维护</div>
              <div className="arch-boxes">
                <div className="arch-box arch-box-adapter">
                  <MergeCellsOutlined style={{ fontSize: 20 }} />
                  <div style={{ fontWeight: 700, marginTop: 4 }}>Consolidate</div>
                  <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4 }}>
                    增量去重 + 相似合并 + 修剪过期/低置信度
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 3. 自动捕获 */}
      <div id="capture" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <CloudSyncOutlined /> 3. 自动捕获（Capture）
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          <code>MemoryCaptureExtension</code> 在 Runtime 生命周期中「静默」捕获每轮对话要点。
          默认零 LLM 抽取（从对话文本中提取要点和概念），配置 <code>summarizeFn</code> 后升级为 LLM 摘要。
          仅捕获成功回合，失败回合不写入记忆库。
        </Paragraph>
        <CodeBlock code={memCaptureCode} language="typescript" />
        <Divider orientation="left">CaptureOptions 参数</Divider>
        <table className="params-table">
          <thead>
            <tr>
              <th style={{ width: '24%' }}>字段</th>
              <th style={{ width: '16%' }}>类型</th>
              <th style={{ width: '14%' }}>默认</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><span className="param-name">minLength</span></td>
              <td><span className="param-type">number</span></td>
              <td><code>12</code></td>
              <td>最小用户消息长度，小于则跳过捕获</td>
            </tr>
            <tr>
              <td><span className="param-name">maxConcepts</span></td>
              <td><span className="param-type">number</span></td>
              <td><code>8</code></td>
              <td>概念标签数上限</td>
            </tr>
            <tr>
              <td><span className="param-name">maxContentChars</span></td>
              <td><span className="param-type">number</span></td>
              <td><code>2000</code></td>
              <td>content 最大字符数</td>
            </tr>
            <tr>
              <td><span className="param-name">consolidateEvery</span></td>
              <td><span className="param-type">number</span></td>
              <td><code>0</code></td>
              <td>每 N 次捕获自动触发一次合并（0=不自动）</td>
            </tr>
            <tr>
              <td><span className="param-name">summarizeFn</span></td>
              <td><span className="param-type">SummarizeFn</span></td>
              <td>—</td>
              <td>LLM 摘要函数，配置后 capture 走 LLM 摘要</td>
            </tr>
            <tr>
              <td><span className="param-name">ttlMs</span></td>
              <td><span className="param-type">number?</span></td>
              <td>—</td>
              <td>捕获记忆 TTL（ms），过期后 prune 清理</td>
            </tr>
          </tbody>
        </table>
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 4. 自动注入 */}
      <div id="injection" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <ThunderboltOutlined /> 4. 自动注入（Inject）
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          <code>MemoryInjectionTransformer</code> 在每轮模型调用前自动运行。采用 sentinel 机制防止记忆累积：
          先剥除上一轮注入的记忆块，再检索最新相关记忆前插进 user 消息。记忆块合并进最新 user 消息
          （而非新增独立消息或 system 消息），保证 provider 兼容性。
        </Paragraph>
        <CodeBlock code={memInjectionCode} language="typescript" />
        <Divider orientation="left">InjectionOptions 参数</Divider>
        <table className="params-table">
          <thead>
            <tr>
              <th style={{ width: '24%' }}>字段</th>
              <th style={{ width: '16%' }}>类型</th>
              <th style={{ width: '14%' }}>默认</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><span className="param-name">maxMemories</span></td>
              <td><span className="param-type">number</span></td>
              <td><code>5</code></td>
              <td>注入 top-K 上限</td>
            </tr>
            <tr>
              <td><span className="param-name">minScore</span></td>
              <td><span className="param-type">number</span></td>
              <td><code>0.1</code></td>
              <td>最低相关度阈值</td>
            </tr>
            <tr>
              <td><span className="param-name">queryTransform</span></td>
              <td><span className="param-type">(text) =&gt; string</span></td>
              <td>—</td>
              <td>对检索 query 做变换（如抽取提问主体）</td>
            </tr>
            <tr>
              <td><span className="param-name">onRecall</span></td>
              <td><span className="param-type">(ids) =&gt; void</span></td>
              <td>—</td>
              <td>命中记忆后的回调（插件层装配为 store.touchRecall）</td>
            </tr>
          </tbody>
        </table>
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 5. 混合检索 */}
      <div id="retrieval" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <SearchOutlined /> 5. 混合检索（BM25 + 向量）
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          <code>HybridRetriever</code> 支持 BM25 单路和 BM25 + 向量双路独立召回。默认纯 BM25 模式（零依赖、零 API Key），
          配置 <code>Embedder</code> 后自动升级为双路混合：BM25 和向量各自独立召回 top-K×3 候选，
          各自 min-max 归一化后按权重融合，过滤 <code>minScore</code> 并截断。
        </Paragraph>
        <CodeBlock code={memHybridRetrievalCode} language="typescript" />
        <Divider orientation="left">检索模式对比</Divider>
        <Row gutter={[16, 16]}>
          <Col xs={24} md={12}>
            <Card size="small" title="纯 BM25（默认）" style={{ height: '100%' }}>
              <List size="small" dataSource={[
                '零依赖、零 API Key、零 token 消耗',
                '内置 CJK bigram 分词（中日韩友好）',
                '关键词精准匹配，短查询表现好',
                '语义理解能力有限',
              ]} renderItem={(item) => (
                <List.Item style={{ padding: '4px 0', border: 'none' }}>
                  <CheckCircleOutlined style={{ color: '#10b981', marginRight: 8 }} />
                  <span style={{ fontSize: 13, color: '#475569' }}>{item}</span>
                </List.Item>
              )} />
            </Card>
          </Col>
          <Col xs={24} md={12}>
            <Card size="small" title="BM25 + 向量混合" style={{ height: '100%', border: '2px solid #6366f1' }}>
              <List size="small" dataSource={[
                '需配置 Embedder（可接入 ollama / OpenAI 等）',
                '双路独立召回，互补性强',
                '语义相似但用词不同的记忆也能命中',
                'BM25 权重 + 向量权重可调（默认各 0.5）',
              ]} renderItem={(item) => (
                <List.Item style={{ padding: '4px 0', border: 'none' }}>
                  <CheckCircleOutlined style={{ color: '#6366f1', marginRight: 8 }} />
                  <span style={{ fontSize: 13, color: '#475569' }}>{item}</span>
                </List.Item>
              )} />
            </Card>
          </Col>
        </Row>
        <Divider orientation="left">Embedder 接口</Divider>
        <table className="params-table">
          <thead>
            <tr>
              <th style={{ width: '24%' }}>方法</th>
              <th style={{ width: '24%' }}>类型</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><span className="param-name">embed(text)</span><span className="param-required">必填</span></td>
              <td><span className="param-type">(text: string) =&gt; Promise&lt;number[]&gt;</span></td>
              <td>将文本转为向量</td>
            </tr>
            <tr>
              <td><span className="param-name">dimension</span></td>
              <td><span className="param-type">number?</span></td>
              <td>向量维度（可选，用于校验）</td>
            </tr>
          </tbody>
        </table>
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 6. Agent 工具 */}
      <div id="tools" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <ToolOutlined /> 6. Agent 记忆工具
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          插件自动注册 4 个 Agent 可调用的工具，Agent 会在对话中自主决定何时使用。
          默认开启，设置 <code>tools: false</code> 可关闭。
        </Paragraph>
        <CodeBlock code={memToolsCode} language="typescript" />
        <Divider orientation="left">工具一览</Divider>
        <table className="params-table">
          <thead>
            <tr>
              <th style={{ width: '22%' }}>工具名</th>
              <th style={{ width: '22%' }}>必填参数</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><span className="param-name">save_memory</span></td>
              <td><span className="param-type">content</span></td>
              <td>保存一条长期记忆，可选 concepts 关键词标签。置信度默认 0.7，source 为 tool</td>
            </tr>
            <tr>
              <td><span className="param-name">search_memory</span></td>
              <td><span className="param-type">query</span></td>
              <td>检索相关记忆（BM25 + 可选向量混合），返回按相关度排序的列表</td>
            </tr>
            <tr>
              <td><span className="param-name">list_memories</span></td>
              <td>—</td>
              <td>列出最近的记忆（按 updatedAt 降序），默认返回 20 条</td>
            </tr>
            <tr>
              <td><span className="param-name">delete_memory</span></td>
              <td><span className="param-type">id</span></td>
              <td>按 id 删除一条记忆</td>
            </tr>
          </tbody>
        </table>
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 7. 记忆合并与修剪 */}
      <div id="consolidation" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <MergeCellsOutlined /> 7. 记忆合并与修剪（Consolidate）
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          <code>Consolidator</code> 负责记忆的增量去重和修剪。采用增量合并策略：仅处理上次合并以来内容有更新的条目，
          避免 O(N²) 全量比对。合并时 content 取较长、concepts 取并集、置信度取 max + 0.05 小奖励（防快速饱和到 1.0）。
        </Paragraph>
        <CodeBlock code={memConsolidationCode} language="typescript" />
        <Divider orientation="left">ConsolidateOptions 参数</Divider>
        <table className="params-table">
          <thead>
            <tr>
              <th style={{ width: '24%' }}>字段</th>
              <th style={{ width: '16%' }}>类型</th>
              <th style={{ width: '14%' }}>默认</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><span className="param-name">similarityThreshold</span></td>
              <td><span className="param-type">number</span></td>
              <td><code>0.85</code></td>
              <td>相似度阈值，&gt;= 该值视为可合并（按检索原始分数判定）</td>
            </tr>
            <tr>
              <td><span className="param-name">maxMemories</span></td>
              <td><span className="param-type">number?</span></td>
              <td>—</td>
              <td>合并后记忆数量上限（保留置信度最高的）</td>
            </tr>
            <tr>
              <td><span className="param-name">maxAgeMs</span></td>
              <td><span className="param-type">number?</span></td>
              <td>—</td>
              <td>最大保留时长（ms），超过则修剪</td>
            </tr>
            <tr>
              <td><span className="param-name">minConfidence</span></td>
              <td><span className="param-type">number</span></td>
              <td><code>0.1</code></td>
              <td>最低置信度，低于则修剪</td>
            </tr>
          </tbody>
        </table>
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 8. TTL 过期机制 */}
      <div id="ttl" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <ClockCircleOutlined /> 8. TTL 过期机制
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          支持全局 maxAge 和单条 TTL 两种过期粒度。FileMemoryStore 在加载时惰性清理过期条目；
          save 时指定 <code>ttlMs</code> 会换算为 <code>expiresAt</code>，prune 时检查清除。
        </Paragraph>
        <CodeBlock code={memTtlCode} language="typescript" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 9. MemoryStore API */}
      <div id="store-api" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <CodeOutlined /> 9. MemoryStore 编程式 API
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          通过 <code>mem.store</code> 可直接编程式调用 MemoryStore 的所有方法，适合自定义管理场景
          （定时合并、统计监控、批量导入等）。
        </Paragraph>
        <CodeBlock code={memStoreApiCode} language="typescript" />
        <Divider orientation="left">MemoryStore 接口方法一览</Divider>
        <table className="params-table">
          <thead>
            <tr>
              <th style={{ width: '22%' }}>方法</th>
              <th style={{ width: '30%' }}>签名</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><span className="param-name">save</span></td>
              <td><span className="param-type">(input) =&gt; Promise&lt;MemoryEntry&gt;</span></td>
              <td>保存记忆（新建或更新），自动填充 id / createdAt / updatedAt / recallCount</td>
            </tr>
            <tr>
              <td><span className="param-name">get</span></td>
              <td><span className="param-type">(id) =&gt; Promise&lt;MemoryEntry | null&gt;</span></td>
              <td>读取单条记忆</td>
            </tr>
            <tr>
              <td><span className="param-name">delete</span></td>
              <td><span className="param-type">(id) =&gt; Promise&lt;boolean&gt;</span></td>
              <td>删除单条，返回是否删除成功</td>
            </tr>
            <tr>
              <td><span className="param-name">list</span></td>
              <td><span className="param-type">(limit?) =&gt; Promise&lt;MemoryEntry[]&gt;</span></td>
              <td>按 updatedAt 降序列出记忆</td>
            </tr>
            <tr>
              <td><span className="param-name">search</span></td>
              <td><span className="param-type">(query, limit?) =&gt; Promise&lt;MemorySearchResult[]&gt;</span></td>
              <td>基于查询检索（BM25 或混合）</td>
            </tr>
            <tr>
              <td><span className="param-name">searchVectors</span></td>
              <td><span className="param-type">(vec, limit?) =&gt; Promise&lt;MemorySearchResult[]&gt;</span></td>
              <td>基于向量检索（需配置 Embedder）</td>
            </tr>
            <tr>
              <td><span className="param-name">touchRecall</span></td>
              <td><span className="param-type">(id, at?) =&gt; Promise&lt;void&gt;</span></td>
              <td>更新检索统计（lastRecalledAt / recallCount++）</td>
            </tr>
            <tr>
              <td><span className="param-name">consolidate</span></td>
              <td><span className="param-type">(opts?) =&gt; Promise&lt;&#123;merged, pruned&#125;&gt;</span></td>
              <td>合并相似记忆 + 修剪过期/低置信度</td>
            </tr>
            <tr>
              <td><span className="param-name">prune</span></td>
              <td><span className="param-type">(opts?) =&gt; Promise&lt;number&gt;</span></td>
              <td>仅修剪（按 maxAge / minConfidence / expiresAt）</td>
            </tr>
            <tr>
              <td><span className="param-name">count</span></td>
              <td><span className="param-type">() =&gt; Promise&lt;number&gt;</span></td>
              <td>记忆总数</td>
            </tr>
            <tr>
              <td><span className="param-name">stats</span></td>
              <td><span className="param-type">() =&gt; Promise&lt;MemoryStats&gt;</span></td>
              <td>统计快照（count / bySource / avgConfidence / recallTotal 等）</td>
            </tr>
            <tr>
              <td><span className="param-name">dispose</span></td>
              <td><span className="param-type">() =&gt; void</span></td>
              <td>释放资源（热重载场景）</td>
            </tr>
          </tbody>
        </table>
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 10. 自定义 Store */}
      <div id="custom-store" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <DatabaseOutlined /> 10. 自定义 MemoryStore
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          实现 <code>MemoryStore</code> 接口即可替换默认的 FileMemoryStore，
          适合接入 Redis / SQLite / PostgreSQL 等外部存储。自定义 store 需自行保证 search 的检索能力。
        </Paragraph>
        <CodeBlock code={memCustomStoreCode} language="typescript" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 11. 事件监控 */}
      <div id="events" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <BulbOutlined /> 11. 事件监控
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          通过 <code>onEvent</code> 回调监控记忆系统的关键节点（加载、损坏、向量化失败、捕获失败、合并结果等）。
          默认行为：失败类事件打印到 <code>console.warn</code>。
        </Paragraph>
        <CodeBlock code={memEventSinkCode} language="typescript" />
        <Divider orientation="left">MemoryEvent 类型一览</Divider>
        <table className="params-table">
          <thead>
            <tr>
              <th style={{ width: '24%' }}>type</th>
              <th style={{ width: '20%' }}>触发时机</th>
              <th>关键字段</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><span className="param-name">store:load</span></td>
              <td>记忆库加载完成</td>
              <td>loaded / skipped / ms</td>
            </tr>
            <tr>
              <td><span className="param-name">store:corrupt</span></td>
              <td>文件损坏</td>
              <td>file</td>
            </tr>
            <tr>
              <td><span className="param-name">embedding:error</span></td>
              <td>向量化失败</td>
              <td>id? / error</td>
            </tr>
            <tr>
              <td><span className="param-name">capture:failed</span></td>
              <td>捕获失败</td>
              <td>sessionKey? / error</td>
            </tr>
            <tr>
              <td><span className="param-name">consolidate:failed</span></td>
              <td>合并失败</td>
              <td>error</td>
            </tr>
            <tr>
              <td><span className="param-name">consolidate</span></td>
              <td>合并完成</td>
              <td>merged / pruned / ms</td>
            </tr>
            <tr>
              <td><span className="param-name">prune</span></td>
              <td>修剪完成</td>
              <td>removed</td>
            </tr>
          </tbody>
        </table>
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 12. MemoryPluginOptions 全量配置 */}
      <div id="config" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <CodeOutlined /> 12. 插件配置全览（MemoryPluginOptions）
        </h2>
        <table className="params-table">
          <thead>
            <tr>
              <th style={{ width: '22%' }}>字段</th>
              <th style={{ width: '20%' }}>类型</th>
              <th style={{ width: '12%' }}>默认</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><span className="param-name">baseDir</span></td>
              <td><span className="param-type">string?</span></td>
              <td><code>&lt;cwd&gt;/.aipack/memory</code></td>
              <td>FileMemoryStore 存储目录（支持 ~ 开头）</td>
            </tr>
            <tr>
              <td><span className="param-name">store</span></td>
              <td><span className="param-type">MemoryStore?</span></td>
              <td>—</td>
              <td>自定义 store（覆盖默认 FileMemoryStore）</td>
            </tr>
            <tr>
              <td><span className="param-name">maxMemories</span></td>
              <td><span className="param-type">number?</span></td>
              <td><code>5</code></td>
              <td>注入 top-K 上限</td>
            </tr>
            <tr>
              <td><span className="param-name">minScore</span></td>
              <td><span className="param-type">number?</span></td>
              <td><code>0.1</code></td>
              <td>最低相关度阈值</td>
            </tr>
            <tr>
              <td><span className="param-name">capture</span></td>
              <td><span className="param-type">boolean | CaptureOptions</span></td>
              <td><code>true</code></td>
              <td>捕获开关 / 选项</td>
            </tr>
            <tr>
              <td><span className="param-name">inject</span></td>
              <td><span className="param-type">boolean | InjectionOptions</span></td>
              <td><code>true</code></td>
              <td>注入开关 / 选项</td>
            </tr>
            <tr>
              <td><span className="param-name">tools</span></td>
              <td><span className="param-type">boolean</span></td>
              <td><code>true</code></td>
              <td>记忆工具开关</td>
            </tr>
            <tr>
              <td><span className="param-name">embedder</span></td>
              <td><span className="param-type">Embedder?</span></td>
              <td>—</td>
              <td>向量化器，配置后启用混合检索</td>
            </tr>
            <tr>
              <td><span className="param-name">summarizeFn</span></td>
              <td><span className="param-type">SummarizeFn?</span></td>
              <td>—</td>
              <td>LLM 摘要函数，配置后 capture 走 LLM 摘要</td>
            </tr>
            <tr>
              <td><span className="param-name">consolidateEvery</span></td>
              <td><span className="param-type">number?</span></td>
              <td><code>0</code></td>
              <td>每 N 次捕获自动触发一次合并</td>
            </tr>
            <tr>
              <td><span className="param-name">captureTtlMs</span></td>
              <td><span className="param-type">number?</span></td>
              <td>—</td>
              <td>捕获记忆 TTL（ms）</td>
            </tr>
            <tr>
              <td><span className="param-name">toolTtlMs</span></td>
              <td><span className="param-type">number?</span></td>
              <td>—</td>
              <td>save_memory 工具保存的记忆 TTL（ms）</td>
            </tr>
            <tr>
              <td><span className="param-name">onEvent</span></td>
              <td><span className="param-type">MemoryEventSink?</span></td>
              <td>—</td>
              <td>事件接收器</td>
            </tr>
          </tbody>
        </table>
      </div>

      <Divider />

      <div style={{ padding: 24, background: '#f0fdf4', borderRadius: 12, border: '1px solid #bbf7d0' }}>
        <h3 style={{ marginTop: 0, color: '#166534' }}>💡 典型配置速查</h3>
        <ul style={{ color: '#14532d', lineHeight: 2 }}>
          <li>零配置快速体验 → <b>createMemoryPlugin()</b>（纯 BM25 + 自动捕获/注入 + 4 个工具）</li>
          <li>语义检索增强 → 加 <b>embedder</b>（BM25 + 向量混合，零改动升级）</li>
          <li>LLM 质量摘要 → 加 <b>summarizeFn</b>（capture 走 LLM 摘要，零 token → 高质量）</li>
          <li>自动维护记忆 → 加 <b>consolidateEvery: 10</b>（每 10 次捕获自动合并去重）</li>
          <li>自定义存储 → 传入 <b>store</b>（实现 MemoryStore 接口，可接 Redis/PostgreSQL）</li>
          <li>生产监控 → 传入 <b>onEvent</b>（接收失败/合并/修剪等关键事件）</li>
        </ul>
      </div>

      <div style={{ height: 80 }} />
    </div>
  );
}
