import { Alert, Tag, Divider } from 'antd';
import {
  SettingOutlined,
  CodeOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
  ExperimentOutlined,
  BoxPlotOutlined,
} from '@ant-design/icons';
import CodeBlock from '../components/CodeBlock';
import {
  extCustomToolCode,
  extCustomExtensionCode,
  extCustomTransformerCode,
  extCompactionCode,
  extToolHooksCode,
} from '../data/extendCode';

export default function ExtendPage() {
  return (
    <div>
      <h1 className="section-title">
        <SettingOutlined style={{ color: '#6366f1' }} /> 扩展指南
      </h1>
      <p className="section-subtitle">
        aipack 提供三种扩展面：<b>自定义工具</b>（能力扩展）、
        <b>Extension（生命周期钩子）</b>、<b>Transformer（上下文转换）</b>，
        以及针对工具执行的 <b>Tool Hooks</b>。组合使用可满足任意业务需求。
      </p>

      {/* 总览 */}
      <div style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <SettingOutlined /> 扩展机制总览
        </h2>
        <div className="arch-container" style={{ marginTop: 16 }}>
          <div className="arch-layers">
            <div className="arch-layer">
              <div className="arch-label">最常用</div>
              <div className="arch-boxes">
                <div className="arch-box arch-box-extension">
                  <CodeOutlined style={{ fontSize: 20 }} />
                  <div style={{ fontWeight: 700, marginTop: 4 }}>自定义 Tool</div>
                  <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4 }}>
                    为 Agent 增加新能力：查天气、操作 DB、调用内部 API…
                  </div>
                </div>
                <div className="arch-box arch-box-core">
                  <SafetyCertificateOutlined style={{ fontSize: 20 }} />
                  <div style={{ fontWeight: 700, marginTop: 4 }}>Tool Hooks</div>
                  <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4 }}>
                    before/after 拦截：block / terminate / 改写 args / 改写 result
                  </div>
                </div>
              </div>
            </div>
            <div className="arch-arrow">▼</div>
            <div className="arch-layer">
              <div className="arch-label">生命周期</div>
              <div className="arch-boxes">
                <div className="arch-box arch-box-adapter">
                  <ExperimentOutlined style={{ fontSize: 20 }} />
                  <div style={{ fontWeight: 700, marginTop: 4 }}>Extension</div>
                  <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4 }}>
                    beforeRun / beforeTransform / done / failed / ... 全局钩子
                  </div>
                </div>
                <div className="arch-box arch-box-storage">
                  <BoxPlotOutlined style={{ fontSize: 20 }} />
                  <div style={{ fontWeight: 700, marginTop: 4 }}>Transformer</div>
                  <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4 }}>
                    每次模型调用前：上下文裁剪 / 记忆注入 / 摘要 / 过滤
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Tool */}
      <div id="tool" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <CodeOutlined /> 1. 自定义工具
        </h2>
        <Alert
          type="info"
          showIcon
          message="工具是 Agent 能力扩展的一等公民"
          description="只要符合 Tool 接口即可：name + description + parameters( TypeBox JSON Schema ) + execute。模型会根据 description 与参数 Schema 自主决定何时调用。"
          style={{ marginBottom: 16 }}
        />
        <CodeBlock code={extCustomToolCode} language="typescript" />
        <Divider orientation="left">工具接口速查</Divider>
        <table className="params-table">
          <thead>
            <tr>
              <th style={{ width: '24%' }}>字段</th>
              <th style={{ width: '24%' }}>类型</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><span className="param-name">name</span><span className="param-required">必填</span></td>
              <td><span className="param-type">string</span></td>
              <td>工具名，唯一，建议 snake_case，如 get_weather、todo_manage</td>
            </tr>
            <tr>
              <td><span className="param-name">description</span><span className="param-required">必填</span></td>
              <td><span className="param-type">string</span></td>
              <td>工具用途描述，模型会读它决定何时调用，务必写清楚</td>
            </tr>
            <tr>
              <td><span className="param-name">parameters</span><span className="param-required">必填</span></td>
              <td><span className="param-type">TSchema (TypeBox)</span></td>
              <td>从 aipack/ai 导入 Type 声明，转为 JSON Schema 传给模型；additionalProperties:false 可减少幻觉参数</td>
            </tr>
            <tr>
              <td><span className="param-name">execute</span><span className="param-required">必填</span></td>
              <td><span className="param-type">(callId, args) =&gt; Promise&lt;ToolResult&gt;</span></td>
              <td>执行函数，返回 content 数组（元素形如 &#123;type:'text', text:string&#125;）；错误可在 details.error 放入</td>
            </tr>
            <tr>
              <td><span className="param-name">prepareArguments</span></td>
              <td><span className="param-type">(raw) =&gt; any</span></td>
              <td>参数预处理/校验钩子，可做默认值、类型转换；抛错会被框架捕获为工具错误结果</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Extension */}
      <div id="extension" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <ExperimentOutlined /> 2. 自定义 Extension（生命周期钩子）
        </h2>
        <p style={{ lineHeight: 1.8, color: '#475569' }}>
          Extension 基于自研的 Tapable 钩子系统。提供两种写法：
          继承 <code>BaseExtension</code>（在 setup 里集中 <code>.tapPromise</code>）
          或直接写对象字面量实现 <code>Extension</code> 接口的 apply 方法。
        </p>
        <Alert
          type="success"
          showIcon
          message="waterfall 钩子需返回值"
          description="beforeRun / beforeTransform / afterTransform / beforeToolCall / afterToolCall 都是 AsyncSeriesWaterfallHook，第一个参数会沿链传递；你的 tap 必须 return 同形状的对象（或修改后返回）。"
          style={{ marginBottom: 16 }}
        />
        <CodeBlock code={extCustomExtensionCode} language="typescript" />
        <Divider orientation="left">所有可用钩子一览</Divider>
        <table className="params-table">
          <thead>
            <tr>
              <th>钩子名</th><th>类型</th><th>参数</th><th>用途</th>
            </tr>
          </thead>
          <tbody>
            <tr><td className="param-name">beforeInitialize</td><td>AsyncSeriesHook</td><td>Request</td><td>最早：刚接收请求</td></tr>
            <tr><td className="param-name">afterInitialize</td><td>AsyncSeriesHook</td><td>Request</td><td>会话恢复后</td></tr>
            <tr><td className="param-name">beforeRun</td><td><Tag color="blue">Waterfall</Tag></td><td>Request → Request</td><td>修改请求内容（加前缀/渠道）</td></tr>
            <tr><td className="param-name">beforeTransform</td><td><Tag color="blue">Waterfall</Tag></td><td>Context → Context</td><td>转换前修改上下文</td></tr>
            <tr><td className="param-name">afterTransform</td><td><Tag color="blue">Waterfall</Tag></td><td>Context → Context</td><td>转换后再加工</td></tr>
            <tr><td className="param-name">beforeEmit / afterEmit</td><td>AsyncSeriesHook</td><td>—</td><td>每轮模型调用前后</td></tr>
            <tr><td className="param-name">beforeToolCall</td><td><Tag color="blue">Waterfall</Tag></td><td>(Decision, Context)</td><td>工具执行前：block/terminate/改 args</td></tr>
            <tr><td className="param-name">afterToolCall</td><td><Tag color="blue">Waterfall</Tag></td><td>(Decision, Context)</td><td>工具执行后：改 result/terminate</td></tr>
            <tr><td className="param-name">done</td><td>AsyncSeriesHook</td><td>Result</td><td>运行成功结束：记录用量/通知</td></tr>
            <tr><td className="param-name">failed</td><td>AsyncSeriesHook</td><td>Error, Request</td><td>运行失败：错误上报</td></tr>
          </tbody>
        </table>
      </div>

      {/* Transformer */}
      <div id="transformer" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <BoxPlotOutlined /> 3. 自定义 Transformer（上下文转换）
        </h2>
        <p style={{ lineHeight: 1.8, color: '#475569' }}>
          Transformer 在 <b>每轮模型调用前</b> 按数组顺序串行执行（上一个转换器的输出作为下一个的输入）。
          典型用途：上下文裁剪、历史摘要、记忆注入、敏感词过滤、知识库 RAG 注入…
          推荐继承 <code>BaseTransformer</code>，务必使用 <code>createDefaultTransformers()</code>
          提供的工具配对、系统消息清理等基础能力。
        </p>
        <CodeBlock code={extCustomTransformerCode} language="typescript" />
      </div>

      {/* 内置摘要压缩 */}
      <div id="compaction" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <ThunderboltOutlined /> 3.5 内置摘要压缩（长会话开箱即用）
        </h2>
        <p style={{ lineHeight: 1.8, color: '#475569' }}>
          长会话上下文膨胀不需要自己写 Transformer：<code>RuntimeOptions.compaction</code> 一行配置启用内置摘要压缩，
          token 超窗口阈值时自动把旧历史替换为一条 <code>compactionSummary</code> 消息（pinned，截断不丢）。
          摘要失败自动降级硬截断，最坏情况不差于旧行为；溢出恢复闭环同样摘要优先。
        </p>
        <CodeBlock code={extCompactionCode} language="typescript" />
      </div>

      {/* Tool Hooks */}
      <div id="hooks" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <SafetyCertificateOutlined /> 4. 工具调用钩子（Tool Hooks）
        </h2>
        <p style={{ lineHeight: 1.8, color: '#475569' }}>
          最常用的拦截场景，推荐优先用 <code>createToolHookExtension</code>（声明式工厂，已内置前置 block 后的 early-return）。
          语义：任一 tap 返回 block / terminate 即生效；waterfall 传递 decision 对象。
        </p>
        <Alert
          type="warning"
          showIcon
          message="block 与 terminate 的区别"
          description={
            <span>
              block 只会让 <b>当前工具</b> 生成 [blocked] 结果，runLoop 继续其他工具/下一轮。
              terminate 会在本轮工具调用全部结束后 <b>停止整个 run</b>，stopReason = 'terminated'。
            </span>
          }
          style={{ marginBottom: 16 }}
        />
        <CodeBlock code={extToolHooksCode} language="typescript" />
      </div>

      <Divider />
      <div style={{ padding: 24, background: '#f0fdf4', borderRadius: 12, border: '1px solid #bbf7d0' }}>
        <h3 style={{ marginTop: 0, color: '#166534' }}>💡 扩展选择速查</h3>
        <ul style={{ color: '#14532d', lineHeight: 2 }}>
          <li>想让 Agent 多一种"本事" → <b>自定义 Tool</b></li>
          <li>在每次模型调用前加工消息（加知识库/裁剪） → <b>Transformer</b></li>
          <li>长会话上下文压缩，不想写代码 → <b>内置摘要压缩</b>（compaction 一行配置）</li>
          <li>要在 run 开始/结束做指标、日志、错误上报 → <b>Extension</b></li>
          <li>要观测生产指标与 Trace（成本/成功率/耗时/重试） → <b>Telemetry</b>，见<a href="/observability" style={{ color: '#166534', fontWeight: 700 }}>可观测性</a></li>
          <li>需要审查/拦截每个工具的执行与结果（安全/审计） → <b>createToolHookExtension</b></li>
          <li>以上全部都要？当然可以组合，按数组顺序串行运行。</li>
        </ul>
      </div>
    </div>
  );
}

// 让 TS 不报未使用变量的临时定义
void ThunderboltOutlined;
