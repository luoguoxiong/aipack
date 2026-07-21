import { logger } from '../utils/logger.js';
import { ApiServer } from '../api/server.js';
import { Nanobot } from '../nanobot.js';

export interface GatewayOptions {
  host?: string;
  port?: number;
  configPath?: string;
  workspace?: string;
  model?: string;
}

let _server: ApiServer | null = null;
let _bot: Nanobot | null = null;

export async function startGateway(opts: GatewayOptions = {}): Promise<void> {
  if (_server) {
    console.log('Gateway is already running');
    return;
  }

  try {
    _bot = await Nanobot.fromConfig({
      configPath: opts.configPath,
      workspace: opts.workspace,
      model: opts.model,
    });

    _server = new ApiServer(_bot, {
      host: opts.host || '127.0.0.1',
      port: opts.port || 8000,
    });

    await _server.start();

    const url = `http://${opts.host || '127.0.0.1'}:${opts.port || 8000}`;
    console.log(`🚀 Gateway server started at ${url}`);
    console.log(`   API endpoints: ${url}/api`);
    console.log(`   OpenAI compatible: ${url}/api/v1/chat/completions`);

    process.on('SIGINT', async () => {
      await stopGateway();
      process.exit(0);
    });
  } catch (err) {
    logger.error({ err }, 'Failed to start gateway');
    process.exit(1);
  }
}

export async function stopGateway(): Promise<void> {
  if (!_server) {
    console.log('Gateway is not running');
    return;
  }

  try {
    await _server.stop();
    if (_bot) {
      await _bot.close();
    }
    _server = null;
    _bot = null;
    console.log('Gateway stopped');
  } catch (err) {
    logger.error({ err }, 'Failed to stop gateway');
  }
}

export function isGatewayRunning(): boolean {
  return _server !== null;
}

export function getGatewayUrl(): string | null {
  if (!_server) return null;
  const config = (_server as any).config;
  return `http://${config.host}:${config.port}`;
}