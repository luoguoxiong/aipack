// apps/ai_teaching_agent_team/frontend/src/components/SectionPanel.tsx
// 单个 agent 的流式输出面板:标题 + 状态 + <pre> 逐字渲染。复用 ×4。
import { useEffect, useRef } from 'react';
import type { AgentRole } from '../api';
import type { StageStatus } from './StageProgress';

interface SectionPanelProps {
  agent: AgentRole;
  emoji: string;
  title: string;
  status: StageStatus;
  content: string;
}

export function SectionPanel({ agent, emoji, title, status, content }: SectionPanelProps) {
  const bodyRef = useRef<HTMLPreElement>(null);

  // 生成中自动滚动到底部(仅 active 态)
  useEffect(() => {
    if (status === 'active' && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [content, status]);

  return (
    <section className={`card section-card section-card--${status}`} data-agent={agent}>
      <div className="section-head">
        <span className="section-emoji">{emoji}</span>
        <h2 className="section-title">{title}</h2>
        <span className={`section-status section-status--${status}`}>
          {status === 'done' ? '✓ 完成' : status === 'active' ? '生成中…' : '待开始'}
        </span>
      </div>
      {content ? (
        <pre ref={bodyRef} className="section-body">
          {content}
        </pre>
      ) : (
        <p className="section-placeholder">
          {status === 'pending' ? '等待上一位教师完成…' : '准备中…'}
        </p>
      )}
    </section>
  );
}
