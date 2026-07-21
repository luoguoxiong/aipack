import axios from 'axios';
import { logger } from '../utils/logger.js';

const NPM_URL = 'https://registry.npmjs.org/nanobot-ai/latest';
const CACHE_TTL_MS = 5 * 60 * 1000;

let cache: { timestamp: number; latest: string | null } | null = null;

export async function checkForUpdate(currentVersion: string): Promise<{
  currentVersion: string;
  latestVersion: string;
  npmUrl: string;
} | null> {
  const now = Date.now();
  if (cache && now - cache.timestamp < CACHE_TTL_MS && cache.latest !== null) {
    const latest = cache.latest;
    if (latest === currentVersion) return null;
    return {
      currentVersion,
      latestVersion: latest,
      npmUrl: 'https://www.npmjs.com/package/nanobot-ai',
    };
  }

  try {
    const resp = await axios.get(NPM_URL, { timeout: 5000, maxRedirects: 5 });
    const latest = resp.data?.version as string | undefined;
    if (!latest) return null;
    cache = { timestamp: now, latest };
    if (latest === currentVersion) return null;
    return {
      currentVersion,
      latestVersion: latest,
      npmUrl: 'https://www.npmjs.com/package/nanobot-ai',
    };
  } catch (err) {
    logger.debug({ err }, 'npm version check failed');
    return null;
  }
}
