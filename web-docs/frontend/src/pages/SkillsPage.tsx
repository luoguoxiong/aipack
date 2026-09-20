import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { Alert, Card, Row, Col, Divider, Typography } from 'antd';
import {
  TagsOutlined,
  RocketOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  ThunderboltOutlined,
  SafetyCertificateOutlined,
  BulbOutlined,
  ApiOutlined,
  CodeOutlined,
  WarningOutlined,
  CheckCircleOutlined,
} from '@ant-design/icons';
import CodeBlock from '../components/CodeBlock';
import {
  skillsQuickstartCode,
  skillsSkillMdCode,
  skillsLayoutCode,
  skillsDisclosureCode,
  skillsExplicitCode,
  skillsDiyCode,
  skillsDiagnosticsCode,
} from '../data/skillsCode';

const { Paragraph } = Typography;

const featureCards = [
  {
    icon: <BulbOutlined />,
    title: '渐进式披露',
    desc: 'system prompt 只注入 name + description 目录，全文经 skill 工具按需获取，节省 token',
  },
  {
    icon: <FileTextOutlined />,
    title: '开放规范格式',
    desc: 'SKILL.md + YAML frontmatter，与 pi / Claude Code 生态的 skill 格式互通',
  },
  {
    icon: <ThunderboltOutlined />,
    title: '运行时零 fs',
    desc: 'loader 加载时把正文读入内存，skill 工具直接返回内容，Runtime 无文件系统依赖',
  },
  {
    icon: <FolderOpenOutlined />,
    title: '多源加载',
    desc: 'user → project → extraPaths 三级来源，同名先注册者胜，冲突产出诊断不中断',
  },
  {
    icon: <ApiOutlined />,
    title: '插件式接入',
    desc: 'Extension 机制零侵入：beforeModelCall 注入目录段 + ExtensionContext.runtime 注册工具',
  },
  {
    icon: <SafetyCertificateOutlined />,
    title: '零开销兼容',
    desc: '无 skill 时不注册工具、不注入 prompt；显式触发支持 disable-model-invocation',
  },
];

const frontmatterFields = [
  { name: 'name', required: '必填*', desc: 'skill 唯一名称：^[a-z0-9]+(-[a-z0-9]+)*$，≤64 字符；缺省取目录名 / 文件名' },
  { name: 'description', required: '必填', desc: '≤1024 字符，模型据此判断是否调用（system prompt 目录唯一可见字段）' },
  { name: 'disable-model-invocation', required: '可选', desc: 'true 时不进目录、skill 工具拒绝，仅 /skill:name 显式展开' },
];

