import pino from 'pino';
import fs from 'fs';
import path from 'path';
import type { LoggingConfig } from '../config/schema';

let loggerInstance: pino.Logger;

function createPinoLogger(config?: Partial<LoggingConfig>): pino.Logger {
  const level = config?.level || process.env.KOBOT_LOG_LEVEL || 'info';
  const consoleEnabled = (config?.console_enabled ?? true) && process.env.KOBOT_LOG_CONSOLE !== 'false';
  const filePath = config?.file_path;
  const rotationEnabled = config?.rotation?.enabled !== false;
  const separateErrorLog = config?.separate_error_log !== false;

  const streams: Array<{ stream: any; level: string }> = [];

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

    if (rotationEnabled) {
      const rotationConfig = config?.rotation;
      const maxSize = rotationConfig?.max_size || '10M';
      const maxFiles = rotationConfig?.max_files || 30;
      const compress = rotationConfig?.compress !== false;
      
      streams.push({
        stream: pino.transport({
          target: 'pino-roll',
          options: {
            file: filePath,
            size: maxSize,
            maxFiles,
            compress,
            mkdir: true,
          },
        }),
        level,
      });

      if (separateErrorLog) {
        const ext = path.extname(filePath);
        const baseName = path.basename(filePath, ext);
        const errorFilePath = path.join(logDir, `${baseName}-error${ext}`);
        
        streams.push({
          stream: pino.transport({
            target: 'pino-roll',
            options: {
              file: errorFilePath,
              size: maxSize,
              maxFiles,
              compress,
              mkdir: true,
            },
          }),
          level: 'error',
        });
      }
    } else {
      streams.push({
        stream: fs.createWriteStream(filePath, { flags: 'a' }),
        level,
      });

      if (separateErrorLog) {
        const ext = path.extname(filePath);
        const baseName = path.basename(filePath, ext);
        const errorFilePath = path.join(logDir, `${baseName}-error${ext}`);
        streams.push({
          stream: fs.createWriteStream(errorFilePath, { flags: 'a' }),
          level: 'error',
        });
      }
    }
  }

  return pino({ level }, pino.multistream(streams));
}

export function createLogger(config?: Partial<LoggingConfig>): pino.Logger {
  loggerInstance = createPinoLogger(config);
  return loggerInstance;
}

loggerInstance = pino({
  level: process.env.KOBOT_LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV !== 'production' ? {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
    },
  } : undefined,
});

export const logger = new Proxy(loggerInstance, {
  get(target, prop) {
    if (prop === '__esModule') return false;
    return (loggerInstance as any)[prop];
  },
});

export default logger;