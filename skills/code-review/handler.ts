import type { SkillContext, SkillResult } from '../../src/skill/types';

/**
 * code-review skill handler
 *
 * Phase 1: 直接返回编译后的 prompt 内容
 * Phase 2: 通过 LLM 执行代码审查
 */
export default async function execute(
  prompt: string,
  _context: SkillContext,
  _signal: AbortSignal,
): Promise<SkillResult> {
  return {
    content: prompt,
    tokensUsed: Math.ceil(prompt.length / 4),
    durationMs: 0,
    toolsUsed: [],
    status: 'success',
  };
}
