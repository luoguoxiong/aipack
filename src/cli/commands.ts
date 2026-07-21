import { Command } from 'commander';
import { logger } from '../utils/logger.js';
import { Nanobot } from '../nanobot.js';
import { loadConfig, saveConfig, getConfigDir, getConfigPath } from '../config/loader.js';
import { defaultConfig } from '../config/schema.js';
import { AgentLoop } from '../agent/loop.js';
import { CliChannel } from '../channels/cli.js';
import { MessageBus } from '../bus/queue.js';
import { ApiServer } from '../api/server.js';

const program = new Command();

program
  .name('nanobot')
  .description('nanobot - A lightweight personal AI assistant framework')
  .version('0.2.2');

program
  .command('run')
  .description('Run a single message and get a response')
  .argument('<message>', 'Message to send')
  .option('-m, --model <model>', 'Model to use')
  .option('-p, --model-preset <preset>', 'Model preset to use')
  .option('-s, --session <session>', 'Session key')
  .option('-c, --config <path>', 'Config file path')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('-e, --ephemeral', 'Do not persist session history')
  .option('--stream', 'Stream the response')
  .action(async (message: string, opts: Record<string, unknown>) => {
    try {
      const bot = await Nanobot.fromConfig({
        configPath: opts.config as string,
        workspace: opts.workspace as string,
        model: opts.model as string,
        modelPreset: opts.modelPreset as string,
      });

      if (opts.stream) {
        for await (const event of bot.stream(message, {
          sessionKey: opts.session as string,
          ephemeral: !!opts.ephemeral,
        })) {
          if (event.type === 'text_delta' && event.content) {
            process.stdout.write(event.content);
          } else if (event.type === 'run_completed') {
            console.log();
          }
        }
      } else {
        const result = await bot.run(message, {
          sessionKey: opts.session as string,
          ephemeral: !!opts.ephemeral,
        });
        console.log(result.content);
      }

      await bot.close();
    } catch (err) {
      logger.error({ err }, 'Error running command');
      process.exit(1);
    }
  });

program
  .command('chat')
  .description('Start an interactive chat session')
  .option('-m, --model <model>', 'Model to use')
  .option('-p, --model-preset <preset>', 'Model preset to use')
  .option('-s, --session <session>', 'Session key')
  .option('-c, --config <path>', 'Config file path')
  .option('-w, --workspace <path>', 'Workspace directory')
  .action(async (opts: Record<string, unknown>) => {
    try {
      const config = await loadConfig(opts.config as string);
      const bus = new MessageBus();
      const loop = new AgentLoop({ config, bus });
      const cliChannel = new CliChannel(bus, { name: 'cli', streaming: true });

      if (opts.workspace) {
        config.agents.defaults.workspace = opts.workspace as string;
      }
      if (opts.model) {
        config.agents.defaults.model = opts.model as string;
        config.agents.defaults.provider = 'auto';
      }
      if (opts.modelPreset) {
        config.agents.defaults.model_preset = opts.modelPreset as string;
      }

      await cliChannel.start();
      loop.start();

      console.log('nanobot chat mode. Type /exit to quit.\n');

      process.on('SIGINT', async () => {
        console.log('\nShutting down...');
        await cliChannel.stop();
        loop.stop();
        process.exit(0);
      });
    } catch (err) {
      logger.error({ err }, 'Error starting chat');
      process.exit(1);
    }
  });

