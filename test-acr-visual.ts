#!/usr/bin/env npx tsx
/**
 * ACR Compression Visualizer
 * 清晰展示上下文压缩前后的完整产物对比
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { AgentContextRuntime } from './src/context-runtime';
import type { AgentMessage } from './src/agent/types';
import {
  getMessageContent,
  isStateSnapshot,
  isCompactionSummary,
  isToolDigest,
  estimateMessageTokens,
} from './src/context-runtime/state/message-adapter';

// ─── Test data builders ───

function createUserMessage(content: string): AgentMessage {
  return {
    role: 'user',
    content,
    timestamp: Date.now(),
  } as AgentMessage;
}

function createAssistantMessage(content: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: content }],
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

function createToolResult(toolName: string, content: string, callId: string): AgentMessage {
  return {
    role: 'toolResult',
    content: [{ type: 'text', text: content }],
    toolCallId: callId,
    toolName,
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

function generateLongFileContent(fileNum: number, charCount: number): string {
  const lines: string[] = [];
  lines.push(`// ========== File #${fileNum}: module${fileNum}.ts ==========`);
  lines.push(`// This is a simulated TypeScript module file #${fileNum}`);
  lines.push('');
  lines.push(`export interface Config${fileNum} {`);
  lines.push(`  name: string;`);
  lines.push(`  enabled: boolean;`);
  lines.push(`  timeout: number;`);
  lines.push(`  retries: number;`);
  lines.push(`}`);
  lines.push('');
  lines.push(`export function process${fileNum}(input: string): string {`);
  lines.push(`  // Process the input string with various transformations`);
  lines.push(`  const trimmed = input.trim();`);
  lines.push(`  const lower = trimmed.toLowerCase();`);
  lines.push(`  const parts = lower.split(/\\s+/);`);
  lines.push(`  const filtered = parts.filter(p => p.length > 0);`);
  lines.push(`  const result = filtered.join('-');`);
  lines.push(`  return result;`);
  lines.push(`}`);
  lines.push('');
  lines.push(`export async function fetch${fileNum}(url: string): Promise<Response> {`);
  lines.push(`  // Fetch data from the given URL`);
  lines.push(`  const response = await fetch(url, {`);
  lines.push(`    method: 'GET',`);
  lines.push(`    headers: { 'Content-Type': 'application/json' },`);
  lines.push(`  });`);
  lines.push(`  if (!response.ok) {`);
  lines.push(`    throw new Error(\`HTTP error! status: \${response.status}\`);`);
  lines.push(`  }`);
  lines.push(`  return response;`);
  lines.push(`}`);
  lines.push('');
  // Add filler lines to reach desired length
  while (lines.join('\n').length < charCount) {
    lines.push(`  // Filler line ${lines.length} - just adding content for testing`);
  }
  return lines.join('\n');
}

// ─── Formatting helpers ───

function getMessageTypeLabel(msg: AgentMessage): string {
  if (isStateSnapshot(msg)) return '📊 STATE_SNAPSHOT';
  if (isCompactionSummary(msg)) return '📦 COMPACTION_SUMMARY';
  if (isToolDigest(msg)) return '🔧 TOOL_DIGEST';
  switch (msg.role) {
    case 'user': return '👤 USER';
    case 'assistant': return '🤖 ASSISTANT';
    case 'toolResult': return '🔧 TOOL_RESULT';
    case 'system': return '⚙️  SYSTEM';
    case 'custom': return '✨ CUSTOM';
    default: return `❓ ${msg.role}`;
  }
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + `... (截断，共${str.length}字符)`;
}

function formatMessageList(messages: AgentMessage[], title: string): string {
  const lines: string[] = [];
  const totalTokens = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  
  lines.push('');
  lines.push('═'.repeat(80));
  lines.push(`  ${title}`);
  lines.push(`  消息总数: ${messages.length}  |  预估 tokens: ~${totalTokens}`);
  lines.push('═'.repeat(80));
  
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const content = getMessageContent(msg);
    const tokens = estimateMessageTokens(msg);
    const typeLabel = getMessageTypeLabel(msg);
    const preview = truncate(content.replace(/\n/g, ' ↵ '), 80);
    
    lines.push('');
    lines.push(`┌─ [#${String(i + 1).padStart(2, '0')}] ${typeLabel}  (~${tokens} tokens) ─┐`);
    lines.push(`│  ${preview}`);
    lines.push(`└${'─'.repeat(76)}┘`);
  }
  
  return lines.join('\n');
}

function formatDetailedMessage(msg: AgentMessage, index: number): string {
  const content = getMessageContent(msg);
  const tokens = estimateMessageTokens(msg);
  const typeLabel = getMessageTypeLabel(msg);
  
  const lines: string[] = [];
  lines.push('');
  lines.push('━'.repeat(80));
  lines.push(`  Message #${index + 1}  |  ${typeLabel}  |  ~${tokens} tokens  |  ${content.length} chars`);
  lines.push('━'.repeat(80));
  lines.push(content);
  lines.push('');
  
  return lines.join('\n');
}

function buildFullReport(
  messagesBefore: AgentMessage[],
  messagesAfter: AgentMessage[],
  stats: any,
  level: string,
  trigger: string,
): string {
  const lines: string[] = [];
  
  lines.push('╔══════════════════════════════════════════════════════════════════════╗');
  lines.push('║       ACR 上下文压缩 - 前后产物完整对比报告                           ║');
  lines.push('╚══════════════════════════════════════════════════════════════════════╝');
  
  // Summary
  lines.push('');
  lines.push('┌──────────────────────────────────────────────────────────────────────┐');
  lines.push('│  📊 压缩统计总览                                                      │');
  lines.push('├──────────────────────────────────────────────────────────────────────┤');
  const tokensBeforeCalc = messagesBefore.reduce((s, m) => s + estimateMessageTokens(m), 0);
  const tokensAfterCalc = messagesAfter.reduce((s, m) => s + estimateMessageTokens(m), 0);
  const savedCalc = tokensBeforeCalc - tokensAfterCalc;
  const ratioCalc = tokensBeforeCalc > 0 ? savedCalc / tokensBeforeCalc : 0;
  
  lines.push(`│  压缩级别:     ${String(stats.level || level || 'window').padEnd(53)}│`);
  lines.push(`│  触发原因:     ${String(stats.trigger || trigger || 'test').padEnd(53)}│`);
  lines.push(`│  使用策略:     ${stats.strategiesUsed.join(', ').padEnd(53)}│`);
  lines.push(`│  消息数 前→后: ${stats.messagesBefore} → ${stats.messagesAfter} (减少 ${stats.messagesBefore - stats.messagesAfter} 条)          │`);
  lines.push(`│  Tokens 前→后: ~${tokensBeforeCalc} → ~${tokensAfterCalc} (节省 ~${savedCalc} tokens)   │`);
  lines.push(`│  压缩率:       ${(ratioCalc * 100).toFixed(1)}%                                        │`);
  lines.push(`│  耗时:         ${stats.durationMs}ms                                         │`);
  lines.push('└──────────────────────────────────────────────────────────────────────┘');
  
  // Message list comparison (side by side would be complex, do top-bottom)
  lines.push('');
  lines.push('');
  lines.push('▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ 压缩前 (BEFORE) ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓');
  lines.push(formatMessageList(messagesBefore, '压缩前消息列表'));
  
  lines.push('');
  lines.push('');
  lines.push('▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ 压缩后 (AFTER) ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓');
  lines.push(formatMessageList(messagesAfter, '压缩后消息列表'));
  
  // Detailed content of AFTER messages
  lines.push('');
  lines.push('');
  lines.push('▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ 压缩后完整内容 (DETAILED AFTER) ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓');
  
  for (let i = 0; i < messagesAfter.length; i++) {
    lines.push(formatDetailedMessage(messagesAfter[i], i));
  }
  
  // Transition message
  if (stats.transitionMessage) {
    lines.push('');
    lines.push('');
    lines.push('──────────────────────────────────────────────────────────────────────');
    lines.push('  📝 压缩过渡消息 (Transition Message)');
    lines.push('──────────────────────────────────────────────────────────────────────');
    lines.push(stats.transitionMessage);
  }
  
  return lines.join('\n');
}

// ─── Main ───

async function main() {
  const outDir = join(process.cwd(), 'acr-compare-output');
  mkdirSync(outDir, { recursive: true });
  
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║     ACR 上下文压缩 - 前后产物可视化对比                       ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');
  
  // 1. Build realistic test messages
  console.log('📝 构建测试消息（模拟编程场景的多轮对话 + 多次工具调用）...');
  
  const messages: AgentMessage[] = [];
  
  // Initial user request
  messages.push(createUserMessage(
    '帮我实现一个用户认证模块，需要包含：\n' +
    '1. 密码哈希存储\n' +
    '2. JWT token 生成和验证\n' +
    '3. 登录/注册接口\n' +
    '4. 中间件鉴权\n' +
    '请先看看项目结构，然后逐步实现。'
  ));
  
  // Assistant explores
  messages.push(createAssistantMessage('好的，我来帮你实现用户认证模块。首先让我查看一下项目结构。'));
  messages.push(createToolResult('list_files', 
    '项目根目录:\n' +
    '  src/\n' +
    '    controllers/\n' +
    '    middleware/\n' +
    '    models/\n' +
    '    routes/\n' +
    '    utils/\n' +
    '  package.json\n' +
    '  tsconfig.json\n' +
    '  README.md',
    'call_1'
  ));
  
  messages.push(createAssistantMessage('我看到项目已经有了基础结构。让我查看 package.json 了解现有依赖。'));
  messages.push(createToolResult('read_file', 
    '{\n  "name": "my-project",\n  "version": "1.0.0",\n  "dependencies": {\n    "express": "^4.18.0",\n    "typescript": "^5.0.0"\n  },\n  "devDependencies": {\n    "@types/express": "^4.17.0"\n  }\n}',
    'call_2'
  ));
  
  // Many file reads and implementations
  for (let i = 1; i <= 12; i++) {
    messages.push(createAssistantMessage(
      `现在我来创建/查看第 ${i} 个模块文件。这是认证系统的重要组成部分，` +
      `需要仔细实现。让我先读取现有的 ${i} 号文件看看有没有可以复用的代码。`
    ));
    messages.push(createToolResult(
      'read_file',
      generateLongFileContent(i, 600 + i * 50),
      `call_${i + 2}`
    ));
    messages.push(createAssistantMessage(
      `看完文件 ${i}，我发现了一些有用的模式。这个文件的结构很清晰，` +
      `我们可以借鉴它的设计模式来实现认证模块。接下来我继续看下一个文件。`
    ));
  }
  
  // Some errors / failed attempts
  messages.push(createAssistantMessage('让我尝试安装 bcrypt 依赖来做密码哈希。'));
  messages.push(createToolResult('shell', 
    'npm install bcrypt\n' +
    'npm ERR! code ENOENT\n' +
    'npm ERR! syscall spawn git\n' +
    'npm ERR! path git\n' +
    'npm ERR! errno -2\n' +
    'npm ERR! enoent Git is not installed\n' +
    'npm ERR! enoent This is related to npm not being able to find git.\n' +
    '\n' +
    'npm ERR! A complete log of this run can be found in:\n' +
    'npm ERR!     /root/.npm/_logs/debug.log',
    'call_install'
  ));
  
  messages.push(createAssistantMessage('安装失败了，git 不可用。没关系，我们可以用纯 Node.js 的 crypto 模块自己实现密码哈希，用 pbkdf2 算法。'));
  
  // More content
  messages.push(createToolResult(
    'read_file',
    generateLongFileContent(99, 800),
    'call_extra_1'
  ));
  messages.push(createAssistantMessage(
    '好的，现在我对项目有了全面了解。让我总结一下实现方案：\n\n' +
    '1. 使用 Node.js 内置 crypto 模块的 pbkdf2 做密码哈希\n' +
    '2. 用 jsonwebtoken 包做 JWT（需要安装）\n' +
    '3. 创建 User model、AuthController、auth middleware\n' +
    '4. 注册 /api/auth/login 和 /api/auth/register 路由\n\n' +
    '我现在开始实现。'
  ));
  
  console.log(`   ✓ 构建完成，共 ${messages.length} 条消息`);
  
  const tokensBefore = messages.reduce((s, m) => s + estimateMessageTokens(m), 0);
  console.log(`   预估 tokens: ~${tokensBefore}`);
  console.log();
  
  // 2. Create ACR instance with small limit to force compression
  const acr = new AgentContextRuntime({
    workspacePath: process.cwd(),
    config: {
      profile: 'coding',
      contextLimit: 5000, // Small limit to trigger L2
      observability: {
        debug: false,
        logCompressions: false,
        logHealthChecks: false,
        emitMetrics: false,
        keepCompressionHistory: 10,
        keepStateHistory: 5,
      },
    },
  });
  
  // 3. Check and compress
  console.log('🔍 检查上下文健康状态...');
  const check = await acr.checkBeforeModelCall(messages);
  console.log(`   shouldCompact: ${check.shouldCompact}`);
  console.log(`   level: ${check.level || 'none'}`);
  console.log(`   reasons: ${check.reasons.join(', ')}`);
  console.log(`   token ratio: ${check.tokenHealth?.ratio.toFixed(2)}`);
  console.log();
  
  if (!check.shouldCompact) {
    console.log('⚠️  未触发压缩，强制执行 window 级别...');
  }
  
  const level = check.level || 'window';
  
  // Apply compression
  console.log(`⚙️  执行 ${level} 级别压缩...`);
  const result = await acr.compressAndGetResult(level, 'visualizer_test');
  
  console.log(`   ✓ 压缩完成！`);
  console.log(`   策略: ${result.strategiesUsed.join(', ')}`);
  console.log(`   消息: ${result.messagesBefore} → ${result.messagesAfter} 条`);
  console.log(`   Tokens: ~${result.tokensBefore} → ~${result.tokensAfter} (节省 ${result.tokensSaved})`);
  console.log(`   压缩率: ${(result.compressionRatio * 100).toFixed(1)}%`);
  console.log();
  
  // 4. Print before/after summary list to console
  console.log('─'.repeat(60));
  console.log('  📋 压缩前消息列表');
  console.log('─'.repeat(60));
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const content = getMessageContent(msg);
    const label = getMessageTypeLabel(msg);
    const preview = truncate(content.replace(/\n/g, ' ↵ '), 50);
    console.log(`  [#${String(i + 1).padStart(2, '0')}] ${label}: ${preview}`);
  }
  
  console.log();
  console.log('─'.repeat(60));
  console.log('  📋 压缩后消息列表');
  console.log('─'.repeat(60));
  for (let i = 0; i < result.messages.length; i++) {
    const msg = result.messages[i];
    const content = getMessageContent(msg);
    const label = getMessageTypeLabel(msg);
    const preview = truncate(content.replace(/\n/g, ' ↵ '), 50);
    console.log(`  [#${String(i + 1).padStart(2, '0')}] ${label}: ${preview}`);
  }
  
  // 5. Generate full report and save to files
  console.log();
  console.log('💾 保存对比产物到文件...');
  
  // Full text report
  const fullReport = buildFullReport(messages, result.messages, result, level, 'visualizer_test');
  const reportPath = join(outDir, 'compression-report.txt');
  writeFileSync(reportPath, fullReport, 'utf-8');
  console.log(`   ✓ 完整报告: ${reportPath}`);
  
  // JSON before
  const beforeJson = messages.map((m, i) => ({
    index: i + 1,
    role: m.role,
    type: isStateSnapshot(m) ? 'state_snapshot' : isCompactionSummary(m) ? 'compaction_summary' : isToolDigest(m) ? 'tool_digest' : m.role,
    tokens: estimateMessageTokens(m),
    charCount: getMessageContent(m).length,
    content: getMessageContent(m),
  }));
  const beforePath = join(outDir, 'before-messages.json');
  writeFileSync(beforePath, JSON.stringify(beforeJson, null, 2), 'utf-8');
  console.log(`   ✓ 压缩前 JSON: ${beforePath}`);
  
  // JSON after
  const afterJson = result.messages.map((m, i) => ({
    index: i + 1,
    role: m.role,
    type: isStateSnapshot(m) ? 'state_snapshot' : isCompactionSummary(m) ? 'compaction_summary' : isToolDigest(m) ? 'tool_digest' : m.role,
    tokens: estimateMessageTokens(m),
    charCount: getMessageContent(m).length,
    content: getMessageContent(m),
  }));
  const afterPath = join(outDir, 'after-messages.json');
  writeFileSync(afterPath, JSON.stringify(afterJson, null, 2), 'utf-8');
  console.log(`   ✓ 压缩后 JSON: ${afterPath}`);
  
  // State snapshot单独保存
  const snapshotMsg = result.messages.find(m => isStateSnapshot(m));
  if (snapshotMsg) {
    const snapshotPath = join(outDir, 'state-snapshot.txt');
    writeFileSync(snapshotPath, getMessageContent(snapshotMsg), 'utf-8');
    console.log(`   ✓ State 快照: ${snapshotPath}`);
  }
  
  console.log();
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  ✅ 压缩前后产物已生成，请查看输出目录：');
  console.log(`     ${outDir}`);
  console.log('══════════════════════════════════════════════════════════════');
  console.log();
  console.log('  文件说明:');
  console.log('    📄 compression-report.txt  - 完整对比报告（文本格式，推荐阅读）');
  console.log('    📄 before-messages.json    - 压缩前所有消息（JSON 格式）');
  console.log('    📄 after-messages.json     - 压缩后所有消息（JSON 格式）');
  console.log('    📄 state-snapshot.txt      - 生成的 Agent State Snapshot');
  console.log();
}

main().catch(err => {
  console.error('\n❌ 运行出错:');
  console.error(err);
  process.exit(1);
});
