import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { AgentContextRuntime } from './src/context-runtime';
import type { AgentMessage } from './src/agent';
import {
  getMessageContent,
  estimateMessageTokens,
} from './src/context-runtime/state/message-adapter';

const SESSION_PATH = join(homedir(), '.kobot/sessions/sdk_default.json');

const raw = readFileSync(SESSION_PATH, 'utf-8');
const data = JSON.parse(raw);

const messages: AgentMessage[] = data.entries
  .filter((e: any) => e.type === 'message')
  .map((e: any) => e.message);

console.log('Total messages:', messages.length);

// Test first 5 messages
let totalTokens = 0;
for (let i = 0; i < Math.min(5, messages.length); i++) {
  const msg = messages[i];
  const content = getMessageContent(msg);
  const tokens = estimateMessageTokens(msg);
  totalTokens += tokens;
  console.log(`\n[#${i + 1}] role=${msg.role}`);
  console.log(`  content length: ${content.length}`);
  console.log(`  estimated tokens: ${tokens}`);
  console.log(`  content preview: ${content.slice(0, 100)}`);
  
  // Check what content looks like
  if ('content' in msg) {
    console.log(`  msg.content type: ${typeof (msg as any).content}`);
    if (Array.isArray((msg as any).content)) {
      console.log(`  msg.content items: ${(msg as any).content.map((c: any) => c.type).join(', ')}`);
    }
  }
}

// Calculate total
let allTokens = 0;
let allChars = 0;
for (const msg of messages) {
  allTokens += estimateMessageTokens(msg) + 10; // +10 overhead
  allChars += getMessageContent(msg).length;
}
console.log('\n=== Total ===');
console.log('Total chars:', allChars);
console.log('Total tokens (ACR estimate):', allTokens);
console.log('Rough estimate (chars/3):', Math.ceil(allChars / 3));

// Now test ACR
async function test() {
  const acr = new AgentContextRuntime({
    config: {
      profile: 'coding',
      contextLimit: 128000,
      observability: {
        debug: false, logCompressions: false, logHealthChecks: false,
        emitMetrics: false, keepCompressionHistory: 10, keepStateHistory: 5,
      },
    },
  });

  const check = await acr.checkBeforeModelCall(messages);
  console.log('\n=== ACR Check ===');
  console.log('shouldCompact:', check.shouldCompact);
  console.log('level:', check.level);
  console.log('tokenHealth:', check.tokenHealth);
  
  const health = await acr.getHealth();
  console.log('\n=== Health ===');
  console.log('token.used:', health.token.used);
  console.log('token.ratio:', health.token.ratio);
  console.log('density.density:', health.density.density);
}

test().catch(console.error);
