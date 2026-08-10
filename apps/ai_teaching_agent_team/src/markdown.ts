/**
 * apps/ai_teaching_agent_team/src/markdown.ts
 *
 * 零依赖 Markdown 课程文档拼装。
 * 把 4 个 agent 的产出(知识库/路线图/资源/练习)拼成一份完整课程文档:
 *   - 标题页(主题 + 生成时间 + 团队说明)
 *   - 目录
 *   - 4 个章节(各 agent 产出原文)
 *
 * 章节内容已是 Markdown(由各 agent 的 system prompt 约束),
 * 这里只负责外层结构与拼接,不解析/转换内部 Markdown。
 */

export interface CourseSections {
  knowledgeBase: string;
  roadmap: string;
  resources: string;
  practice: string;
}

interface Chapter {
  /** 章节序号 */
  num: number;
  /** 章节标题(纯文本,用于目录与标题) */
  title: string;
  /** 作者(agent 角色) */
  author: string;
  /** 章节 Markdown 正文 */
  body: string;
}

/** 生成时间戳,格式:YYYY-MM-DD HH:mm */
function nowStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 把章节正文规整:去掉首尾空白,保证以二级标题开头(若 agent 未加则补一个) */
function normalizeSection(title: string, body: string): string {
  const trimmed = body.trim();
  if (trimmed.startsWith('##')) return trimmed;
  return `## ${title}\n\n${trimmed}`;
}

/**
 * 拼装完整课程 Markdown。
 * @param topic 学习主题
 * @param sections 4 个 agent 的产出
 */
export function buildCourseMarkdown(topic: string, sections: CourseSections): string {
  const chapters: Chapter[] = [
    { num: 1, title: '知识库', author: '🧠 Professor 教授', body: sections.knowledgeBase },
    { num: 2, title: '学习路线图', author: '🗺️ Academic Advisor 学术顾问', body: sections.roadmap },
    { num: 3, title: '学习资源', author: '📚 Research Librarian 研究馆员', body: sections.resources },
    { num: 4, title: '练习材料', author: '✍️ Teaching Assistant 助教', body: sections.practice },
  ];

  const lines: string[] = [];

  // ── 标题页 ──────────────────────────────────────
  lines.push(`# ${topic}`, '');
  lines.push(`> 由 AI 教学代理团队(aipack)生成 · ${nowStamp()}`, '');
  lines.push('**教学团队:**', '');
  for (const c of chapters) {
    lines.push(`- ${c.author} — ${c.title}`);
  }
  lines.push('', '---', '');

  // ── 目录 ────────────────────────────────────────
  lines.push('## 目录', '');
  for (const c of chapters) {
    lines.push(`${c.num}. [${c.title}](#${slug(c.title)})`);
  }
  lines.push('', '---', '');

  // ── 各章节 ──────────────────────────────────────
  for (const c of chapters) {
    lines.push(normalizeSection(c.title, c.body), '');
    // 章节间分隔
    lines.push('---', '');
  }

  return lines.join('\n').trim() + '\n';
}

/** 简单 slug:用于目录锚点(Markdown 锚点规则:小写、空格转 -、去标点) */
function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}
