/**
 * apps/ai_teaching_agent_team/src/runtime.ts
 *
 * 4-Agent 教学团队设计(顺序接力流水线,全部流式):
 *   - Professor(教授):用 search_web 检索主题资料,从第一性原理构建详尽知识库
 *   - Academic Advisor(学术顾问):基于知识库设计结构化学习路线图(无工具,纯综合)
 *   - Research Librarian(研究馆员):用 search_web 策展高质量学习资源
 *   - Teaching Assistant(助教):用 search_web 基于知识库+路线图设计练习材料
 *
 * aipack 是单 Runtime 框架,故用四个独立 Runtime 实例 + 顺序链式编排。
 * 每个 Runtime 都用 stream() 流式输出,通过 onProgress 回调把增量推给 SSE。
 *
 * 与 ai_travel_agent 双 Agent 的关键差异:4 个 agent 全部流式(非仅最后一个),
 * 且后两个 agent 基于前面 agent 的产出展开(真正团队接力)。
 */
import {
  createRuntime,
  createRequest,
  createFileSessionStorage,
  type Model,
  type StreamFn,
  type Runtime,
} from '@aipack/agent';
import { createSearchTool } from './tools/search.js';
import { buildModel } from './config.js';
import { buildCourseMarkdown } from './markdown.js';
import { createHash } from 'node:crypto';

// ─── 系统提示词 ─────────────────────────────────────────────────

const PROFESSOR_SYSTEM_PROMPT = `你是一位世界级教授与知识研究专家。给定一个学习主题,你的任务是构建一份详尽、准确、结构清晰的知识库。

要求:
- 从第一性原理出发讲解,让初学者也能建立正确的心智模型
- 覆盖核心概念、关键术语(附简明定义)、基本原理、典型应用与当前发展
- 主动调用 search_web 工具检索该主题的权威资料(官方文档、论文、经典教材),确保事实准确
- 用清晰的结构化 Markdown 输出:用二级/三级标题分节,关键术语加粗,适当使用列表
- 不要编造事实,不确定时明确标注;聚焦清晰度、准确性与深度
- 用中文输出`;

const ADVISOR_SYSTEM_PROMPT = `你是一位资深学术顾问。给定一个学习主题与一份知识库,你的任务是设计一份结构化、可执行的学习路线图。

路线图要求:
- 把主题拆解为按学习顺序递进的子主题/模块(从基础到进阶)
- 每个模块标注:学习目标、预估时间、前置知识、关键知识点
- 提供清晰的里程碑标记,让学习者知道每阶段的产出与检验标准
- 用结构化 Markdown 输出(有序列表或表格均可),用 ## 模块 N 作为分节
- 基于给定的知识库内容设计,不要脱离知识库凭空添加无关主题
- 用中文输出`;

const LIBRARIAN_SYSTEM_PROMPT = `你是一位资深学习资源研究馆员。给定一个学习主题与一份知识库,你的任务是策展一份高质量的学习资源清单。

要求:
- 主动调用 search_web 工具检索真实存在的优质资源(技术博客、GitHub 仓库、官方文档、视频教程、在线课程、论文)
- 每条资源标注:名称、类型、简短描述、难度(入门/进阶/高级)、链接(若已知)
- 按资源类型或学习阶段分类组织,用结构化 Markdown 输出(列表 + 分节标题)
- 只推荐你认为真实存在且高质量的资源,不要编造链接;若不确定具体链接,给出资源名称与检索建议
- 资源数量适中(10-20 条),重质不重量
- 用中文输出`;

const TA_SYSTEM_PROMPT = `你是一位资深助教与练习设计专家。给定一个学习主题、知识库与学习路线图,你的任务是设计一套完整的练习材料。

练习材料要求:
- 覆盖渐进式练习:基础概念题 → 应用题 → 进阶挑战 → 动手项目 → 真实场景应用
- 包含选择题/简答题/编程题/项目题等多种形式
- 主动调用 search_web 工具查找该主题的真实示例问题与应用场景
- 所有题目附详细解答与解析(放在"参考答案"小节)
- 练习难度与路线图的模块递进对齐
- 用结构化 Markdown 输出,用 ## 练习 N 作为分节,题目用加粗,答案用引用块或折叠
- 用中文输出`;

// ─── 类型 ───────────────────────────────────────────────────────

export type AgentRole = 'professor' | 'advisor' | 'librarian' | 'ta';

export interface CourseInput {
  topic: string;
  /** 模型标识 `${provider}/${modelId}`,编入 sessionKey 以隔离不同模型的会话历史 */
  modelKey?: string;
}

export interface CourseProgress {
  /** 阶段事件 */
  type:
    | 'professor_start' | 'professor_done'
    | 'advisor_start' | 'advisor_done'
    | 'librarian_start' | 'librarian_done'
    | 'ta_start' | 'ta_done'
    | 'delta'
    | 'done'
    | 'error';
  /** delta 时的 agent 标识 */
  agent?: AgentRole;
  /** delta 时的增量文本 */
  delta?: string;
  /** *_done 时的该章节完整内容 */
  section?: string;
  /** done 时的完整课程 Markdown */
  course?: string;
  /** error 时的错误信息 */
  message?: string;
}