program
  .command('config')
  .description('Manage configuration')
  .addCommand(
    new Command('init')
      .description('Initialize default config')
      .option('-f, --force', 'Overwrite existing config')
      .action(async (opts: Record<string, unknown>) => {
        try {
          const configPath = getConfigPath();
          const fs = await import('fs/promises');
          const path = await import('path');
          
          try {
            await fs.access(configPath);
            if (!opts.force) {
              console.log(`Config already exists at ${configPath}`);
              console.log('Use --force to overwrite.');
              return;
            }
          } catch {
            // Config doesn't exist, create it
          }

          const config = defaultConfig();
          await fs.mkdir(path.dirname(configPath), { recursive: true });
          await fs.writeFile(configPath, JSON.stringify(config, null, 2));
          console.log(`Config initialized at ${configPath}`);
        } catch (err) {
          logger.error({ err }, 'Error initializing config');
          process.exit(1);
        }
      }),
  )
  .addCommand(
    new Command('path')
      .description('Print config file path')
      .action(() => {
        console.log(getConfigPath());
      }),
  )
  .addCommand(
    new Command('show')
      .description('Show current config')
      .option('-c, --config <path>', 'Config file path')
      .action(async (opts: Record<string, unknown>) => {
        try {
          const config = await loadConfig(opts.config as string);
          console.log(JSON.stringify(config, null, 2));
        } catch (err) {
          logger.error({ err }, 'Error loading config');
          process.exit(1);
        }
      }),
  );

program
  .command('sessions')
  .description('Manage sessions')
  .addCommand(
    new Command('list')
      .description('List all sessions')
      .option('-c, --config <path>', 'Config file path')
      .action(async (opts: Record<string, unknown>) => {
        try {
          const bot = await Nanobot.fromConfig({ configPath: opts.config as string });
          const sessions = await bot.listSessions();
          if (sessions.length === 0) {
            console.log('No sessions found.');
          } else {
            console.log(`Sessions (${sessions.length}):`);
            for (const s of sessions) {
              console.log(`  - ${s}`);
            }
          }
          await bot.close();
        } catch (err) {
          logger.error({ err }, 'Error listing sessions');
          process.exit(1);
        }
      }),
  )
  .addCommand(
    new Command('delete')
      .description('Delete a session')
      .argument('<session>', 'Session key')
      .option('-c, --config <path>', 'Config file path')
      .action(async (session: string, opts: Record<string, unknown>) => {
        try {
          const bot = await Nanobot.fromConfig({ configPath: opts.config as string });
          const deleted = await bot.deleteSession(session);
          if (deleted) {
            console.log(`Session deleted: ${session}`);
          } else {
            console.log(`Session not found: ${session}`);
          }
          await bot.close();
        } catch (err) {
          logger.error({ err }, 'Error deleting session');
          process.exit(1);
        }
      }),
  );

program
  .command('tools')
  .description('List available tools')
  .option('-c, --config <path>', 'Config file path')
  .action(async (opts: Record<string, unknown>) => {
    try {
      const bot = await Nanobot.fromConfig({ configPath: opts.config as string });
      const tools = bot.tools;
      console.log(`Available tools (${tools.length}):`);
      for (const tool of tools) {
        console.log(`  - ${tool}`);
      }
      await bot.close();
    } catch (err) {
      logger.error({ err }, 'Error listing tools');
      process.exit(1);
    }
  });

program
  .command('webui')
  .description('Start the WebUI server')
  .option('-p, --port <port>', 'WebUI port', '8000')
  .option('-h, --host <host>', 'Host to bind to', '127.0.0.1')
  .option('-c, --config <path>', 'Config file path')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('-m, --model <model>', 'Model to use')
  .option('--no-open', 'Do not open browser automatically')
  .action(async (opts: Record<string, unknown>) => {
    try {
      const bot = await Nanobot.fromConfig({
        configPath: opts.config as string,
        workspace: opts.workspace as string,
        model: opts.model as string,
      });

      const server = new ApiServer(bot, {
        host: opts.host as string,
        port: parseInt(opts.port as string, 10),
      });

      await server.start();

      const url = `http://${opts.host}:${opts.port}`;
      console.log(`\n🚀 WebUI server started at ${url}`);
      console.log(`   API endpoints: ${url}/api`);
      console.log(`   OpenAI compatible: ${url}/api/v1/chat/completions`);

      if (!opts.noOpen) {
        const { default: open } = await import('open');
        open(url);
      }

      process.on('SIGINT', async () => {
        console.log('\nShutting down...');
        await server.stop();
        await bot.close();
        process.exit(0);
      });
    } catch (err) {
      logger.error({ err }, 'Error starting WebUI');
      process.exit(1);
    }
  });

export function main(): void {
  program.parse(process.argv);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
