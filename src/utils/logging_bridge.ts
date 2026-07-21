import { logger } from './logger.js';

interface LogRecord {
  levelno: number;
  exc_info?: unknown;
  getMessage(): string;
}

export function redirectLibLogging(name: string, level?: string): void {
  const logLevels = {
    DEBUG: 10,
    INFO: 20,
    WARNING: 30,
    ERROR: 40,
    CRITICAL: 50,
  };

  const targetLevel = level ? logLevels[level.toUpperCase() as keyof typeof logLevels] || 30 : 10;

  const handler = (record: LogRecord): void => {
    if (record.levelno < targetLevel) return;

    const msg = record.getMessage();
    if (record.exc_info) {
      logger.error({ error: record.exc_info }, '[%s] %s', name, msg);
    } else if (record.levelno >= 40) {
      logger.error('[%s] %s', name, msg);
    } else if (record.levelno >= 30) {
      logger.warn('[%s] %s', name, msg);
    } else if (record.levelno >= 20) {
      logger.info('[%s] %s', name, msg);
    } else {
      logger.debug('[%s] %s', name, msg);
    }
  };
}