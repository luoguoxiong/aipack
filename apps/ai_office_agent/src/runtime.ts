/**
 * apps/ai_office_agent/src/runtime.ts
 *
 * Office 智能体 Runtime 装配 + 流式编排。
 *
 * 单 Agent 设计:一个 Runtime 挂载通用 Office 工具(office_read / office_exec
 * + 文件工具)。不写死任何文档模板——LLM 识别用户意图,生成 officecli 参数
 * (读取用 view,增删改用 batch commands)交给工具执行。
 * 通过 ResultChunk.type 区分阶段:text → 回答增量;tool_start/tool_end → 工具执行。
 */
import path from 'node:path';
import {
  createRuntime,
  createRequest,
  createFileSessionStorage,
  type Model,
  type StreamFn,
  type Runtime,
} from '@aipack/agent';
import { createOfficeTools } from './tools/office-tools.js';
import { createFileTools } from './tools/file-tools.js';
import { createWorkspace, type Workspace } from './tools/workspace.js';

const OFFICE_SYSTEM_PROMPT = `你是 Office 文档智能助手,可以读取、创建、修改、删除 Excel/Word/PPT 文件。
所有 Office 操作都通过 OfficeCLI 完成,你负责识别用户意图并把意图翻译为 officecli 参数:
- 读取/查看/分析文档 → office_read(officecli view)
- 创建/修改/删除文档内容 → office_exec(officecli batch commands,add/set/remove 元素)

可用工具:
- office_read:读取任意 Office 文档内容(xlsx → 单元格文本;docx/pptx → 结构大纲)
- office_help:查询 OfficeCLI 能力参考(某格式的元素清单 / 某元素的完整属性语法),生成命令前不确定语法时先查
- office_exec:执行 officecli batch 命令,实现创建/修改/删除(命令结构见工具描述)
- file_list:工作区文件列表
- file_delete:删除文件(移入 .trash 回收站)

操作规则:
1. 所有文件路径一律使用「相对工作区的相对路径」,如 "output/report.xlsx",禁止使用绝对路径。
2. 修改现有文件前,必须先用 office_read 读原文,确定元素路径(add 用 parent 如 '/slide[1]'、'/body';set/remove 用 path 如 '/slide[2]'、'/Sheet1/A1')再生成命令。
3. 生成 office_exec 的 commands 时,不确定某元素的路径/属性名/属性值时,先调用 office_help 查询(如 office_help format='xlsx' topic='autofilter'、topic='cell'、topic='sort'),不要凭记忆编造属性名。
4. 新建文件:office_exec 中 create=true 或直接对不存在的路径执行命令(工具会自动创建空文档)。
   - pptx:先 add slide(可带 background 渐变如 "0F172A-7C3AED")再向 slide 添加 shape/chart/table;
   - docx:add paragraph / markdown / table;标题如需样式先 add style(Heading1-6);
   - xlsx:add sheet(name)后逐格 add cell(ref='A1', value=...);修改或设置样式(字体颜色 font.color、背景填充 fill、加粗 font.bold、对齐 halign 等)用 set cell,path 指向单元格或范围(如 '/Sheet1/A1:K1');表头筛选/排序下拉用 add autofilter(range='A1:K300'),按列排序用 set sheet(sort='B desc', sortHeader='true')。
5. 修改策略:
   - Excel:用 set cell / add row / remove 做精准修改;
   - Word/PPT:全量重建或 remove 后重新 add,保证内容完整。
6. 生成 PPT 时请产出高质量结构化大纲:
   - 内容精炼,每页 3-6 条短句要点,避免大段文字;
   - 有数据对比/趋势时,用 chart 元素(chartType=column/line/pie,提供 categories 与 data)生成图表;
   - 可组织"封面→痛点→方案→数据→落地→总结"等结构,每页 shape 用英寸坐标布局。
7. 生成 Word 时使用规范的段落结构(标题/列表/表格/加粗),避免通篇平铺文本。
8. 生成或修改文档后,建议调用 office_read 自查结构是否完整。
9. 删除任何文件前,必须先向用户复述目标文件路径并征得用户确认。
10. 新建文件前,可先向用户确认结构与内容要点;直接执行亦可。
11. 完成后,在回答中说明生成/修改的文件路径与内容概要,方便用户核对。
12. 回答使用中文。`;

export interface OfficeEvent {
  type: 'text' | 'tool_start' | 'tool_end' | 'thinking' | 'done' | 'error';
  content?: string;
  toolName?: string;
  isError?: boolean;
}

export interface OfficeInput {
  message: string;
  /** 会话标识(默认 'default';多用户可各自传入) */
  sessionKey?: string;
  /**
   * 用户选中的目标文件(相对工作区路径,如 "output/sales.xlsx")。
   * 注入到请求上下文中:用户的修改请求默认针对该文件,除非用户明确指定其他文件。
   */
  filePath?: string;
}

/**
 * 构建 Office 智能体 Runtime。
 * @param workspaceRoot 文件工作区绝对路径(工具读写都限制在此目录内)
 */
export async function createOfficeRuntime(
  model: Model,
  streamFn: StreamFn,
  workspaceRoot: string,
): Promise<Runtime> {
  const ws: Workspace = await createWorkspace(workspaceRoot);
  const tools = [...createOfficeTools(ws), ...createFileTools(ws)];
  return createRuntime({
    model,
    streamFn,
    systemPrompt: OFFICE_SYSTEM_PROMPT,
    tools,
    sessionStorage: createFileSessionStorage({
      baseDir: path.join(workspaceRoot, '.aipack', 'sessions'),
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 天
    }),
    maxTurns: 15, // 读→改→写等链路需要较多轮次
    config: { role: 'office-assistant', workspace: workspaceRoot, toolCount: tools.length },
  });
}

/**
 * 流式执行一次 Office 任务,把底层 chunk 归一化为 OfficeEvent 回调。
 * 错误(含 aborted)以异常抛出,由调用方转 SSE error。
 */
export async function runOfficeAgent(
  input: OfficeInput,
  runtime: Runtime,
  onEvent: (e: OfficeEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  // 选中文件时,把目标文件上下文注入消息头部,引导 Agent 先读该文件再修改
  let message = input.message;
  if (input.filePath) {
    message =
      `【当前选中文件】工作区相对路径: ${input.filePath}\n` +
      `用户的修改请求默认针对该文件。除非用户明确指定其他文件,否则请先读取该文件,再按用户要求修改。\n` +
      `---\n${message}`;
  }
  const req = createRequest(message, { sessionKey: input.sessionKey ?? 'default' });

  for await (const chunk of runtime.stream(req)) {
    if (signal?.aborted) throw new Error('aborted');

    switch (chunk.type) {
      case 'text':
        if (chunk.content) onEvent({ type: 'text', content: chunk.content });
        break;
      case 'thinking':
        if (chunk.content) onEvent({ type: 'thinking', content: chunk.content });
        break;
      case 'tool_start':
        onEvent({ type: 'tool_start', toolName: chunk.toolName });
        break;
      case 'tool_end':
        onEvent({ type: 'tool_end', toolName: chunk.toolName, isError: chunk.isError });
        break;
      case 'error':
        throw new Error(chunk.content || '运行出错');
      // 'done' 由循环自然结束处理
    }
  }

  onEvent({ type: 'done' });
}
