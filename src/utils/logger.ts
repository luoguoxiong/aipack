import pino from 'pino';
import fs from 'fs';
import path from 'path';
import type { LoggingConfig } from '../config/schema.js';

let loggerInstance: pino.Logger;

function createPinoLogger(config?: Partial<LoggingConfig>): pino.Logger {
  const level = config?.level || process.env.NANOBOT_LOG_LEVEL || 'info';
  const consoleEnabled = config?.console_enabled ?? true;
  const filePath = config?.file_path;

  const streams: Array<{ stream: pino.DestinationStream; level: string }> = [];

  if (consoleEnabled) {
    if (process.env.NODE_ENV !== 'production') {
      streams.push({
        stream: pino.transport({
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        }),
        level,
      });
    } else {
      streams.push({
        stream: process.stdout,
        level,
      });
    }
  }

  if (filePath) {
    const logDir = path.dirname(filePath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    streams.push({
      stream: fs.createWriteStream(filePath, { flags: 'a' }),
      level,
    });
  }

  return pino({ level }, pino.multistream(streams));
}

export function createLogger(config?: Partial<LoggingConfig>): pino.Logger {
  loggerInstance = createPinoLogger(config);
  return loggerInstance;
}

// Create default logger (console only)
loggerInstance = pino({
  level: process.env.NANOBOT_LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV !== 'production' ? {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
    },
  } : undefined,
});

// Export a proxy that always points to the current logger instance
export const logger = new Proxy(loggerInstance, {
  get(target, prop) {
    if (prop === '__esModule') return false;
    return (loggerInstance as any)[prop];
  },
});

export default logger;
