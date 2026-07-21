import { logger } from './logger.js';

let _restartRequested = false;
let _restartCallback: (() => Promise<void>) | null = null;

export function requestRestart(): void {
  _restartRequested = true;
  logger.info('Restart requested');
}

export function isRestartRequested(): boolean {
  return _restartRequested;
}

export function setRestartCallback(callback: () => Promise<void>): void {
  _restartCallback = callback;
}

export function getRestartCallback(): (() => Promise<void>) | null {
  return _restartCallback;
}

export async function performRestart(): Promise<void> {
  if (!_restartCallback) {
    logger.warn('No restart callback set, cannot perform restart');
    return;
  }
  try {
    await _restartCallback();
  } catch (err) {
    logger.error({ err }, 'Restart failed');
  }
  _restartRequested = false;
}

export function resetRestartFlag(): void {
  _restartRequested = false;
}