import { Card, Row, Col, Tag, List, Divider, Typography } from 'antd';
import {
  RocketOutlined,
  CodeOutlined,
  DatabaseOutlined,
  AimOutlined,
  SettingOutlined,
  ExperimentOutlined,
  CheckCircleOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { packages, PackageInfo } from '../data/packagesData';
import CodeBlock from '../components/CodeBlock';

const { Title, Paragraph } = Typography;

const tagColorMap: Record<string, string> = {
  核心框架: 'blue',
  编码工具集: 'geekblue',
  持久化记忆: 'green',
  上下文压缩: 'orange',
  命令行工具: 'purple',
  'VSCode 扩展': 'magenta',
};

function PackageCard({ pkg }: { pkg: PackageInfo }) {
  return (
    <Card
      id={pkg.id}
      className="package-card"
      style={{ marginBottom: 32 }}
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 28 }}>{pkg.icon}</span>
          <div>
            <span style={{ fontSize: 18, fontWeight: 700 }}>{pkg.name}</span>
            <Tag color={tagColorMap[pkg.tag] || 'default'} style={{ marginLeft: 12 }}>
              {pkg.tag}
            </Tag>
          </div>
        </div>
      }
      extra={
        <Tag color="default" style={{ fontSize: 12 }}>
          <ThunderboltOutlined /> npm install
        </Tag>
      }
    >
      <Paragraph style={{ fontSize: 15, lineHeight: 1.8, color: '#475569' }}>
        {pkg.description}
      </Paragraph>

      <Divider style={{ margin: '20px 0' }} />

      <Row gutter={[32, 16]}>
        <Col xs={24} md={12}>
          <div style={{ marginBottom: 12, fontWeight: 600, color: '#1e293b' }}>
            <CodeOutlined style={{ color: '#6366f1', marginRight: 6 }} />
            安装命令
          </div>
          <CodeBlock code={pkg.install} language="bash" compact />
        </Col>
        <Col xs={24} md={12}>
          <div style={{ marginBottom: 12, fontWeight: 600, color: '#1e293b' }}>
            <RocketOutlined style={{ color: '#6366f1', marginRight: 6 }} />
            关键能力
          </div>
          <List
            size="small"
            dataSource={pkg.features}
            renderItem={(item) => (
              <List.Item style={{ padding: '4px 0', border: 'none' }}>
                <CheckCircleOutlined style={{ color: '#10b981', marginRight: 8 }} />
                <span style={{ color: '#334155', lineHeight: 1.7 }}>{item}</span>
              </List.Item>
            )}
          />
        </Col>
      </Row>

      <Divider style={{ margin: '20px 0' }} />

      <div style={{ marginBottom: 12, fontWeight: 600, color: '#1e293b' }}>
        <ExperimentOutlined style={{ color: '#6366f1', marginRight: 6 }} />
        关键 API 速览
      </div>
      <Row gutter={[16, 16]}>
        {pkg.keyApis.map((api) => (
          <Col xs={24} sm={12} key={api.name}>
            <div
              style={{
                padding: '14px 16px',
                border: '1px solid #e2e8f0',
                borderRadius: 8,
                background: '#f8fafc',
              }}
            >
              <div style={{ fontWeight: 700, color: '#6366f1', marginBottom: 4 }}>
                <code style={{ background: 'transparent', padding: 0 }}>{api.name}</code>
              </div>
              <div style={{ fontSize: 13, color: '#64748b', lineHeight: 1.6 }}>{api.desc}</div>
            </div>
          </Col>
        ))}
      </Row>
    </Card>
  );
}

export default function PackagesPage() {
  return (
    <div>
      <div id="overview" style={{ marginBottom: 32 }}>
        <Title level={2} style={{ marginTop: 0 }}>
          <RocketOutlined style={{ color: '#6366f1' }} /> 包生态概览
        </Title>
        <Paragraph style={{ fontSize: 16, lineHeight: 1.8, color: '#475569' }}>
          aipack 采用「核心 + 扩展包」的模块化设计。核心包（aipack）提供 Runtime、Extension、Transformer
          三层架构；配套包按需组合，覆盖编码工具集、持久化记忆、上下文压缩、CLI、VSCode 扩展等完整场景。
        </Paragraph>

        <div
          style={{
            padding: 20,
            background: 'linear-gradient(135deg, #eef2ff, #e0e7ff)',
            borderRadius: 12,
            marginBottom: 16,
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 8, color: '#4338ca' }}>
            💡 推荐的组合方案
          </div>
          <Row gutter={[16, 12]}>
            <Col xs={24} md={8}>
              <Card size="small" style={{ border: 'none', background: 'rgba(255,255,255,0.85)' }}>
                <Tag color="blue">轻量对话</Tag>
                <div style={{ fontSize: 13, color: '#475569', marginTop: 6 }}>
                  aipack 核心即可
                </div>
              </Card>
            </Col>
            <Col xs={24} md={8}>
              <Card size="small" style={{ border: 'none', background: 'rgba(255,255,255,0.85)' }}>
                <Tag color="geekblue">编码助手</Tag>
                <div style={{ fontSize: 13, color: '#475569', marginTop: 6 }}>
                  + coding + memory
                </div>
              </Card>
            </Col>
            <Col xs={24} md={8}>
              <Card size="small" style={{ border: 'none', background: 'rgba(255,255,255,0.85)' }}>
                <Tag color="purple">完整 CLI</Tag>
                <div style={{ fontSize: 13, color: '#475569', marginTop: 6 }}>
                  + cli + coding + memory + compression
                </div>
              </Card>
            </Col>
          </Row>
        </div>
      </div>

      <PackageCard pkg={packages[0]} /> {/* aipack */}
      <PackageCard pkg={packages[1]} /> {/* aipack-coding */}
      <PackageCard pkg={packages[2]} /> {/* aipack-memory */}
      <PackageCard pkg={packages[3]} /> {/* aipack-compression */}
      <PackageCard pkg={packages[4]} /> {/* aipack-cli */}
      <PackageCard pkg={packages[5]} /> {/* vscode-aipack-coding */}
    </div>
  );
}
