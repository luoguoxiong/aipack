import { useEffect } from 'react';
import { Alert, Card, Row, Col, Tag, List, Statistic, Typography, Divider } from 'antd';
import { useLocation } from 'react-router-dom';
import {
  LineChartOutlined,
  NodeIndexOutlined,
  DashboardOutlined,
  FireOutlined,
  ApiOutlined,
  ClockCircleOutlined,
  BugOutlined,
  DatabaseOutlined,
  RocketOutlined,
  ThunderboltOutlined,
  SafetyCertificateOutlined,
  BellOutlined,
  DollarOutlined,
  CloudUploadOutlined,
  ExperimentOutlined,
  CheckCircleOutlined,
  CodeOutlined,
  WarningOutlined,
  CloudServerOutlined,
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
import {
  obsServerQuickstartCode,
  obsServerClientCode,
  obsServerLibraryCode,
  obsServerInfraCode,
  obsServerMetricsCode,
  obsServerAlertCode,
  obsServerCostCode,
  obsServerArchiveCode,
} from '../data/observabilityServerCode';

const { Title, Paragraph } = Typography;

// ====== Server 部署部分（原 ObservabilityServerPage 内容） ======
const featureList = [
  { icon: <DatabaseOutlined />, title: '双后端存储', desc: '业务库（SQLite/MySQL）+ 监控库（SQLite/ClickHouse/Dual 双写迁移）' },
  { icon: <NodeIndexOutlined />, title: '三层聚合', desc: 'Memory / Redis / Hybrid（L1 本地+L2 Redis）分布式聚合，滑动窗口+直方图' },
  { icon: <ThunderboltOutlined />, title: 'MQ 解耦', desc: 'Kafka 生产/消费解耦 ingest 与落盘，DLQ 死信队列保障不丢数据' },
  { icon: <SafetyCertificateOutlined />, title: 'RBAC 多用户', desc: 'JWT access+refresh token，HTTP-only Cookie，项目级 ACL 权限' },
  { icon: <BellOutlined />, title: '告警引擎', desc: '10+ 指标维度，版本回归检测，企业微信/Slack/飞书 webhook 通知' },
  { icon: <DollarOutlined />, title: '成本核算', desc: '模型价格 CRUD，按模型/应用分桶计费，Dashboard KPI 展示' },
  { icon: <CloudUploadOutlined />, title: '冷数据归档', desc: '91~180 天 ClickHouse → Parquet → S3，S3 Engine 透明查询' },
  { icon: <DashboardOutlined />, title: '可视化面板', desc: '内置 React 管理面板：Dashboard / Traces / Alerts / Apps 全场景' },
];

const archCards = [
  { title: '接入层 (Ingest)', desc: 'SDK 上报 → appId/appSecret 鉴权 → 令牌桶限流 → Kafka 或直接落盘', tag: '收集', color: 'blue' },
  { title: '聚合层 (Aggregator)', desc: 'ingestRun/Model/Tool 写入 → 滑动窗口 + 在线直方图 → summary/timeseries/tools 查询', tag: '聚合', color: 'cyan' },
  { title: '存储层 (Store)', desc: '业务库：users/projects/acl/agent_defs；监控库：runs/spans/tool_calls → SQLite/MySQL/CH', tag: '存储', color: 'green' },
  { title: '服务层 (API)', desc: '/metrics/* 聚合查询、/traces/* 链路回放、/api/* 业务 CRUD、/alerts 告警管理', tag: 'API', color: 'purple' },
  { title: '运营层 (Ops)', desc: '告警评估器（周期性规则匹配）、归档调度器（日级 Parquet 导出）、DLQ 监控', tag: '运营', color: 'orange' },
  { title: '面板层 (Web)', desc: 'Dashboard KPI + Trend；Traces 瀑布 + Span 列表；ErrorClass 下钻', tag: 'UI', color: 'magenta' },
];

const configMatrix = [
  { var: 'BUSINESS_STORE', default: 'sqlite', values: 'sqlite / mysql', note: '业务数据后端（用户/项目/Agent/ACL/模型价格/脱敏规则）' },
  { var: 'TRACE_STORE', default: 'sqlite', values: 'sqlite / clickhouse / dual', note: '监控数据后端（runs/spans/tool_calls），dual 为双写迁移' },
  { var: 'MQ_ENABLED', default: 'false', values: 'true / false', note: '启用 Kafka 解耦；true 时 collector 仅 produce，worker 消费落盘' },
  { var: 'AGGREGATOR', default: 'memory', values: 'memory / redis / hybrid', note: '聚合后端；hybrid = L1 本地 1min + L2 Redis 60min，生产推荐' },
  { var: 'AUTH_MODE', default: 'multi', values: 'multi / single', note: 'multi = JWT 多用户 RBAC；single = ADMIN_USER/PASS 单用户' },
  { var: 'RATE_LIMIT_BACKEND', default: 'memory', values: 'memory / redis', note: 'ingest 令牌桶；redis 支持多实例水平扩展' },
];

const alertMetrics = [
  { metric: 'successRate', label: '成功率', op: 'lt/lte', example: '< 0.95 触发' },
  { metric: 'p95Ms', label: 'P95 耗时', op: 'gt/gte', example: '> 3000ms 触发' },
  { metric: 'retryRate', label: '重试率', op: 'gt/gte', example: '> 0.15 触发' },
  { metric: 'tokensTotal', label: 'Token 消耗', op: 'gt/gte', example: '> 10M/15min 触发' },
  { metric: 'toolSuccessRate', label: '工具成功率', op: 'lt/lte', example: 'search_hotel < 0.90' },
  { metric: 'versionSuccessRate', label: '版本成功率回归', op: 'regress_by', example: '下降 > 5% 触发' },
];

function ServerSection() {
  return (
    <div>
      {/* Server 分组总览 */}
      <div id="server-overview" style={{ scrollMarginTop: 100 }}>
        {/* 特性矩阵 */}
        <Row gutter={[16, 16]} style={{ marginBottom: 32 }}>
          {featureList.map((f, i) => (
            <Col xs={24} sm={12} md={6} key={i}>
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
          description="默认 SQLite + 进程内聚合 + 同步落盘，只需 .env 即可运行。平台级部署可逐步启用 MySQL/ClickHouse/Kafka/Redis。"
          style={{ marginBottom: 32 }}
        />
      </div>

      {/* 1. 快速开始 */}
      <div id="quickstart" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title"><RocketOutlined /> 1. 快速开始</h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          支持两种使用模式：<b>独立服务</b>（读取环境变量启动，内置面板）和<b>嵌入式库</b>（import 到现有 Koa/Express 应用）。
        </Paragraph>
        <Title level={4} style={{ marginTop: 24 }}>1.1 独立服务（推荐）</Title>
        <CodeBlock code={obsServerQuickstartCode} language="bash" />
        <Title level={4} style={{ marginTop: 24 }}>1.2 客户端接入（一行注入）</Title>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          在业务应用中通过 <code>@aipack-ai/observability</code> SDK 创建实例，将 <code>telemetry</code> 注入 Runtime 即可。上报失败自动本地缓存，服务恢复后补报。
        </Paragraph>
        <CodeBlock code={obsServerClientCode} language="typescript" />
        <Title level={4} style={{ marginTop: 24 }}>1.3 作为库嵌入</Title>
        <CodeBlock code={obsServerLibraryCode} language="typescript" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 2. 架构总览 */}
      <div id="architecture" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title"><ExperimentOutlined /> 2. 架构总览</h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          observability-server 采用 6 层分层架构，各层解耦可独立替换。从 SDK 上报到最终面板展示全链路可追溯，同时支持零依赖到平台级的渐进式部署。
        </Paragraph>
        <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
          {archCards.map((card, i) => (
            <Col xs={24} md={8} key={i}>
              <Card size="small" style={{ height: '100%', borderTop: `3px solid var(--color-${card.color}-500)` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <Tag color={card.color}>{card.tag}</Tag>
                  <span style={{ fontWeight: 700 }}>{card.title}</span>
                </div>
                <div style={{ fontSize: 13, lineHeight: 1.7, color: '#475569' }}>{card.desc}</div>
              </Card>
            </Col>
          ))}
        </Row>
        <Alert type="info" showIcon icon={<WarningOutlined />} message="渐进式部署路径"
          description="开发环境：SQLite + Memory（零依赖）→ 预发：MySQL + CH + MQ（解耦）→ 生产：Hybrid Aggregator + Redis 限流 + 归档（高可用）"
          style={{ marginTop: 24 }} />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 3. 存储与聚合 */}
      <div id="storage" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title"><DatabaseOutlined /> 3. 存储与聚合</h2>
        <Title level={4} style={{ marginTop: 16 }}>3.1 存储后端选择</Title>
        <table className="params-table">
          <thead>
            <tr>
              <th style={{ width: '18%' }}>环境变量</th>
              <th style={{ width: '12%' }}>默认值</th>
              <th style={{ width: '28%' }}>可选值</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            {configMatrix.map((row, i) => (
              <tr key={i}>
                <td><span className="param-name">{row.var}</span></td>
                <td><code>{row.default}</code></td>
                <td><code>{row.values}</code></td>
                <td>{row.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <Title level={4} style={{ marginTop: 24 }}>3.2 平台级部署（推荐生产）</Title>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          生产环境启用中间件（MySQL / ClickHouse / Kafka / Redis），通过 <code>infra/docker-compose.yml</code> 一键启动。
        </Paragraph>
        <CodeBlock code={obsServerInfraCode} language="bash" />
        <Title level={4} style={{ marginTop: 24 }}>3.3 三层聚合器对比</Title>
        <Row gutter={[16, 16]}>
          <Col xs={24} md={8}>
            <Card size="small">
              <Statistic title="Memory（单实例）" value="进程内 Map" />
              <div style={{ fontSize: 12, color: '#64748b', marginTop: 10, lineHeight: 1.7 }}>
                <CheckCircleOutlined style={{ color: '#10b981' }} /> 零依赖，开发首选<br />
                <WarningOutlined style={{ color: '#f59e0b' }} /> 多实例数据独立<br />
                <WarningOutlined style={{ color: '#f59e0b' }} /> 重启后窗口清零
              </div>
            </Card>
          </Col>
          <Col xs={24} md={8}>
            <Card size="small">
              <Statistic title="Redis（多实例）" value="共享 ZSET + HASH" />
              <div style={{ fontSize: 12, color: '#64748b', marginTop: 10, lineHeight: 1.7 }}>
                <CheckCircleOutlined style={{ color: '#10b981' }} /> 多实例数据一致<br />
                <CheckCircleOutlined style={{ color: '#10b981' }} /> 重启后窗口保留<br />
                <WarningOutlined style={{ color: '#f59e0b' }} /> 查询 QPS 全部打 Redis
              </div>
            </Card>
          </Col>
          <Col xs={24} md={8}>
            <Card size="small" style={{ border: '2px solid #6366f1' }}>
              <Statistic title="Hybrid（推荐生产）" value="L1 1min + L2 60min" />
              <div style={{ fontSize: 12, color: '#64748b', marginTop: 10, lineHeight: 1.7 }}>
                <CheckCircleOutlined style={{ color: '#10b981' }} /> L1 吸收高频写入<br />
                <CheckCircleOutlined style={{ color: '#10b981' }} /> L2 跨实例共享<br />
                <CheckCircleOutlined style={{ color: '#10b981' }} /> 兼顾性能与一致性
              </div>
            </Card>
          </Col>
        </Row>
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 4. REST API */}
      <div id="api" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title"><ApiOutlined /> 4. REST API</h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          查询 API 统一以 <code>/metrics/*</code>（聚合）和 <code>/traces/*</code>（明细）暴露，所有端点支持 <code>appId</code> 维度过滤（缺省为全局聚合）。
        </Paragraph>
        <table className="params-table" style={{ marginBottom: 20 }}>
          <thead>
            <tr><th style={{ width: '40%' }}>端点</th><th>说明</th></tr>
          </thead>
          <tbody>
            <tr><td><code>GET /metrics/summary?groupBy=model|tool|session</code></td><td>聚合摘要：requests / successRate / tokens / p50/p95/p99 / retryRate / costTotal</td></tr>
            <tr><td><code>GET /metrics/timeseries?step&metric=requests|successRate|tokensTotal|cost</code></td><td>时间序列，按 stepMs 分桶（默认 5min）</td></tr>
            <tr><td><code>GET /metrics/tools</code></td><td>工具成功率排行（成功率升序，定位故障工具）</td></tr>
            <tr><td><code>GET /metrics/versions</code></td><td>跨版本指标对比（DB 直查，非内存窗口）</td></tr>
            <tr><td><code>GET /metrics/cost?groupBy=model|app</code></td><td>成本汇总（cent 单位），按模型/应用分桶</td></tr>
            <tr><td><code>GET/POST/DELETE /metrics/model-prices</code></td><td>模型价格 CRUD，生效时间支持版本切换</td></tr>
            <tr><td><code>GET /metrics/error-classes / :cls</code></td><td>错误分类 TopN + 下钻（模型/工具分布 + 最近 Traces）</td></tr>
            <tr><td><code>GET /traces?status&model&tool&page</code></td><td>运行列表分页，支持多维度筛选</td></tr>
            <tr><td><code>GET /traces/:traceId</code></td><td>Trace 明细：span 时间线 + 工具调用 + W3C parentTraceId</td></tr>
          </tbody>
        </table>
        <CodeBlock code={obsServerMetricsCode} language="typescript" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 5. 用户与权限 */}
      <div id="auth" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title"><SafetyCertificateOutlined /> 5. 用户与 RBAC</h2>
        <Row gutter={[16, 16]}>
          <Col xs={24} md={12}>
            <Card size="small" title="Single 模式（向后兼容）">
              <List size="small" dataSource={[
                '仅 ADMIN_USER / ADMIN_PASS 一组凭证',
                '内存 Session 或 HMAC-signed Cookie',
                '适合单用户 / 个人项目',
              ]} renderItem={(item) => (
                <List.Item style={{ padding: '6px 0', border: 'none' }}>
                  <CheckCircleOutlined style={{ color: '#6366f1', marginRight: 8 }} />
                  <span style={{ fontSize: 13 }}>{item}</span>
                </List.Item>
              )} />
            </Card>
          </Col>
          <Col xs={24} md={12}>
            <Card size="small" title="Multi 模式（生产推荐）" style={{ border: '2px solid #10b981' }}>
              <List size="small" dataSource={[
                'JWT access(15min) + refresh(7d)，HTTP-only Cookie',
                'users / projects / acl 表 + 注册 / 登录 / 邀请',
                '项目角色：owner / admin / member / viewer',
                'admin@aipack.local 自动创建（ADMIN_PASS 配置时）',
              ]} renderItem={(item) => (
                <List.Item style={{ padding: '6px 0', border: 'none' }}>
                  <CheckCircleOutlined style={{ color: '#10b981', marginRight: 8 }} />
                  <span style={{ fontSize: 13 }}>{item}</span>
                </List.Item>
              )} />
            </Card>
          </Col>
        </Row>
        <Alert type="info" showIcon message="自动降级逻辑"
          description="AUTH_MODE=multi 但未配置 JWT_SECRET / SESSION_SECRET / ADMIN_PASS 时，自动降级为 single 模式避免启动失败。"
          style={{ marginTop: 16 }} />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 6. 告警系统 */}
      <div id="alerts" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title"><BellOutlined /> 6. 告警系统</h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          周期性（默认 60s）评估内存聚合器指标，命中规则后通过 webhook 推送通知。支持版本回归检测（对比最近两个发布版本）。
        </Paragraph>
        <Title level={4} style={{ marginTop: 16 }}>6.1 支持的指标</Title>
        <table className="params-table">
          <thead>
            <tr>
              <th style={{ width: '28%' }}>metric</th>
              <th style={{ width: '20%' }}>含义</th>
              <th style={{ width: '18%' }}>常用运算符</th>
              <th>示例</th>
            </tr>
          </thead>
          <tbody>
            {alertMetrics.map((m, i) => (
              <tr key={i}>
                <td><span className="param-name">{m.metric}</span></td>
                <td>{m.label}</td>
                <td><code>{m.op}</code></td>
                <td>{m.example}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <Title level={4} style={{ marginTop: 24 }}>6.2 规则示例</Title>
        <CodeBlock code={obsServerAlertCode} language="typescript" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 7. 成本核算 */}
      <div id="cost" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title"><DollarOutlined /> 7. 成本核算（Phase 6）</h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          ingest-worker 在 span 落盘前自动调用 <b>CostCalculator</b>，根据 model + tokens + model_prices 计算 <code>costCents</code> 写入 span；Aggregator 同步累计到 <code>costTotal</code>，Dashboard 直接展示费用 KPI。
        </Paragraph>
        <Row gutter={[16, 16]} style={{ marginBottom: 20 }}>
          <Col xs={24} md={8}>
            <Card size="small">
              <div style={{ fontWeight: 700, marginBottom: 8 }}><CodeOutlined style={{ color: '#6366f1' }} /> 模型价格 CRUD</div>
              <div style={{ fontSize: 12, color: '#64748b', lineHeight: 1.7 }}>/metrics/model-prices 端点；支持生效时间（多版本价格切换）。</div>
            </Card>
          </Col>
          <Col xs={24} md={8}>
            <Card size="small">
              <div style={{ fontWeight: 700, marginBottom: 8 }}><ThunderboltOutlined style={{ color: '#6366f1' }} /> 实时计算</div>
              <div style={{ fontSize: 12, color: '#64748b', lineHeight: 1.7 }}>模型价格 5 分钟内存缓存；costCents = (input/1k)*inPrice + (output/1k)*outPrice。</div>
            </Card>
          </Col>
          <Col xs={24} md={8}>
            <Card size="small">
              <div style={{ fontWeight: 700, marginBottom: 8 }}><LineChartOutlined style={{ color: '#6366f1' }} /> 聚合展示</div>
              <div style={{ fontSize: 12, color: '#64748b', lineHeight: 1.7 }}>/metrics/summary 暴露 costTotal；/metrics/cost 按 model/app 分桶。</div>
            </Card>
          </Col>
        </Row>
        <CodeBlock code={obsServerCostCode} language="typescript" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 8. 冷数据归档 */}
      <div id="archive" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title"><CloudUploadOutlined /> 8. 冷数据归档（Phase 8）</h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          ArchiveScheduler 每日定时将 <b>91~180 天</b>的 ClickHouse 明细导出为<b>Parquet</b> 格式，上传到 S3 / OSS 等对象存储降低成本。<code>trace_archive</code> 表使用 S3 Engine，查询 <code>time_range &gt; 90 天</code> 时自动路由到归档表，用户无感知。
        </Paragraph>
        <Row gutter={[16, 16]} style={{ marginBottom: 20 }}>
          <Col xs={24} md={6}>
            <Card size="small" style={{ textAlign: 'center' }}>
              <Statistic title="热数据" value="0-90 天" />
              <div style={{ fontSize: 12, color: '#6366f1', marginTop: 4 }}>ClickHouse 本地</div>
            </Card>
          </Col>
          <Col xs={24} md={6}>
            <Card size="small" style={{ textAlign: 'center' }}>
              <Statistic title="冷数据" value="91-180 天" />
              <div style={{ fontSize: 12, color: '#10b981', marginTop: 4 }}>S3 Parquet + S3 Engine</div>
            </Card>
          </Col>
          <Col xs={24} md={6}>
            <Card size="small" style={{ textAlign: 'center' }}>
              <Statistic title="成本降低" value="~85%" />
              <div style={{ fontSize: 12, color: '#f59e0b', marginTop: 4 }}>CH SSD → S3 标准IA</div>
            </Card>
          </Col>
          <Col xs={24} md={6}>
            <Card size="small" style={{ textAlign: 'center' }}>
              <Statistic title="调度频率" value="每日" />
              <div style={{ fontSize: 12, color: '#8b5cf6', marginTop: 4 }}>默认凌晨 3 点执行</div>
            </Card>
          </Col>
        </Row>
        <CodeBlock code={obsServerArchiveCode} language="typescript" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 9. 数据保留与清理 */}
      <div id="retention" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title"><DatabaseOutlined /> 9. 数据保留与清理</h2>
        <table className="params-table">
          <thead>
            <tr>
              <th style={{ width: '28%' }}>变量</th>
              <th style={{ width: '14%' }}>默认</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr><td><span className="param-name">RETENTION_DAYS</span></td><td><code>30</code></td><td>明细（runs/spans/tool_calls）保留天数，&le;0 禁用</td></tr>
            <tr><td><span className="param-name">PRUNE_INTERVAL_MS</span></td><td><code>3600000</code></td><td>清理周期（默认 1 小时）</td></tr>
            <tr><td><span className="param-name">PRUNE_AT_STARTUP</span></td><td><code>true</code></td><td>启动时先执行一次清理</td></tr>
            <tr><td><span className="param-name">PRUNE_BACKUP</span></td><td><code>false</code></td><td>清理前 VACUUM INTO 快照备份</td></tr>
            <tr><td><span className="param-name">PRUNE_BACKUP_DIR</span></td><td><code>{'<DB>/backup'}</code></td><td>备份目录（仅 PRUNE_BACKUP=true 时有效）</td></tr>
          </tbody>
        </table>
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 10. 内置面板 */}
      <div id="dashboard" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title"><DashboardOutlined /> 10. 内置管理面板</h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          observability-server 构建时自动内嵌 React 面板（<code>web/</code> 子目录产物），独立服务启动后 <code>GET /</code> 直接返回界面。
        </Paragraph>
        <Row gutter={[16, 16]}>
          {[
            { t: '📊 DashboardPage', items: ['Requests / SuccessRate KPI', 'P50/P95/P99 趋势', 'Cost 费用 KPI + 折线', 'ErrorClass TopN 卡片（可下钻）'] },
            { t: '🔍 TracesPage', items: ['列表多维度筛选（status/model/tool/session）', 'ECharts 瀑布图（TraceGantt 组件）', 'Span 列表详情切换', 'W3C parentTraceId 跨系统跳转'] },
            { t: '🚨 AlertsPage', items: ['规则 CRUD（10+ 指标）', '触发历史记录', '版本回归检测配置', 'Webhook 测试按钮'] },
            { t: '💵 ModelPricesPage', items: ['模型价格 CRUD', '生效时间版本切换', '与 CostCalculator 联动', '价格变更历史'] },
            { t: '📱 AppsPage', items: ['应用（appId/appSecret）管理', '快速接入代码片段生成', '模型价格管理入口', 'PII 脱敏规则入口'] },
            { t: '🔐 Projects + Members', items: ['项目创建/切换', 'owner/admin/member/viewer 角色', '邀请成员加入', 'JWT Token 管理'] },
          ].map((c, i) => (
            <Col xs={24} sm={12} md={8} key={i}>
              <Card size="small" style={{ height: '100%' }}>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>{c.t}</div>
                <List size="small" dataSource={c.items} renderItem={(t) => (
                  <List.Item style={{ padding: '2px 0', border: 'none', fontSize: 12 }}>{t}</List.Item>
                )} />
              </Card>
            </Col>
          ))}
        </Row>
      </div>

      <div style={{ height: 80 }} />
    </div>
  );
}

// ====== SDK 埋点部分 ======
function SdkSection() {
  return (
    <div>
      {/* SDK 分组总览：事件时间线 */}
      <div id="sdk-overview" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title"><NodeIndexOutlined /> 事件时间线</h2>
        <div className="arch-container" style={{ marginTop: 16 }}>
          <div className="arch-layers">
            <div className="arch-layer">
              <div className="arch-label">run 级</div>
              <div className="arch-boxes">
                <div className="arch-box arch-box-core">
                  <ApiOutlined style={{ fontSize: 20 }} />
                  <div style={{ fontWeight: 700, marginTop: 4 }}>onRunStart</div>
                  <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4 }}>入队时刻 queuedAt，配合 onRunEnd 求排队时长</div>
                </div>
                <div className="arch-box arch-box-extension">
                  <DashboardOutlined style={{ fontSize: 20 }} />
                  <div style={{ fontWeight: 700, marginTop: 4 }}>onRunEnd</div>
                  <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4 }}>turns / tokens / queuedMs / success / errorClass</div>
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
                  <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4 }}>attempts / tokens / durationMs / stream</div>
                </div>
                <div className="arch-box arch-box-storage">
                  <BugOutlined style={{ fontSize: 20 }} />
                  <div style={{ fontWeight: 700, marginTop: 4 }}>onToolCall</div>
                  <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4 }}>status: ok / error / blocked / skipped</div>
                </div>
                <div className="arch-box arch-box-core">
                  <ClockCircleOutlined style={{ fontSize: 20 }} />
                  <div style={{ fontWeight: 700, marginTop: 4 }}>onRetry</div>
                  <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4 }}>provider 内部退避重试，per-attempt 粒度</div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <Alert type="info" showIcon message="全可选、不阻断"
          description="Telemetry 的每个回调都可选实现；上报失败不影响主流程。与 Extension 正交：Extension 面向'干预/注入'，Telemetry 面向'观测'。"
          style={{ marginBottom: 16 }} />
      </div>

      {/* 接入方式 */}
      <div id="setup" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title"><ApiOutlined /> 1. 接入方式</h2>
        <p style={{ lineHeight: 1.8, color: '#475569' }}>
          在 <code>createRuntime</code> 传入 <code>telemetry</code> 即可，无需改造业务代码。所有事件携带同一个 <code>traceId</code>，用于串联一次 run 内的模型/工具调用。
        </p>
        <CodeBlock code={obsTelemetryCode} language="typescript" />
      </div>

      {/* 事件一览 */}
      <div id="events" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title"><DashboardOutlined /> 2. 事件一览</h2>
        <table className="params-table">
          <thead>
            <tr>
              <th style={{ width: '22%' }}>事件</th>
              <th style={{ width: '18%' }}>触发时机</th>
              <th>关键字段</th>
            </tr>
          </thead>
          <tbody>
            <tr><td><span className="param-name">onRunStart</span></td><td>run()/stream() 入队</td><td>traceId / sessionKey / queuedAt</td></tr>
            <tr><td><span className="param-name">onRunEnd</span></td><td>run 完成（成功或失败均触发）</td><td>traceId / <b>turnCount</b> / durationMs / queuedMs / activeMs / success / errorClass / tokens / ttftMs</td></tr>
            <tr><td><span className="param-name">onModelCall</span></td><td>每次模型调用完成</td><td>traceId / spanId / modelId / <b>attempts</b> / inputTokens / outputTokens / cacheRead / cacheWrite / durationMs / stream / errorClass</td></tr>
            <tr><td><span className="param-name">onToolCall</span></td><td>每次工具执行完成</td><td>traceId / spanId / toolName / durationMs / <b>status</b>（ok/error/blocked/skipped）/ success / errorClass</td></tr>
            <tr><td><span className="param-name">onRetry</span></td><td>provider 内部退避重试</td><td>traceId / provider / modelId / attempt / status（HTTP）/ delayMs / errorClass</td></tr>
            <tr><td><span className="param-name">onPermissionDenied</span></td><td>权限策略拒绝工具</td><td>traceId / toolName / permissions / args / reason</td></tr>
          </tbody>
        </table>
        <Divider orientation="left">错误分类 errorClass</Divider>
        <p style={{ lineHeight: 1.8, color: '#475569' }}>
          复用 ai 层 <span className="param-type">AgentErrorCategory</span>：
          <Tag color="blue">retryable</Tag><Tag color="orange">timeout</Tag><Tag color="red">auth</Tag>
          <Tag color="purple">context-overflow</Tag><Tag color="volcano">rate-limit</Tag>
          <Tag color="cyan">invalid-request</Tag><Tag>unknown</Tag>
          <br />
          另加三类非模型错误：<Tag color="green">tool_error</Tag>
          <Tag color="geekblue">terminated</Tag><Tag color="magenta">validation</Tag>
        </p>
      </div>

      {/* Trace 设计 */}
      <div id="trace" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title"><NodeIndexOutlined /> 3. Trace 设计</h2>
        <p style={{ lineHeight: 1.8, color: '#475569' }}>
          一次 run = 一条 Trace，模型/工具调用 = Span。所有 span 共享 traceId，无需手动传递；traceId 同时写入 <code>Result.metadata.traceId</code> 与会话消息，历史会话可回放复盘。
        </p>
        <CodeBlock code={obsTraceDesignCode} language="typescript" compact />
      </div>

      {/* 指标口径 */}
      <div id="metrics" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title"><LineChartOutlined /> 4. 生产指标口径</h2>
        <p style={{ lineHeight: 1.8, color: '#475569' }}>
          所有指标都来自 telemetry 事件，可直接对账到 Dashboard 与 SLO。token 消耗量在 provider 层按 input/output/cacheRead/cacheWrite 四类还原，无需自行汇总。
        </p>
        <CodeBlock code={obsMetricsCode} language="typescript" compact />
        <Alert type="warning" showIcon message="两个口径坑"
          description={
            <span>
              ① 工具成功率只认 <b>ok</b>，blocked/skipped 不计入分母；<br />
              ② 重试次数看 <b>attempts-1</b>（attempts 含首次调用），重试耗尽场景由<b>attempts + errorClass</b> 兜底（onRetry 仅在真正重试时触发）。
            </span>
          }
          style={{ marginBottom: 16 }} />
      </div>

      {/* S2 聚合存储 */}
      <div id="s2" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title"><DatabaseOutlined /> 5. 埋点上报与后台收集（双包）</h2>
        <p style={{ lineHeight: 1.8, color: '#475569' }}>
          生产落地拆两个包：<b>@aipack-ai/observability</b>（上报 SDK，零重依赖）+
          <b> @aipack-ai/observability-server</b>（收集服务，独立部署，详见后述「Server 部署」章节）。
          客户端只需 <code>appId + appSecret</code>，6 类 telemetry 事件自动批量 POST 到收集服务；
          收集端统一完成 SQLite 落盘（runs / spans / tool_calls）+ 内存聚合（p50/p95/p99 在线直方图），
          并提供 REST 查询 API。上报失败自动写本地缓存，收集服务恢复后补报——事件路径零阻塞、失败不阻断 run()。
        </p>
        <h3 className="subsection-title" style={{ fontSize: 16, marginTop: 24 }}>客户端接入（@aipack-ai/observability）</h3>
        <CodeBlock code={obsS2SetupCode} language="typescript" />
        <h3 className="subsection-title" style={{ fontSize: 16, marginTop: 24 }}>后台收集服务（@aipack-ai/observability-server）</h3>
        <CodeBlock code={obsS2CollectorCode} language="bash" />
        <h3 className="subsection-title" style={{ fontSize: 16, marginTop: 24 }}>查询 API</h3>
        <CodeBlock code={obsS2RestApiCode} language="bash" compact />
        <Alert type="info" showIcon message="鉴权与存储可替换"
          description="上报采用 appId + appSecret 鉴权（收集端 OBS_APPS 白名单）。存储抽象为 TraceStore 接口（insert / query runs/spans/tool_calls），后续可换成 Elasticsearch 或对接 OTLP → Prometheus/Tempo，聚合器与 REST API 无需改动。指标口径与第 4 节一致，可直接对账。"
          style={{ marginTop: 16 }} />
      </div>

      <Divider />
      <div style={{ padding: 24, background: '#f0fdf4', borderRadius: 12, border: '1px solid #bbf7d0' }}>
        <h3 style={{ marginTop: 0, color: '#166534' }}>💡 与 Extension 的分工</h3>
        <ul style={{ color: '#14532d', lineHeight: 2 }}>
          <li>要"观测"（指标、Trace、token 消耗量） → <b>Telemetry</b>（本章节）+ <b>@aipack-ai/observability</b>（第 5 节：聚合 + SQLite + REST API）</li>
          <li>要"干预"（改请求/上下文、block/terminate 工具） → <b>Extension / Tool Hooks</b></li>
          <li>指标口径与 token 汇总已内置（provider 还原 input/output/cache 四类 token），无需自行实现</li>
        </ul>
      </div>
    </div>
  );
}

