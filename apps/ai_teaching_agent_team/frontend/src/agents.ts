// apps/ai_teaching_agent_team/frontend/src/agents.ts
// 4 个教学 agent 的展示元数据(emoji / 标题 / 产出标签),供 StageProgress 与 SectionPanel 共用。
import type { AgentRole } from './api';

export interface AgentMeta {
  role: AgentRole;
  emoji: string;
  title: string;
  /** 产出标签(如"知识库") */
  label: string;
}

export const AGENTS: AgentMeta[] = [
  { role: 'professor', emoji: '🧠', title: 'Professor 教授', label: '知识库' },
  { role: 'advisor', emoji: '🗺️', title: 'Academic Advisor 学术顾问', label: '学习路线图' },
  { role: 'librarian', emoji: '📚', title: 'Research Librarian 研究馆员', label: '学习资源' },
  { role: 'ta', emoji: '✍️', title: 'Teaching Assistant 助教', label: '练习材料' },
];