// agent → start/done 阶段名映射(保证字面量类型正确)
const STAGE_START: Record<AgentRole, CourseProgress['type']> = {
  professor: 'professor_start',
  advisor: 'advisor_start',
  librarian: 'librarian_start',
  ta: 'ta_start',
};
const STAGE_DONE: Record<AgentRole, CourseProgress['type']> = {
  professor: 'professor_done',
  advisor: 'advisor_done',
  librarian: 'librarian_done',
  ta: 'ta_done',
};

// ─── Runtime 工厂 ───────────────────────────────────────────────

const SESSION_BASE_DIR = '.aipack/teaching-sessions';
const SESSION_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 天

/** 构建 Professor Runtime:带搜索工具 */
export function createProfessorRuntime(model: Model, streamFn: StreamFn, serpapiKey?: string): Runtime {
  return createRuntime({
    model,
    streamFn,
    systemPrompt: PROFESSOR_SYSTEM_PROMPT,
    tools: [createSearchTool(serpapiKey)],
    sessionStorage: createFileSessionStorage({ baseDir: SESSION_BASE_DIR, maxAge: SESSION_MAX_AGE }),
    maxTurns: 20, // 允许多轮搜索
    config: { role: 'professor' },
  });
}

/** 构建 Academic Advisor Runtime:纯综合,无工具 */
export function createAdvisorRuntime(model: Model, streamFn: StreamFn): Runtime {
  return createRuntime({
    model,
    streamFn,
    systemPrompt: ADVISOR_SYSTEM_PROMPT,
    tools: [],
    sessionStorage: createFileSessionStorage({ baseDir: SESSION_BASE_DIR, maxAge: SESSION_MAX_AGE }),
    maxTurns: 8,
    config: { role: 'advisor' },
  });
}

/** 构建 Research Librarian Runtime:带搜索工具 */
export function createLibrarianRuntime(model: Model, streamFn: StreamFn, serpapiKey?: string): Runtime {
  return createRuntime({
    model,
    streamFn,
    systemPrompt: LIBRARIAN_SYSTEM_PROMPT,
    tools: [createSearchTool(serpapiKey)],
    sessionStorage: createFileSessionStorage({ baseDir: SESSION_BASE_DIR, maxAge: SESSION_MAX_AGE }),
    maxTurns: 20,
    config: { role: 'librarian' },
  });
}

/** 构建 Teaching Assistant Runtime:带搜索工具 */
export function createTeachingAssistantRuntime(model: Model, streamFn: StreamFn, serpapiKey?: string): Runtime {
  return createRuntime({
    model,
    streamFn,
    systemPrompt: TA_SYSTEM_PROMPT,
    tools: [createSearchTool(serpapiKey)],
    sessionStorage: createFileSessionStorage({ baseDir: SESSION_BASE_DIR, maxAge: SESSION_MAX_AGE }),
    maxTurns: 20,
    config: { role: 'ta' },
  });
}

// ─── 单 Agent 流式执行 ──────────────────────────────────────────

/**
 * 运行单个 agent:流式输出,把 text 增量映射为 delta 进度事件。
 * 工具调用(tool_start/tool_end)静默处理(前端通过 stage 事件感知进度)。
 */
async function runAgent(
  agent: AgentRole,
  runtime: Runtime,
  prompt: string,
  sessionKey: string,
  onProgress: (p: CourseProgress) => void,
  signal?: AbortSignal,
): Promise<string> {
  onProgress({ type: STAGE_START[agent] });
  const req = createRequest(prompt, { sessionKey });

  let text = '';
  for await (const chunk of runtime.stream(req)) {
    if (signal?.aborted) throw new Error('aborted');
    if (chunk.type === 'text' && chunk.content) {
      text += chunk.content;
      onProgress({ type: 'delta', agent, delta: chunk.content });
    } else if (chunk.type === 'error') {
      throw new Error(chunk.content || `${agent} 执行出错`);
    }
    // tool_start/tool_end/thinking/done:静默(不影响流式文本)
  }

  if (!text.trim()) throw new Error(`${agent} 未生成内容`);
  onProgress({ type: STAGE_DONE[agent], section: text });
  return text;
}

// ─── 顺序流式编排 ───────────────────────────────────────────────

/**
 * 编排 4 阶段流水线:Professor → Advisor → Librarian → TA,全部流式。
 *
 * @param input 学习主题
 * @param team 已构建的 4-Runtime 团队
 * @param onProgress 流式进度回调(用于 SSE 推送)
 * @param signal 可选 AbortSignal,用于客户端断开时中止
 */
