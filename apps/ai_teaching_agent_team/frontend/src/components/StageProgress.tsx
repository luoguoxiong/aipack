// apps/ai_teaching_agent_team/frontend/src/components/StageProgress.tsx
// 4 阶段进度条:教授 → 顾问 → 馆员 → 助教,三态(pending/active/done)。
import { AGENTS } from '../agents';
import type { AgentRole } from '../api';

export type StageStatus = 'pending' | 'active' | 'done';

export function StageProgress({ status }: { status: Record<AgentRole, StageStatus> }) {
  return (
    <div className="stages">
      {AGENTS.map((a) => (
        <div key={a.role} className={`stage stage--${status[a.role]}`}>
          <span className="stage__emoji">{a.emoji}</span>
          <span className="stage__label">{a.title}</span>
        </div>
      ))}
    </div>
  );
}
