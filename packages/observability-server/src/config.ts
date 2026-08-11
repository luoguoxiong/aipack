/**
 * apps/observability-server/src/config.ts
 *
 * 环境变量解析:
 *   PORT        收集服务监听端口(默认 8787)
 *   DB_PATH     SQLite 文件路径(默认 ./.aipack/collector.db)
 *   OBS_APPS    可选:启动时种入的 app 白名单,格式 appId:appSecret,多应用逗号分隔
 *               (已存在则跳过;后续应用改由面板动态创建)
 *   ADMIN_USER  面板登录用户名(默认 admin)
 *   ADMIN_PASS  面板登录密码(缺省自动生成并打印,首次启动注意保存)
 *   STATIC_DIR  可选:面板静态文件目录(构建产物)。缺省自动定位到本包 dist/public
 *               (即 `pnpm --filter @aipack/observability-server build` 的产出),
 *               存在则 GET / 直接返回面板
 */
import './loadEnv.js'; // 副作用:最先加载 .env(必须在读取 process.env 之前)
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface CollectorConfig {
  port: number;
  dbPath: string;
  /** 启动时种入的静态白名单（appId -> appSecret），可为空 */
  seedApps: Record<string, string>;
  /** 面板登录凭证（面板开启条件） */
  admin: { username: string; password: string };
  /** 面板静态文件目录（可选） */
  staticDir?: string;
}

export function loadConfig(): CollectorConfig {
  const port = Number(process.env.PORT) || 8787;
  const dbPath = process.env.DB_PATH || '.aipack/collector.db';
  const seedApps = parseApps(process.env.OBS_APPS || '');
  const staticDir = process.env.STATIC_DIR || defaultStaticDir();
  const admin = resolveAdmin();
  if (!staticDir) {
    console.log(
      '[observability-server] 未找到面板构建产物(dist/public)。运行 pnpm --filter @aipack/observability-server build 或配置 STATIC_DIR 后即可通过 http://localhost:' +
        port +
        ' 访问面板。',
    );
  }
  return { port, dbPath, seedApps, admin, staticDir };
}

/**
 * 定位本包内嵌面板的构建产物目录：
 * 优先显式 STATIC_DIR；缺省时在 dist/public（构建产物）与 web 上级目录中探测。
 */
function defaultStaticDir(): string | undefined {
  const candidates = [
    // dev(tsx 跑 src)：packages/observability-server/src/config.ts → ../../dist/public
    fileURLToPath(new URL('../../dist/public/', import.meta.url)),
    // 构建产物：packages/observability-server/dist/config.js → ../dist/public
    fileURLToPath(new URL('../dist/public/', import.meta.url)),
  ];
  return candidates.find((p) => existsSync(p));
}

/** 解析面板登录凭证；ADMIN_PASS 缺省自动生成（多层容错：显式配置 > 自动生成） */
function resolveAdmin(): { username: string; password: string } {
  const username = (process.env.ADMIN_USER || 'admin').trim();
  let password = process.env.ADMIN_PASS;
  if (!password) {
    password = `aipack-${randomBytes(6).toString('hex')}`;
    console.log(
      `[observability-server] 未配置 ADMIN_PASS，已自动生成面板密码：${password}\n` +
        '  → 面板地址 http://localhost:' +
        (process.env.PORT || 8787) +
        ' ，用户名 ' +
        username,
    );
  }
  return { username, password };
}

/** 解析 "app1:secret1,app2:secret2" → { app1: 'secret1', app2: 'secret2' } */
export function parseApps(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(',')) {
    const idx = part.indexOf(':');
    if (idx <= 0) continue;
    const appId = part.slice(0, idx).trim();
    const secret = part.slice(idx + 1).trim();
    if (appId && secret) out[appId] = secret;
  }
  return out;
}
