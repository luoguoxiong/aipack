/**
 * 工具摘要器 - 将原始工具输出转换为结构化摘要
 *
 * 功能：
 * - 针对不同类型的工具输出（shell、read、write、search 等）
 *   生成对应的结构化摘要
 * - 提取关键信息：状态、变更文件、错误、重要行
 * - 大幅减少工具输出占用的 token，同时保留核心信息
 *
 * 设计原则：
 * - 小输出不摘要（< 300 tokens）
 * - 不同工具类型有专门的摘要规则
 * - 始终保留错误信息
 */

import type { ToolDigest, ToolDigestConfig } from '../types';

/**
 * 工具摘要器类
 * 负责将工具的原始输出转换为简洁的结构化摘要
 */
export class ToolDigestor {
  private config: ToolDigestConfig;  // 摘要配置
  // 摘要规则映射：工具名模式 → 摘要函数
  private digestRules = new Map<string, (output: string, isError: boolean) => Partial<ToolDigest>>();

  constructor(config: ToolDigestConfig) {
    this.config = config;
    this.registerDefaultRules();
  }

  /**
   * 生成工具结果的摘要
   *
   * @param toolName 工具名
   * @param output 原始输出
   * @param isError 是否是错误输出
   * @returns 结构化的工具摘要
   */
  digest(
    toolName: string,
    output: string,
    isError: boolean = false,
  ): ToolDigest {
    const originalLength = output.length;
    const originalTokens = Math.ceil(originalLength / 4);

    // 如果输出已经足够小，不做摘要，直接返回
    if (originalTokens < 300) {
      return {
        tool: toolName,
        status: isError ? 'failed' : 'success',
        summary: output.slice(0, 200),
        filesChanged: [],
        errors: isError ? [output.slice(0, 300)] : [],
        importantLines: [],
        outputHash: this.hash(output),
        originalLength,
        digestLength: output.length,
      };
    }

    // 查找匹配的摘要规则
    let digest: Partial<ToolDigest> | null = null;
    
    // 按工具名匹配规则
    for (const [pattern, rule] of this.digestRules) {
      if (toolName.includes(pattern) || toolName.toLowerCase().includes(pattern.toLowerCase())) {
        digest = rule(output, isError);
        break;
      }
    }

    // 没有匹配的规则时，使用通用摘要
    if (!digest) {
      digest = this.genericDigest(output, isError);
    }

    // 提取重要行（使用默认规则）
    const importantLines = this.extractImportantLines(output);
    if (!digest.importantLines) {
      digest.importantLines = importantLines.slice(0, 10);
    }

    // 确保错误信息被捕获
    if (isError && (!digest.errors || digest.errors.length === 0)) {
      digest.errors = [output.slice(0, 300)];
    }

    const summary = digest.summary || '';
    const result: ToolDigest = {
      tool: toolName,
      status: isError ? 'failed' : 'success',
      summary,
      filesChanged: digest.filesChanged || [],
      errors: digest.errors || [],
      importantLines: digest.importantLines || importantLines.slice(0, 10),
      outputHash: this.hash(output),
      originalLength,
      digestLength: summary.length + (digest.errors?.join('\n').length || 0) + (digest.importantLines?.join('\n').length || 0),
    };

    return result;
  }

  /**
   * 检查工具结果是否需要摘要
   * 只有超过 300 tokens 的输出才需要摘要
   */
  needsDigest(output: string): boolean {
    return Math.ceil(output.length / 4) > 300;
  }

  /**
   * 注册默认的摘要规则
   * 覆盖常见的工具类型
   */
  private registerDefaultRules(): void {
    // Shell / 测试命令
    this.digestRules.set('shell', (output, isError) => this.digestShell(output, isError));
    this.digestRules.set('exec', (output, isError) => this.digestShell(output, isError));
    this.digestRules.set('run', (output, isError) => this.digestShell(output, isError));
    this.digestRules.set('test', (output, isError) => this.digestShell(output, isError));
    this.digestRules.set('npm', (output, isError) => this.digestShell(output, isError));
    this.digestRules.set('yarn', (output, isError) => this.digestShell(output, isError));
    this.digestRules.set('pnpm', (output, isError) => this.digestShell(output, isError));

    // 文件读取
    this.digestRules.set('read', (output, isError) => this.digestReadFile(output, isError));
    this.digestRules.set('read_file', (output, isError) => this.digestReadFile(output, isError));
    this.digestRules.set('cat', (output, isError) => this.digestReadFile(output, isError));

    // 写入/编辑
    this.digestRules.set('write', (output, isError) => this.digestWriteFile(output, isError));
    this.digestRules.set('edit', (output, isError) => this.digestWriteFile(output, isError));

    // 搜索
    this.digestRules.set('grep', (output, isError) => this.digestSearch(output, isError));
    this.digestRules.set('search', (output, isError) => this.digestSearch(output, isError));
    this.digestRules.set('find', (output, isError) => this.digestSearch(output, isError));
  }