export async function generateCourse(
  input: CourseInput,
  team: RuntimeTeam,
  onProgress: (p: CourseProgress) => void,
  signal?: AbortSignal,
): Promise<{ knowledgeBase: string; roadmap: string; resources: string; practice: string; course: string }> {
  const topic = input.topic.trim();
  // 把模型标识编入 sessionKey,隔离不同模型的会话历史(/ 转为 - 避免路径分隔符)
  const modelTag = input.modelKey ? `:${input.modelKey.replace(/[^a-z0-9._-]+/gi, '-')}` : '';
  const tag = slug(topic) + modelTag;

  // ── 阶段 1:Professor 构建知识库 ───────────────────────────────
  const knowledgeBase = await runAgent(
    'professor',
    team.professor,
    `学习主题:${topic}\n\n请构建该主题的详尽知识库。先调用 search_web 检索 1-3 个权威资料来源,再综合撰写结构化 Markdown 知识库。`,
    `professor:${tag}`,
    onProgress,
    signal,
  );
  if (signal?.aborted) throw new Error('aborted');

  // ── 阶段 2:Academic Advisor 设计路线图(基于知识库)─────────────
  const roadmap = await runAgent(
    'advisor',
    team.advisor,
    [
      `学习主题:${topic}`,
      '',
      '知识库:',
      knowledgeBase,
      '',
      '请基于以上知识库设计一份结构化学习路线图(分模块递进,标注目标/时间/前置知识)。',
    ].join('\n'),
    `advisor:${tag}`,
    onProgress,
    signal,
  );
  if (signal?.aborted) throw new Error('aborted');

  // ── 阶段 3:Research Librarian 策展资源(基于知识库)─────────────
  const resources = await runAgent(
    'librarian',
    team.librarian,
    [
      `学习主题:${topic}`,
      '',
      '知识库:',
      knowledgeBase,
      '',
      '请策展该主题的高质量学习资源。调用 search_web 检索真实资源,按类型/阶段分类,附描述与难度。',
    ].join('\n'),
    `librarian:${tag}`,
    onProgress,
    signal,
  );
  if (signal?.aborted) throw new Error('aborted');

  // ── 阶段 4:Teaching Assistant 设计练习(基于知识库+路线图)──────
  const practice = await runAgent(
    'ta',
    team.ta,
    [
      `学习主题:${topic}`,
      '',
      '知识库:',
      knowledgeBase,
      '',
      '学习路线图:',
      roadmap,
      '',
      '请基于以上知识库与路线图设计练习材料(渐进式,附详细解答)。可调用 search_web 查找真实示例问题与应用场景。',
    ].join('\n'),
    `ta:${tag}`,
    onProgress,
    signal,
  );

  // ── 拼装完整课程 Markdown ──────────────────────────────────────
  const course = buildCourseMarkdown(topic, {
    knowledgeBase,
    roadmap,
    resources,
    practice,
  });
  onProgress({ type: 'done', course });

  return { knowledgeBase, roadmap, resources, practice, course };
}

/** 把主题转为 session key 友好的 slug */
function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'default'
  );
}

// ─── Runtime 注册表:按 (provider, modelId) 缓存 4-Runtime 团队 ────

export interface RuntimeTeam {
  professor: Runtime;
  advisor: Runtime;
  librarian: Runtime;
  ta: Runtime;
}

export interface RuntimeRegistry {
  /** 取(或首次构建并缓存)指定模型的 4-Runtime 团队。apiKey 为用户提供的 key(不传则用 env)。模型不存在时抛错。 */
  get(provider: string, modelId: string, apiKey?: string): RuntimeTeam;
  /** 关闭所有缓存的 Runtime(优雅退出时调用) */
  closeAll(): Promise<void>;
}

/**
 * 创建 Runtime 注册表。模型在首次被选中时按需构建并缓存,
 * 避免每次请求重建,同时支持运行时切换模型。
 */
export function createRuntimeRegistry(serpapiKey?: string): RuntimeRegistry {
  const cache = new Map<string, RuntimeTeam>();
  return {
    get(provider, modelId, apiKey) {
      // 用 key 的哈希区分缓存(不明文存 key);env key 用 'env'
      const keyTag = apiKey ? `u:${createHash('sha256').update(apiKey).digest('hex').slice(0, 8)}` : 'env';
      const cacheKey = `${provider}/${modelId}:${keyTag}`;
      let team = cache.get(cacheKey);
      if (!team) {
        const { model, streamFn } = buildModel(provider, modelId, apiKey);
        team = {
          professor: createProfessorRuntime(model, streamFn, serpapiKey),
          advisor: createAdvisorRuntime(model, streamFn),
          librarian: createLibrarianRuntime(model, streamFn, serpapiKey),
          ta: createTeachingAssistantRuntime(model, streamFn, serpapiKey),
        };
        cache.set(cacheKey, team);
      }
      return team;
    },
    async closeAll() {
      await Promise.allSettled(
        [...cache.values()].map((t) =>
          Promise.all([t.professor.close(), t.advisor.close(), t.librarian.close(), t.ta.close()]),
        ),
      );
      cache.clear();
    },
  };
}