// ====== 主页面 ======
export default function ObservabilityPage() {
  const location = useLocation();

  // hash 变化 → 自动滚动到对应锚点（初始加载、侧边栏跳转、浏览器前进后退都覆盖）
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
    // 两次尝试：立即 + 延迟（以防 DOM 尚未渲染）
    if (!tryScroll()) {
      setTimeout(tryScroll, 50);
    }
  }, [location.hash]);

  return (
    <div>
      <h1 className="section-title">
        <LineChartOutlined style={{ color: '#6366f1' }} /> 可观测性
      </h1>
      <p className="section-subtitle">
        aipack 提供端到端的可观测性体系：<b>SDK 埋点</b>（Telemetry 轻量接口，零阻塞注入 Runtime）
        + <b>Server 收集</b>（鉴权、落盘、聚合、告警、归档、面板），
        token 消耗、成功率、耗时、重试、工具调用、Trace 回放开箱即用。
      </p>

      {/* ===== SDK 埋点：大章节头部 ===== */}
      <Divider style={{ margin: '24px 0 16px' }}>
        <span style={{ fontSize: 16, fontWeight: 800, letterSpacing: 0.5, color: '#4f46e5' }}>
          <LineChartOutlined style={{ marginRight: 8 }} /> SDK 埋点
        </span>
        <Tag color="purple" style={{ marginLeft: 8 }}>@aipack-ai/observability</Tag>
      </Divider>
      <SdkSection />

      {/* ===== Server 部署：大章节头部 ===== */}
      <Divider style={{ margin: '48px 0 16px' }}>
        <span style={{ fontSize: 16, fontWeight: 800, letterSpacing: 0.5, color: '#0e7490' }}>
          <CloudServerOutlined style={{ marginRight: 8 }} /> Server 部署
        </span>
        <Tag color="cyan" style={{ marginLeft: 8 }}>@aipack-ai/observability-server</Tag>
      </Divider>
      <ServerSection />
    </div>
  );
}
