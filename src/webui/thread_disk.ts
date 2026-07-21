import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';
import { getProjectConfigDir } from '../config/paths.js';

export interface ThreadDiskMessage {
  id: string;
  role: string;
  content: string;
  created_at: string;
  [key: string]: unknown;
}

export interface ThreadDiskSession {
  key: string;
  title: string;
  created_at: string;
  updated_at: string;
  messages: ThreadDiskMessage[];
  metadata: Record<string, unknown>;
}

const THREADS_DIR = path.join(getProjectConfigDir(), 'webui', 'threads');

function getThreadsDir(): string {
  fs.mkdirSync(THREADS_DIR, { recursive: true });
  return THREADS_DIR;
}

function safeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9._:-]/g, '_');
}

function threadFilePath(key: string): string {
  return path.join(getThreadsDir(), `${safeKey(key)}.json`);
}

export function readThread(key: string): ThreadDiskSession | null {
  const filePath = threadFilePath(key);
  if (!fs.existsSync(filePath)) return null;
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as ThreadDiskSession;
  } catch (err) {
    logger.warn({ err, key }, 'Failed to read thread');
    return null;
  }
}

export function writeThread(
  key: string,
  session: Omit<ThreadDiskSession, 'key'>,
): ThreadDiskSession {
  const filePath = threadFilePath(key);
  const now = new Date().toISOString();
  const data: ThreadDiskSession = {
    key,
    ...session,
    created_at: session.created_at || now,
    updated_at: now,
  };
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    return data;
  } catch (err) {
    logger.error({ err, key }, 'Failed to write thread');
    throw err;
  }
}

export function deleteThread(key: string): boolean {
  const filePath = threadFilePath(key);
  if (!fs.existsSync(filePath)) return false;
  try {
    fs.unlinkSync(filePath);
    logger.info({ key }, 'Thread deleted');
    return true;
  } catch (err) {
    logger.warn({ err, key }, 'Failed to delete thread');
    return false;
  }
}

export function listThreads(): ThreadDiskSession[] {
  const dir = getThreadsDir();
  try {
    const files = fs.readdirSync(dir);
    const threads: ThreadDiskSession[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const filePath = path.join(dir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const thread = JSON.parse(content) as ThreadDiskSession;
        threads.push(thread);
      } catch (err) {
        logger.warn({ err, file }, 'Failed to read thread file');
      }
    }
    return threads.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  } catch (err) {
    logger.warn({ err }, 'Failed to list threads');
    return [];
  }
}

export function appendMessage(
  key: string,
  message: ThreadDiskMessage,
): ThreadDiskSession | null {
  const thread = readThread(key);
  if (!thread) return null;
  thread.messages.push(message);
  thread.updated_at = new Date().toISOString();
  return writeThread(key, thread);
}