export default function SkillsPage() {
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
        <TagsOutlined style={{ color: '#6366f1' }} /> Agent Skills
      </h1>
      <p className="section-subtitle">
        <b>@aipack-ai/skills</b> 对齐 Agent Skills 开放规范（SKILL.md + YAML frontmatter），
        通过 Extension 插件机制零侵入接入 Runtime：目录先行、全文按需，让 Agent 掌握专项技能。
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
          message="零依赖零开销"
          description="无 skill 时不注册工具、不注入 prompt（行为与未安装完全一致）。加载失败只产诊断不中断，单个坏 skill 不阻塞 Runtime 启动。"
          style={{ marginBottom: 32 }}
        />
      </div>

      {/* 1. 快速开始 */}
      <div id="quickstart" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <RocketOutlined /> 1. 快速开始
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          <code>createSkillsPlugin()</code> 一站式完成文件加载与 Extension 装配，
          把 <code>plugin.extensions</code> 注入 Runtime 即可。默认加载
          <code> ~/.aipack/skills</code>（用户级）与 <code>&lt;cwd&gt;/.aipack/skills</code>（项目级）。
        </Paragraph>
        <CodeBlock code={skillsQuickstartCode} language="typescript" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 2. SKILL.md 格式 */}
      <div id="skill-md" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <FileTextOutlined /> 2. SKILL.md 格式
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          对齐 Agent Skills 开放规范：frontmatter 声明元信息，正文为模型按需加载的专项指引。
        </Paragraph>
        <CodeBlock code={skillsSkillMdCode} language="markdown" />
        <Divider orientation="left" plain>
          frontmatter 字段
        </Divider>
        <div style={{ overflowX: 'auto', marginBottom: 24 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: '#475569', borderBottom: '2px solid #e2e8f0' }}>
                <th style={{ padding: '10px 12px' }}>字段</th>
                <th style={{ padding: '10px 12px' }}>必填</th>
                <th style={{ padding: '10px 12px' }}>说明</th>
              </tr>
            </thead>
            <tbody>
              {frontmatterFields.map((f) => (
                <tr key={f.name} style={{ borderBottom: '1px solid #e2e8f0' }}>
                  <td style={{ padding: '10px 12px' }}>
                    <span className="param-name">{f.name}</span>
                  </td>
                  <td style={{ padding: '10px 12px', color: '#64748b' }}>{f.required}</td>
                  <td style={{ padding: '10px 12px', color: '#475569', lineHeight: 1.7 }}>{f.desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Paragraph style={{ fontSize: 12, color: '#94a3b8' }}>
          * name 缺省时取 skill 根目录名或 .md 文件名（省略 frontmatter 中的 name 字段即可）。
        </Paragraph>
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 3. 目录结构与发现规则 */}
      <div id="layout" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <FolderOpenOutlined /> 3. 目录结构与发现规则
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          多源加载：user（<code>~/.aipack/skills</code>）→ project（<code>&lt;cwd&gt;/.aipack/skills</code>）
          → <code>extraPaths</code>，同名先注册者胜（user 优先），败者产出 <code>collision</code> 诊断。
        </Paragraph>
        <CodeBlock code={skillsLayoutCode} language="text" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 4. 渐进式披露 */}
      <div id="disclosure" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <BulbOutlined /> 4. 渐进式披露机制
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          直接把所有 skill 全文塞进 system prompt 会浪费大量 token。skills 采用
          <b>「目录先行、全文按需」</b>两步机制，插件内部自动完成：
        </Paragraph>
        <CodeBlock code={skillsDisclosureCode} language="text" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 5. 显式触发 */}
      <div id="explicit" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <ThunderboltOutlined /> 5. 显式触发（/skill:name）
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          CLI / 聊天输入中可用 <code>/skill:name args</code> 显式展开 skill 全文；
          <code>disable-model-invocation: true</code> 的 skill 只能走此通道（纯人工触发场景）。
        </Paragraph>
        <CodeBlock code={skillsExplicitCode} language="typescript" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 6. 程序化 DIY */}
      <div id="diy" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <CodeOutlined /> 6. 程序化 DIY
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          除一站式工厂外，契约层全部导出为纯函数，可按需组合——只用工具工厂、只用目录渲染、
          或直接装配 <code>SkillsExtension</code>。
        </Paragraph>
        <CodeBlock code={skillsDiyCode} language="typescript" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 7. 诊断 */}
      <div id="diagnostics" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <WarningOutlined /> 7. 诊断与冲突处理
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          校验失败（name/description/content 不合规）、同名冲突、目录读取失败等均只产诊断不中断。
        </Paragraph>
        <CodeBlock code={skillsDiagnosticsCode} language="typescript" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 8. 安全与边界 */}
      <div id="security" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <SafetyCertificateOutlined /> 8. 安全与边界
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          <CheckCircleOutlined style={{ color: '#10b981', marginRight: 8 }} />
          skill 全文可能引导模型执行敏感操作，安全管控复用 Runtime 现有体系：skill 工具声明
          <code> permissions: []</code>（只读注册表），skill <b>内容</b>引导的工具调用由
          PermissionPolicy / ApprovalManager 在执行层统一裁决，skills 不新增权限面。
        </Paragraph>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          <CheckCircleOutlined style={{ color: '#10b981', marginRight: 8 }} />
          当前版本（v1）skill 仅承载<b>指令文本</b>，不携带可执行脚本 / 工具注册
          （frontmatter <code>tools:</code> 声明 + JS 模块加载留作 v2，需单独评审）。
        </Paragraph>
      </div>
    </div>
  );
}
