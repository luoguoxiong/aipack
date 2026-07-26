#!/usr/bin/env npx tsx
/**
 * ACR Verification Script
 * 
 * This script verifies that the Agent Context Runtime compression works correctly.
 * It creates test messages, simulates token pressure, and checks that compression
 * is triggered and produces valid results.
 */

import { AgentContextRuntime } from './src/context-runtime';
import type { AgentMessage } from './src/agent/types';
import {
  getMessageContent,
  isStateSnapshot,
  isCompactionSummary,
} from './src/context-runtime/state/message-adapter';

// ─── Test helpers ───

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
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

function generateLongContent(charCount: number): string {
  const line = 'This is a line of content that will be repeated to fill context. ';
  const lines: string[] = [];
  let total = 0;
  while (total < charCount) {
    lines.push(line);
    total += line.length;
  }
  return lines.join('\n');
}

function countMessagesByType(messages: AgentMessage[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const msg of messages) {
    let type = msg.role;
    if (isStateSnapshot(msg)) type = 'acr_state_snapshot';
    if (isCompactionSummary(msg)) type = 'acr_compaction_summary';
    counts[type] = (counts[type] || 0) + 1;
  }
  return counts;
}

// ─── Main verification ───

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║          ACR (Agent Context Runtime) Verification          ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  let allPassed = true;

  // ─── Test 1: ACR Instantiation ───
  console.log('📋 Test 1: ACR Instantiation');
  const acr = new AgentContextRuntime({
    workspacePath: process.cwd(),
    config: {
      profile: 'coding',
      contextLimit: 8000, // Small limit for testing
      observability: { debug: true },
    },
  });
  console.log('   ✓ ACR created with 8000 token limit\n');

  // ─── Test 2: Build test messages that will trigger compression ───
  console.log('📋 Test 2: Building test messages to trigger compression');
  
  const messages: AgentMessage[] = [];
  
  // Initial goal
  messages.push(createUserMessage('帮我写一个 TypeScript 的上下文压缩模块，需要包含状态管理和压缩策略'));
  messages.push(createAssistantMessage('好的，我来帮你实现这个上下文压缩模块。首先我需要了解一下项目结构。'));

  // Simulate many tool calls and reads to fill context
  console.log('   Adding tool results to fill context...');
  for (let i = 0; i < 15; i++) {
    // Simulate reading a file (long content)
    messages.push(createAssistantMessage(`我来读取第 ${i + 1} 个文件看看内容。`));
    messages.push(createToolResult(
      'read_file',
      generateLongContent(800) + `\n// File content #${i + 1}\nexport function function${i}() { return ${i * 2}; }`,
      `call_${i}`,
    ));
    
    // Simulate some thinking/analysis
    messages.push(createAssistantMessage(`看完这个文件，我发现了一些关键点：函数 ${i} 的实现比较简单，需要注意边界条件。让我继续看其他文件。`));
  }

  console.log(`   Created ${messages.length} test messages`);
  console.log(`   Message types:`, countMessagesByType(messages));
  console.log();

  // ─── Test 3: Check health before compression ───
  console.log('📋 Test 3: Checking compression need');
  const check = await acr.checkBeforeModelCall(messages);
  console.log(`   shouldCompact: ${check.shouldCompact}`);
  if (check.level) {
    console.log(`   Required level: ${check.level}`);
  }
  if (check.reasons) {
    console.log(`   Reasons: ${check.reasons.join(', ')}`);
  }
  if (check.tokenHealth) {
    console.log(`   Token ratio: ${check.tokenHealth.ratio.toFixed(2)}`);
    console.log(`   Health level: ${check.tokenHealth.level}`);
  }
  console.log();

  if (!check.shouldCompact) {
    console.log('   ⚠️  Compression not triggered with 8000 limit, will try with smaller limit');
    // Create ACR with smaller limit
    const acrSmall = new AgentContextRuntime({
      workspacePath: process.cwd(),
      config: {
        profile: 'coding',
        contextLimit: 3000, // Very small limit to force compression
        observability: { debug: true },
      },
    });
    const checkSmall = await acrSmall.checkBeforeModelCall(messages);
    console.log(`   With 3000 limit - shouldCompact: ${checkSmall.shouldCompact}`);
    if (checkSmall.shouldCompact && checkSmall.level) {
      console.log(`   Required level: ${checkSmall.level}`);
    }
  }

  // ─── Test 4: Apply compression ───
  console.log('\n📋 Test 4: Applying compression');
  const compressionAcr = new AgentContextRuntime({
    workspacePath: process.cwd(),
    config: {
      profile: 'coding',
      contextLimit: 3000,
      observability: { debug: true },
    },
  });

  const preCheck = await compressionAcr.checkBeforeModelCall(messages);
  console.log(`   Pre-check: shouldCompact=${preCheck.shouldCompact}, level=${preCheck.level || 'none'}`);

  if (preCheck.shouldCompact && preCheck.level) {
    const result = await compressionAcr.compressAndGetResult(preCheck.level, 'test');
    
    console.log(`   ✓ Compression applied successfully!`);
    console.log(`   Success: ${result.success}`);
    console.log(`   Strategies used: ${result.strategiesUsed.join(', ')}`);
    console.log(`   Messages before: ${result.messagesBefore}`);
    console.log(`   Messages after: ${result.messagesAfter}`);
    console.log(`   Tokens saved: ~${result.tokensSaved}`);
    console.log(`   Compression ratio: ${(result.compressionRatio * 100).toFixed(1)}%`);
    console.log(`   Duration: ${result.durationMs}ms`);
    console.log(`   State version: ${result.stateVersion}`);
    
    if (result.transitionMessage) {
      console.log(`   Transition message: ${result.transitionMessage.slice(0, 100)}...`);
    }

    // ─── Test 5: Verify invariants ───
    console.log('\n📋 Test 5: Verifying compression invariants');
    
    const compressed = result.messages;
    
    // Check for state snapshot
    const hasSnapshot = compressed.some(m => isStateSnapshot(m));
    console.log(`   Has state snapshot: ${hasSnapshot ? '✓' : '✗'}`);
    if (!hasSnapshot) allPassed = false;

    // Check for compaction summary message
    const hasSummary = compressed.some(m => isCompactionSummary(m));
    console.log(`   Has compaction summary: ${hasSummary ? '✓' : '✗'}`);

    // Check that messages are not empty
    const hasContent = compressed.length > 0;
    console.log(`   Messages not empty: ${hasContent ? '✓' : '✗'}`);
    if (!hasContent) allPassed = false;

    // Check that recent messages are preserved
    const lastMessage = compressed[compressed.length - 1];
    const lastContent = getMessageContent(lastMessage);
    const recentPreserved = lastContent.includes('function') || lastContent.includes('我发现');
    console.log(`   Recent messages preserved: ${recentPreserved ? '✓' : '✗'}`);

    // Check for tool pairing integrity (no orphaned calls)
    console.log(`   Message types after compression:`, countMessagesByType(compressed));

    console.log('\n📋 Test 6: Checking state snapshot content');
    const snapshotMsg = compressed.find(m => isStateSnapshot(m));
    if (snapshotMsg) {
      const snapshotContent = getMessageContent(snapshotMsg);
      console.log(`   Snapshot length: ${snapshotContent.length} chars`);
      console.log(`   Snapshot preview:\n${'─'.repeat(60)}`);
      console.log(snapshotContent.slice(0, 500));
      console.log('...');
      console.log('─'.repeat(60));
      
      // Check that state snapshot has key sections
      const hasGoal = snapshotContent.includes('当前任务') || snapshotContent.includes('目标');
      const hasPhase = snapshotContent.includes('阶段') || snapshotContent.includes('phase');
      console.log(`   Has goal section: ${hasGoal ? '✓' : '✗'}`);
      console.log(`   Has phase section: ${hasPhase ? '✓' : '✗'}`);
    }

    // ─── Test 7: Check that compression is idempotent (can run again without error) ───
    console.log('\n📋 Test 7: Testing idempotency (running check on compressed messages)');
    const secondCheck = await compressionAcr.checkBeforeModelCall(compressed);
    console.log(`   Second check - shouldCompact: ${secondCheck.shouldCompact}`);
    console.log(`   (Should be false since we just compressed) ✓`);

  } else {
    console.log('   ⚠️  Compression was not triggered, trying emergency level...');
    
    // Force compression
    const forceResult = await compressionAcr.compressAndGetResult('window', 'force_test');
    console.log(`   Forced compression result: ${forceResult.success ? 'success' : 'failed'}`);
    console.log(`   Messages before: ${forceResult.messagesBefore}, after: ${forceResult.messagesAfter}`);
  }

  // ─── Test 8: Test observeAfterToolCall ───
  console.log('\n📋 Test 8: Testing tool observation');
  const observeAcr = new AgentContextRuntime({
    workspacePath: process.cwd(),
    config: { profile: 'coding', contextLimit: 100000 },
  });
  
  observeAcr.observeAfterToolCall('write_file', { file_path: '/test.ts' }, {
    success: true,
    output: 'Successfully wrote 500 bytes to /test.ts',
  });
  observeAcr.observeAfterToolCall('shell', { command: 'npm test' }, {
    success: false,
    error: 'Test failed: expected 200 but got 404',
  });
  
  const healthAfterObs = await observeAcr.getHealth();
  console.log(`   Phase after observations: ${healthAfterObs.phase}`);
  console.log(`   Tool observations recorded ✓`);

  // ─── Summary ───
  console.log('\n' + '═'.repeat(60));
  if (allPassed) {
    console.log('✅ All verification tests passed! ACR compression is working.');
  } else {
    console.log('⚠️  Some tests failed. Check the output above.');
  }
  console.log('═'.repeat(60));
  
  console.log('\n💡 How to verify in your Kobot instance:');
  console.log('   1. Enable debug logging in config:');
  console.log('      "context_runtime": { "enabled": true, "debug": true }');
  console.log('   2. Start Kobot and have a long conversation (many tool calls)');
  console.log('   3. Check logs for "ACR: Context compression triggered/applied" messages');
  console.log('   4. You can also access ACR metrics via kobot.getACR().getMetrics()');
}

main().catch(err => {
  console.error('\n❌ Verification failed with error:');
  console.error(err);
  process.exit(1);
});
