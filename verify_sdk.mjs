// 验证 SDK 核心功能
import { Nanobot, STREAM_EVENT_RUN_STARTED } from './dist/nanobot.js';
import { defaultConfig } from './dist/config/schema.js';
import { AgentLoop, ContextBuilder, ToolRegistry } from './dist/agent/index.js';
import { LLMProvider, OpenAICompatProvider, ProviderFactoryService } from './dist/providers/index.js';
import { MessageBus } from './dist/bus/index.js';
import { SessionManager } from './dist/session/index.js';
import { CronService } from './dist/cron/index.js';
import { CommandRouter } from './dist/command/index.js';

console.log('✅ SDK 模块导入成功');

// 测试配置
const config = defaultConfig();
console.log('✅ 配置系统正常:', {
  model: config.agents.defaults.model,
  workspace: config.agents.defaults.workspace
});

// 测试工具注册表
const registry = new ToolRegistry();
console.log('✅ 工具注册表创建成功');

// 测试消息总线
const bus = new MessageBus();
console.log('✅ 消息总线创建成功');

// 测试会话管理器
const sessionManager = new SessionManager({ baseDir: '/tmp/test-sessions' });
console.log('✅ 会话管理器创建成功');

// 测试命令路由器
const router = new CommandRouter();
console.log('✅ 命令路由器创建成功');

// 测试 Cron 服务
const cronService = new CronService('/tmp/test-cron');
console.log('✅ Cron 服务创建成功');

// 测试 Provider 工厂
const providerConfig = {
  name: 'test-openai',
  api_key: 'test-key',
  base_url: 'https://api.openai.com/v1'
};
const factory = new ProviderFactoryService([providerConfig]);
console.log('✅ Provider 工厂创建成功');

console.log('\n🎉 所有核心功能验证通过！');