  /**
   * 摘要 Shell 命令输出
   * 提取：测试结果统计、错误、涉及的文件
   */
  private digestShell(output: string, _isError: boolean): Partial<ToolDigest> {
    const lines = output.split('\n');
    const errors: string[] = [];
    const filesChanged: string[] = [];
    let summary = '';
    let passed = 0;
    let failed = 0;
    let duration = '';

    // 检查测试输出
    const passedMatch = output.match(/(\d+)\s*(?:passed|Passed|PASS|ok)/);
    const failedMatch = output.match(/(\d+)\s*(?:failed|Failed|FAIL|error)/);
    const durationMatch = output.match(/(?:[\d.]+)(?:s|ms|seconds?)/i);

    if (passedMatch) passed = parseInt(passedMatch[1], 10);
    if (failedMatch) failed = parseInt(failedMatch[1], 10);
    if (durationMatch) duration = durationMatch[0];

    // 提取错误信息
    for (const line of lines) {
      if (line.match(/error|Error|ERROR|FAIL|✗|×|failed|Failed/) && line.trim().length > 5) {
        if (errors.length < 3) {
          errors.push(line.trim().slice(0, 200));
        }
      }
      // 提取涉及的文件路径
      const fileMatch = line.match(/(?:src|tests?|lib|app)\/[\w./-]+\.[a-zA-Z]+/);
      if (fileMatch && !filesChanged.includes(fileMatch[0])) {
        filesChanged.push(fileMatch[0]);
      }
    }

    if (passed > 0 || failed > 0) {
      // 测试结果摘要
      summary = `测试结果: ${passed} 通过, ${failed} 失败${duration ? ` (${duration})` : ''}`;
      if (failed > 0 && errors.length > 0) {
        summary += ` - 错误: ${errors[0]}`;
      }
    } else if (errors.length > 0) {
      // 命令执行失败
      summary = `命令执行失败: ${errors[0]}`;
    } else {
      // 命令执行成功
      const lastLines = lines.slice(-3).filter(l => l.trim()).map(l => l.trim()).join('; ');
      summary = `命令执行成功${lastLines ? `: ${lastLines.slice(0, 150)}` : ''}`;
    }

    return {
      summary,
      errors,
      filesChanged: filesChanged.slice(0, 10),
    };
  }

