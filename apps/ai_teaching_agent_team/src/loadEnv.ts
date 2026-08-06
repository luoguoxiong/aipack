/**
 * apps/ai_teaching_agent_team/src/loadEnv.ts
 *
 * 零依赖 .env 加载器(Node 原生不读取 .env 文件)。
 * 启动时从本模块所在目录向上查找 .env,解析后注入 process.env。
 *
 * 优先级(多层容错):真实 shell 环境变量 > .env 文件 > 默认值。
 *   → 已存在于 process.env 的变量不会被 .env 覆盖(便于 CI/生产用真实 env 覆盖)。
 *
 * 支持:注释、空行、`export ` 前缀、单/双引号、双引号内 \n 转义、行内 # 注释。
 * 该模块在被 import 时即执行副作用,故应在 config.ts 顶部最先导入。
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 从当前目录向上查找 .env,最多回溯 5 层 */
function findEnvFile(): string | null {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** 解析单行,返回 [key, value] 或 null */
function parseLine(line: string): [string, string] | null {
  // 去掉行尾换行,保留前导空格判断
  const trimmed = line.replace(/\r$/, '');
  if (!trimmed.trim() || trimmed.trim().startsWith('#')) return null;

  // KEY = VALUE,可选 export 前缀
  const m = trimmed.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!m) return null;
  const key = m[1];
  let value = m[2];

  // 去掉行内注释(仅当 # 前面是空白且值未处于引号内时;简化:仅对无引号值处理)
  if (!value.startsWith('"') && !value.startsWith("'")) {
    const hashIdx = value.indexOf(' #');
    if (hashIdx !== -1) value = value.slice(0, hashIdx);
    value = value.trim();
  } else {
    // 引号值:剥离首尾引号,双引号支持 \n \t \\ \" 转义
    const quote = value[0];
    const end = value.lastIndexOf(quote);
    if (end > 0) {
      let inner = value.slice(1, end);
      if (quote === '"') {
        inner = inner
          .replace(/\\n/g, '\n')
          .replace(/\\t/g, '\t')
          .replace(/\\r/g, '\r')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
      }
      value = inner;
    }
  }
  return [key, value];
}

/** 加载 .env(幂等,可多次调用) */
export function loadEnvFile(): { loaded: number; path: string | null } {
  const file = findEnvFile();
  if (!file) return { loaded: 0, path: null };

  let content: string;
  try {
    content = readFileSync(file, 'utf-8');
  } catch (err) {
    console.warn(`[loadEnv] 读取 ${file} 失败:`, (err as Error).message);
    return { loaded: 0, path: file };
  }

  let loaded = 0;
  for (const line of content.split('\n')) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    // 不覆盖已存在的真实环境变量(优先级:shell env > .env)
    if (process.env[key] === undefined) {
      process.env[key] = value;
      loaded++;
    }
  }
  return { loaded, path: file };
}

// ── 副作用:模块加载时即执行 ──────────────────────────────────────
const result = loadEnvFile();
if (result.loaded > 0) {
  // 仅在调试时打印一行,避免泄露具体值
  console.log(`[loadEnv] 已从 ${result.path} 加载 ${result.loaded} 个环境变量`);
}
