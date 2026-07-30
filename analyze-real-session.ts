#!/usr/bin/env npx tsx
/**
 * 分析真实 CLI session 是否触发了 ACR 压缩
 * 并生成压缩前后对比
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { AgentContextRuntime } from './src/context-runtime';
import type { AgentMessage } from './src/agent';
import {
  getMessageContent,
  isStateSnapshot,
  isCompactionSummary,
  estimateMessageTokens,
} from './src/context-runtime/state/message-adapter';

const SESSION_PATH = join(homedir(), '.kobot/sessions/sdk_default.json');
const OUT_DIR = join(process.cwd(), 'acr-real-session-compare');

interface SessionEntry {
  type: string;
  message?: any;
  toolName?: string;
  toolCallId?: string;
  content?: string;
  isError?: boolean;
  timestamp: string;
}

interface SessionData {
  key: string;
  entries: SessionEntry[];
  createdAt: string;
  updatedAt: string;
}

function loadSession(): SessionData {
  const raw = readFileSync(SESSION_PATH, 'utf-8');
  return JSON.parse(raw);
}

function extractMessages(session: SessionData): AgentMessage[] {
  const messages: AgentMessage[] = [];
  
  for (const entry of session.entries) {
    if (entry.type === 'message' && entry.message) {
      messages.push(entry.message as AgentMessage);
    }
  }
  
  return messages;
}

function getMessageTypeLabel(msg: AgentMessage): string {
  if (isStateSnapshot(msg)) return '📊 STATE_SNAPSHOT';
  if (isCompactionSummary(msg)) return '📦 COMPACTION_SUMMARY';
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
  return str.slice(0, maxLen) + `... (${str.length} chars)`;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║     真实 CLI Session - ACR 压缩分析                           ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');
  
  // 1. Load session
  console.log('📂 加载 session 数据...');
  const session = loadSession();
  console.log(`   Session key: ${session.key}`);
  console.log(`   Created: ${session.createdAt}`);
  console.log(`   Updated: ${session.updatedAt}`);
  console.log(`   Total entries: ${session.entries.length}`);
  
  // Count entry types
  const typeCount: Record<string, number> = {};
  for (const e of session.entries) {
    typeCount[e.type] = (typeCount[e.type] || 0) + 1;
  }
  console.log('   Entry types:');
  for (const [t, c] of Object.entries(typeCount)) {
    console.log(`     ${t}: ${c}`);
  }
  console.log();
  
  // 2. Extract messages
  console.log('📨 提取消息...');
  const messages = extractMessages(session);
  console.log(`   消息总数: ${messages.length}`);
  
  // Count by role
  const roleCount: Record<string, number> = {};
  let totalChars = 0;
  for (const msg of messages) {
    const role = msg.role;
    roleCount[role] = (roleCount[role] || 0) + 1;
    totalChars += getMessageContent(msg).length;
  }
  console.log('   按角色统计:');
  for (const [r, c] of Object.entries(roleCount)) {
    console.log(`     ${r}: ${c}`);
  }
  
  const totalTokens = Math.ceil(totalChars / 3);
  console.log(`   总字符数: ${totalChars}`);
  console.log(`   预估 tokens: ~${totalTokens}`);
  console.log();
  
  // 3. Check for existing ACR traces
  console.log('🔍 检查是否已有 ACR 压缩痕迹...');
  let hasStateSnapshot = false;
  let hasCompactionSummary = false;
  let acrMessageCount = 0;
  
  for (const msg of messages) {
    if (isStateSnapshot(msg)) {
      hasStateSnapshot = true;
      acrMessageCount++;
    }
    if (isCompactionSummary(msg)) {
      hasCompactionSummary = true;
      acrMessageCount++;
    }
    const content = getMessageContent(msg);
    if (content.includes('State Snapshot') || content.includes('状态快照') || content.includes('上下文已压缩')) {
      acrMessageCount++;
    }
  }
  
  console.log(`   有 State Snapshot: ${hasStateSnapshot ? '✅ 是' : '❌ 否'}`);
  console.log(`   有 Compaction Summary: ${hasCompactionSummary ? '✅ 是' : '❌ 否'}`);
  console.log(`   ACR 相关消息数: ${acrMessageCount}`);
  
  if (!hasStateSnapshot && !hasCompactionSummary) {
    console.log('   ➡️  此 session 未发生过 ACR 压缩');
  } else {
    console.log('   ➡️  此 session 已发生过 ACR 压缩');
  }
  console.log();
  
  // 4. Run ACR on these messages
  console.log('⚙️  使用 ACR 分析（默认配置: 128000 tokens limit）...');
  
  const acr = new AgentContextRuntime({
    workspacePath: process.cwd(),
    config: {
      profile: 'coding',
      contextLimit: 128000,
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
  
  const health = await acr.getHealth();
  console.log(`   健康状态: ${health.overall}`);
  console.log(`   Token 使用率: ${(health.token.ratio * 100).toFixed(1)}%`);
  console.log(`   价值密度: ${health.density.density.toFixed(2)}`);
  console.log();
  
  console.log('🔬 运行 checkBeforeModelCall...');
  const check = await acr.checkBeforeModelCall(messages);
  console.log(`   shouldCompact: ${check.shouldCompact}`);
  console.log(`   level: ${check.level || 'none'}`);
  console.log(`   reasons: ${check.reasons.join(', ') || 'none'}`);
  if (check.tokenHealth) {
    console.log(`   token level: ${check.tokenHealth.level}`);
    console.log(`   token ratio: ${(check.tokenHealth.ratio * 100).toFixed(1)}%`);
  }
  console.log();
  
  // 5. If no compression with default limit, try smaller limits
  if (!check.shouldCompact) {
    console.log('💡 默认 limit 未触发，尝试不同的 context limit...');
    console.log();
    
    const testLimits = [100000, 80000, 60000, 40000, 20000];
    for (const limit of testLimits) {
      const testAcr = new AgentContextRuntime({
        workspacePath: process.cwd(),
        config: {
          profile: 'coding',
          contextLimit: limit,
          observability: {
            debug: false, logCompressions: false, logHealthChecks: false,
            emitMetrics: false, keepCompressionHistory: 10, keepStateHistory: 5,
          },
        },
      });
      const testCheck = await testAcr.checkBeforeModelCall(messages);
      const testHealth = await testAcr.getHealth();
      console.log(`   Limit=${limit} (${((totalTokens / limit) * 100).toFixed(0)}%): ` +
        `shouldCompact=${testCheck.shouldCompact}, ` +
        `level=${testCheck.level || 'none'}, ` +
        `density=${testHealth.density.density.toFixed(2)}`);
    }
    console.log();
  }
  
  // 6. Force compression and show before/after
  console.log('🔧 强制执行 window 级别压缩以展示效果...');
  
  const forceAcr = new AgentContextRuntime({
    workspacePath: process.cwd(),
    config: {
      profile: 'coding',
      contextLimit: 50000, // 设小一点确保触发
      observability: {
        debug: false, logCompressions: false, logHealthChecks: false,
        emitMetrics: false, keepCompressionHistory: 10, keepStateHistory: 5,
      },
    },
  });
  
  const forceCheck = await forceAcr.checkBeforeModelCall(messages);
  const level = forceCheck.level || 'window';
  
  const result = await forceAcr.compressAndGetResult(level, 'analysis');
  
  console.log(`   压缩级别: ${level}`);
  console.log(`   策略: ${result.strategiesUsed.join(', ')}`);
  console.log(`   消息: ${result.messagesBefore} → ${result.messagesAfter} (减少 ${result.messagesBefore - result.messagesAfter})`);
  console.log(`   Tokens 节省: ~${result.tokensSaved}`);
  console.log(`   压缩率: ${(result.compressionRatio * 100).toFixed(1)}%`);
  console.log(`   耗时: ${result.durationMs}ms`);
  console.log();
  
  // 7. Save before/after messages
  console.log('💾 保存对比产物...');
  
  // Before JSON
  const beforeJson = messages.map((m, i) => ({
    index: i + 1,
    role: m.role,
    type: isStateSnapshot(m) ? 'state_snapshot' : isCompactionSummary(m) ? 'compaction_summary' : m.role,
    tokens: estimateMessageTokens(m),
    charCount: getMessageContent(m).length,
    content: getMessageContent(m).slice(0, 2000), // Truncate long content
  }));
  writeFileSync(join(OUT_DIR, 'before-messages.json'), JSON.stringify(beforeJson, null, 2), 'utf-8');
  console.log(`   ✓ 压缩前: ${OUT_DIR}/before-messages.json`);
  
  // After JSON
  const afterJson = result.messages.map((m, i) => ({
    index: i + 1,
    role: m.role,
    type: isStateSnapshot(m) ? 'state_snapshot' : isCompactionSummary(m) ? 'compaction_summary' : m.role,
    tokens: estimateMessageTokens(m),
    charCount: getMessageContent(m).length,
    content: getMessageContent(m).slice(0, 2000),
  }));
  writeFileSync(join(OUT_DIR, 'after-messages.json'), JSON.stringify(afterJson, null, 2), 'utf-8');
  console.log(`   ✓ 压缩后: ${OUT_DIR}/after-messages.json`);
  
  // State snapshot
  const snapshotMsg = result.messages.find(m => isStateSnapshot(m));
  if (snapshotMsg) {
    writeFileSync(join(OUT_DIR, 'state-snapshot.txt'), getMessageContent(snapshotMsg), 'utf-8');
    console.log(`   ✓ State 快照: ${OUT_DIR}/state-snapshot.txt`);
  }
  
  // Text report
  const reportLines: string[] = [];
  reportLines.push('╔══════════════════════════════════════════════════════════════════════╗');
  reportLines.push('║     真实 CLI Session - ACR 压缩前后对比报告                           ║');
  reportLines.push('╚══════════════════════════════════════════════════════════════════════╝');
  reportLines.push('');
  reportLines.push(`Session: ${session.key}`);
  reportLines.push(`时间: ${session.createdAt} ~ ${session.updatedAt}`);
  reportLines.push('');
  reportLines.push('┌──────────────────────────────────────────────────────────────────────┐');
  reportLines.push('│  📊 压缩统计                                                          │');
  reportLines.push('├──────────────────────────────────────────────────────────────────────┤');
  reportLines.push(`│  压缩级别:     ${level.padEnd(53)}│`);
  reportLines.push(`│  使用策略:     ${result.strategiesUsed.join(', ').padEnd(53)}│`);
  reportLines.push(`│  消息数 前→后: ${result.messagesBefore} → ${result.messagesAfter} (减少 ${result.messagesBefore - result.messagesAfter} 条)          │`);
  reportLines.push(`│  预估 tokens:  ~${totalTokens} → ~${totalTokens - result.tokensSaved} (节省 ~${result.tokensSaved})   │`);
  reportLines.push(`│  压缩率:       ${(result.compressionRatio * 100).toFixed(1)}%                                        │`);
  reportLines.push('└──────────────────────────────────────────────────────────────────────┘');
  reportLines.push('');
  reportLines.push('');
  reportLines.push('▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ 压缩前消息列表 (BEFORE) ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓');
  reportLines.push('');
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const label = getMessageTypeLabel(msg);
    const content = getMessageContent(msg).replace(/\n/g, ' ↵ ');
    const tokens = estimateMessageTokens(msg);
    reportLines.push(`[#${String(i + 1).padStart(2, '0')}] ${label} (~${tokens} tok): ${truncate(content, 80)}`);
  }
  reportLines.push('');
  reportLines.push('');
  reportLines.push('▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ 压缩后消息列表 (AFTER) ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓');
  reportLines.push('');
  for (let i = 0; i < result.messages.length; i++) {
    const msg = result.messages[i];
    const label = getMessageTypeLabel(msg);
    const content = getMessageContent(msg).replace(/\n/g, ' ↵ ');
    const tokens = estimateMessageTokens(msg);
    reportLines.push(`[#${String(i + 1).padStart(2, '0')}] ${label} (~${tokens} tok): ${truncate(content, 80)}`);
  }
  
  writeFileSync(join(OUT_DIR, 'compression-report.txt'), reportLines.join('\n'), 'utf-8');
  console.log(`   ✓ 完整报告: ${OUT_DIR}/compression-report.txt`);
  console.log();
  
  // 8. Show state snapshot preview
  if (snapshotMsg) {
    console.log('📸 State Snapshot 预览:');
    console.log('─'.repeat(60));
    console.log(getMessageContent(snapshotMsg).slice(0, 500));
    console.log('...');
    console.log('─'.repeat(60));
    console.log();
  }
  
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  ✅ 分析完成！产物目录:');
  console.log(`     ${OUT_DIR}`);
  console.log('══════════════════════════════════════════════════════════════');
}

main().catch(err => {
  console.error('\n❌ 错误:', err);
  process.exit(1);
});
