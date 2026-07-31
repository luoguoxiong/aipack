/**
 * code-review skill handler
 *
 * 对 git.diff 做轻量静态检查：识别明显的高危模式并生成审查报告。
 * 完整深度审查依赖 LLM 时，通过 SkillManager 的 compileSkillPrompt 走模型。
 */
import type { SkillContext, SkillResult } from '../../../src/skill/types';

// 高危模式：正则 → { severity, category, advice }
const HIGH_RISK_PATTERNS: Array<{ pattern: RegExp; severity: string; category: string; advice: string }> = [
  {
    pattern: /(password|api[_-]?key|secret|token)\s*=\s*['"][^'"]+['"]/i,
    severity: 'High',
    category: '安全性',
    advice: '敏感信息不应硬编码，建议使用环境变量或密钥管理服务',
  },
  {
    pattern: /eval\s*\(/,
    severity: 'High',
    category: '安全性',
    advice: 'eval() 存在代码注入风险，建议避免使用',
  },
  {
    pattern: /exec\s*\(|child_process/,
    severity: 'High',
    category: '安全性',
    advice: '命令执行需校验输入，防止命令注入',
  },
  {
    pattern: /innerHTML\s*=|\bhtml\s*\+=\s*['"`]/i,
    severity: 'Medium',
    category: '安全性',
    advice: '存在 XSS 风险，建议使用 textContent 或转义输出',
  },
  {
    pattern: /\.forEach\s*\([^)]*=>\s*{[^}]*await\b/i,
    severity: 'Medium',
    category: '性能',
    advice: '循环内 await 会串行执行，建议使用 Promise.all 并行化',
  },
  {
    pattern: /console\.log\s*\(/,
    severity: 'Low',
    category: '可维护性',
    advice: '调试日志建议移除或替换为结构化日志',
  },
];

export default async function execute(
  prompt: string,
  context: SkillContext,
  signal?: AbortSignal,
): Promise<SkillResult> {
  if (signal?.aborted) {
    return { content: '', tokensUsed: 0, durationMs: 0, toolsUsed: [], status: 'error', error: 'aborted' };
  }

  const diff = context.files.find((f) => f.includes('git.diff')) ?? prompt;

  const findings: string[] = [];
  const lines = diff.split('\n');

  for (let i = 0; i < lines.length; i++) {
    // 只检查新增行
    if (!lines[i].startsWith('+') || lines[i].startsWith('+++')) continue;
    const line = lines[i].slice(1);

    for (const rule of HIGH_RISK_PATTERNS) {
      if (rule.pattern.test(line)) {
        findings.push(`| ${rule.severity} | 变更文件 | +${i + 1} | ${rule.category}：\`${line.trim().slice(0, 80)}\` | ${rule.advice} |`);
        break;
      }
    }
  }

  const content = findings.length > 0
    ? `## 代码审查报告\n\n### 发现的问题\n\n| 严重程度 | 文件 | 行号 | 问题描述 | 修复建议 |\n|----------|------|------|----------|----------|\n${findings.join('\n')}`
    : '## 代码审查报告\n\n### 发现的问题\n\n未发现明显的高危模式。建议结合 LLM 进行深度语义审查。';

  return {
    content,
    tokensUsed: Math.ceil(content.length / 4),
    durationMs: 0,
    toolsUsed: [],
    status: 'success',
  };
}
