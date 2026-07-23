import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Kobot } from '../src/kobot';
import { createDefaultToolRegistry } from '../src/tools/registry';

describe('Kobot', () => {
  it('should create instance from config', async () => {
    const bot = await Kobot.fromConfig();
    assert.ok(bot);
    assert.ok(bot.tools.length > 0);
    await bot.close();
  });

  it('should list available tools', async () => {
    const bot = await Kobot.fromConfig();
    const tools = bot.tools;
    assert.ok(Array.isArray(tools));
    assert.ok(tools.includes('shell'));
    assert.ok(tools.includes('web_search'));
    assert.ok(tools.includes('write_file'));
    await bot.close();
  });

  it('should manage sessions', async () => {
    const bot = await Kobot.fromConfig();
    
    const sessionsBefore = await bot.listSessions();
    assert.deepStrictEqual(sessionsBefore, []);
    
    await bot.run('test message', { sessionKey: 'test-session' });
    
    const sessionsAfter = await bot.listSessions();
    assert.ok(sessionsAfter.includes('test-session'));
    
    const sessionInfo = await bot.getSessionInfo('test-session');
    assert.ok(sessionInfo);
    assert.strictEqual(sessionInfo!.key, 'test-session');
    
    const deleted = await bot.deleteSession('test-session');
    assert.strictEqual(deleted, true);
    
    const sessionsAfterDelete = await bot.listSessions();
    assert.ok(!sessionsAfterDelete.includes('test-session'));
    
    await bot.close();
  });

  it('should have config accessor', async () => {
    const bot = await Kobot.fromConfig();
    const config = bot.config_;
    assert.ok(config);
    assert.ok(config.agents);
    assert.ok(config.tools);
    await bot.close();
  });
});

describe('ToolRegistry', () => {
  it('should register and retrieve tools', () => {
    const registry = createDefaultToolRegistry();
    assert.ok(registry.has('shell'));
    assert.ok(registry.has('web_search'));
    assert.ok(registry.has('write_file'));
    assert.ok(!registry.has('nonexistent_tool'));
  });

  it('should list tools', () => {
    const registry = createDefaultToolRegistry();
    const tools = registry.list();
    assert.ok(Array.isArray(tools));
    assert.ok(tools.length > 0);
  });

  it('should get agent tools', () => {
    const registry = createDefaultToolRegistry();
    const agentTools = registry.getAgentTools();
    assert.ok(Array.isArray(agentTools));
    assert.ok(agentTools.length > 0);
    agentTools.forEach(tool => {
      assert.ok(tool.name);
      assert.ok(tool.description);
      assert.ok(tool.parameters);
    });
  });
});