  /**
   * 摘要文件读取输出
   * 提取：文件行数、结构信息（导入、导出、函数/类数量）
   */
  private digestReadFile(output: string, _isError: boolean): Partial<ToolDigest> {
    const lines = output.split('\n');
    const filesChanged: string[] = [];
    
    // 尝试提取文件路径
    const pathMatch = output.match(/(?:path|file|文件):?\s*["']?([\w./-]+\.[a-zA-Z0-9]+)["']?/i);
    if (pathMatch) {
      filesChanged.push(pathMatch[1]);
    }

    // 提取结构：导入/导出/函数
    const imports = lines.filter(l => l.match(/^import\s|^from\s|^require\(/)).slice(0, 3);
    const exports = lines.filter(l => l.match(/^export\s/)).slice(0, 3);
    const functions = lines.filter(l => l.match(/function\s+\w+|const\s+\w+\s*=|class\s+\w+/)).slice(0, 5);

    const structureParts: string[] = [];
    if (imports.length > 0) structureParts.push(`${imports.length} 个导入`);
    if (exports.length > 0) structureParts.push(`${exports.length} 个导出`);
    if (functions.length > 0) structureParts.push(`${functions.length} 个函数/类`);

    const summary = `读取文件: ${lines.length} 行${structureParts.length > 0 ? ` (${structureParts.join(', ')})` : ''}`;

    return {
      summary,
      filesChanged,
      errors: [],
    };
  }

  /**
   * 摘要文件写入输出
   * 提取：写入状态、文件路径、变更行数统计
   */
  private digestWriteFile(output: string, _isError: boolean): Partial<ToolDigest> {
    const lines = output.split('\n');
    const filesChanged: string[] = [];

    // 尝试提取文件路径
    const pathMatch = output.match(/(?:path|file|文件|to):?\s*["']?([\w./-]+\.[a-zA-Z0-9]+)["']?/i);
    if (pathMatch) {
      filesChanged.push(pathMatch[1]);
    }

    // 检查 diff 统计
    const addMatch = output.match(/(\d+)\s*insertions?|\+(\d+)/);
    const delMatch = output.match(/(\d+)\s*deletions?|-(\d+)/);
    
    let changes = '';
    if (addMatch || delMatch) {
      const adds = addMatch ? (addMatch[1] || addMatch[2]) : '0';
      const dels = delMatch ? (delMatch[1] || delMatch[2]) : '0';
      changes = ` (+${adds} -${dels})`;
    }

    const summary = `${_isError ? '写入失败' : '写入成功'}${filesChanged.length > 0 ? `: ${filesChanged[0]}` : ''}${changes}`;

    return {
      summary,
      filesChanged,
      errors: _isError ? [output.slice(0, 300)] : [],
    };
  }

  /**
   * 摘要搜索输出
   * 提取：匹配数、涉及文件数、关键匹配行
   */
  private digestSearch(output: string, _isError: boolean): Partial<ToolDigest> {
    const lines = output.split('\n').filter(l => l.trim());
    const matches = lines.length;
    const filesChanged: string[] = [];

    // 从结果中提取唯一文件路径
    for (const line of lines.slice(0, 20)) {
      const fileMatch = line.match(/([\w./-]+\.[a-zA-Z0-9]+)/);
      if (fileMatch && !filesChanged.includes(fileMatch[1])) {
        filesChanged.push(fileMatch[1]);
      }
    }

    // 获取关键匹配行
    const keyMatches = lines.slice(0, 5).map(l => l.trim().slice(0, 100));
    const summary = `搜索结果: ${matches} 处匹配，涉及 ${filesChanged.length} 个文件`;

    return {
      summary,
      filesChanged: filesChanged.slice(0, 10),
      importantLines: keyMatches,
      errors: [],
    };
  }

  /**
   * 通用摘要（fallback）
   * 当没有匹配的专用规则时使用
   * 提取：头部几行、尾部关键行、状态
   */
  private genericDigest(output: string, isError: boolean): Partial<ToolDigest> {
    const lines = output.split('\n');
    const errors: string[] = [];
    const importantLines: string[] = [];

    // 取前 5 行
    const head = lines.slice(0, 5).filter(l => l.trim());
    // 取最后 10 行
    const tail = lines.slice(-10).filter(l => l.trim());

    for (const line of tail) {
      if (line.match(/error|Error|FAIL|✗|failed|success|Success|passed|完成/)) {
        if (errors.length < 3 && isError) errors.push(line.trim().slice(0, 200));
        importantLines.push(line.trim().slice(0, 150));
      }
    }

    const headStr = head.length > 0 ? head.map(l => l.trim().slice(0, 80)).join('; ') : '';
    const tailStr = importantLines.length > 0 ? ` 最后: ${importantLines[importantLines.length - 1]}` : '';
    
    const summary = `${isError ? '执行失败' : '执行成功'} (${lines.length} 行)${headStr ? `: ${headStr}` : ''}${tailStr}`;

    return {
      summary: summary.slice(0, 300),
      errors,
      importantLines: importantLines.slice(0, 8),
      filesChanged: [],
    };
  }

  /**
   * 提取重要行
   * 根据配置中的保留模式匹配输出中的关键行
   */
  private extractImportantLines(output: string): string[] {
    const lines = output.split('\n');
    const important: string[] = [];
    const patterns = this.config.default_rules
      .flatMap(r => r.preservePatterns || [])
      .map(p => new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      
      for (const pattern of patterns) {
        if (pattern.test(trimmed)) {
          important.push(trimmed.slice(0, 200));
          break;
        }
      }
      
      if (important.length >= 15) break;
    }

    return important;
  }

  /**
   * 简单哈希函数
   * 用于生成输出的唯一标识
   */
  private hash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
  }
}
