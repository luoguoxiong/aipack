/**
 * aipack 配置文件（字段均可选，可直接写 JS 逻辑）
 * 取消注释并按需修改下面的示例字段；保存后运行 "aipack chat" 生效。
 * @type {import('@aipack/cli').AipackConfigFile}
 */
export default {
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
  systemPrompt: 'kum',

  // 可选字段示例：
  // workspace: "~/my-workspace",
  sessions: {
    enabled: true,
    baseDir: './sessions',
    maxAge: 30,
  },

  // 高级：透传给 aipack Runtime 的选项（.js 配置可 import 模块/类实例）
  // tools: [],
  // extensions: [],
  // transformers: [],
  // pipeline: undefined,
  // sessionStorage: undefined,
};
