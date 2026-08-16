import { Tabs, Alert } from 'antd';
import {
  CodeOutlined,
  DatabaseOutlined,
  AimOutlined,
  SettingOutlined,
  RocketOutlined,
} from '@ant-design/icons';
import CodeBlock from '../components/CodeBlock';
import {
  exMinimalCode,
  exMemoryCode,
  exCompressionCode,
  exCliConfigCode,
} from '../data/examplesCode';

export default function ExamplesPage() {
  return (
    <div>
      <h1 className="section-title">
        <CodeOutlined style={{ color: '#6366f1' }} /> 示例代码
      </h1>
      <p className="section-subtitle">
        精选 4 个最常用的场景示例：最小应用、记忆集成、上下文压缩、CLI 配置文件。
        直接复制即可运行（仅需配置 <code>{'<PROVIDER>_API_KEY'}</code> 环境变量）。
      </p>

      <Alert
        type="info"
        showIcon
        message="安装示例依赖"
        description={
          <span>
            除 <code>aipack</code> 核心外：
            memory 示例需 <code>pnpm add aipack-memory</code>，
            compression 示例需 <code>pnpm add aipack-compression</code>，
            CLI 需 <code>pnpm add -g aipack-cli</code>。
          </span>
        }
        style={{ marginBottom: 24 }}
      />

      <Tabs
        className="custom-tabs"
        size="large"
        defaultActiveKey="1"
        items={[
          {
            key: '1',
            label: <span><RocketOutlined /> 最小应用</span>,
            children: (
              <div>
                <h2 className="subsection-title" id="minimal" style={{ marginTop: 0 }}>
                  <RocketOutlined /> 最小可用应用
                </h2>
                <p style={{ lineHeight: 1.8, color: '#475569' }}>
                  推荐的项目脚手架结构：把 runtime 封装到模块中，其他业务模块直接 import 使用。
                  配置同步 + 流式两种调用入口，进程退出前优雅关闭。
                </p>
                <CodeBlock code={exMinimalCode} />
              </div>
            ),
          },
          {
            key: '2',
            label: <span><DatabaseOutlined /> 记忆集成</span>,
            children: (
              <div>
                <h2 className="subsection-title" id="memory" style={{ marginTop: 0 }}>
                  <DatabaseOutlined /> 长期记忆（跨会话记住用户）
                </h2>
                <p style={{ lineHeight: 1.8, color: '#475569' }}>
                  aipack-memory 提供完整的"记住用户"闭环：<b>捕获 → 索引 → 注入 → 合并</b>。
                  默认 BM25 关键词检索（零依赖，支持中文）；配上 Embedder 自动升级为 BM25 + 向量双路召回。
                </p>
                <CodeBlock code={exMemoryCode} />
              </div>
            ),
          },
          {
            key: '3',
            label: <span><AimOutlined /> 上下文压缩</span>,
            children: (
              <div>
                <h2 className="subsection-title" id="compression" style={{ marginTop: 0 }}>
                  <AimOutlined /> 五级上下文压缩（长对话防炸 Token）
                </h2>
                <p style={{ lineHeight: 1.8, color: '#475569' }}>
                  在长对话 / 大工具输出的场景下，Token 很容易超出模型窗口。
                  compression 包提供 5 层渐进式压缩策略，对调用方透明。
                  动态 import 方式确保不使用时不会被打包。
                </p>
                <CodeBlock code={exCompressionCode} />
              </div>
            ),
          },
          {
            key: '4',
            label: <span><SettingOutlined /> CLI 配置</span>,
            children: (
              <div>
                <h2 className="subsection-title" id="cli" style={{ marginTop: 0 }}>
                  <SettingOutlined /> aipack.config.js（CLI 配置）
                </h2>
                <p style={{ lineHeight: 1.8, color: '#475569' }}>
                  用 aipack-cli 而非写代码时，通过 <code>aipack.config.js</code>
                  即可组合 memory 记忆、自定义扩展/工具。
                  配置优先级：默认值 &lt; 配置文件 &lt; 环境变量 &lt; CLI 选项。
                </p>
                <CodeBlock code={exCliConfigCode} />
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}
