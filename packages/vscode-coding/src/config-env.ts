/**
 * 配置纯函数模块（不依赖 vscode 与 aipack），便于单元测试。
 *
 * syncApiKeysToEnv 接受 providers 参数（含 envVar 字段），由调用方（config.ts）
 * 从 aipack 的 BUILTIN_PROVIDERS 传入。这样本模块可在无 aipack 运行时
 * 的环境下被测试。
 */

/** provider 的环境变量映射信息（BUILTIN_PROVIDERS 的子集形状） */
export interface ProviderEnvInfo {
  id: string;
  envVar: string;
}

/** 把 ~/... 展开为绝对路径；非 ~ 开头原样返回 */
export function expandHome(p: string): string {
  if (!p) return p;
  if (p === '~') return process.env.HOME ?? '';
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return (process.env.HOME ?? '') + p.slice(1);
  }
  return p;
}

/**
 * 把 settings 中的 apiKey（provider id → key）按 providers 的 envVar 写入 env。
 * 只写入非空 key；空值不覆盖已存在的 env（避免误清空环境变量方式配置的 key）。
 *
 * 返回实际写入的 { envVar: value } 映射，便于调试/日志。
 */
export function syncApiKeysToEnv(
  apiKeys: Record<string, string>,
  providers: ProviderEnvInfo[],
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const written: Record<string, string> = {};
  for (const provider of providers) {
    const key = apiKeys[provider.id];
    if (key) {
      env[provider.envVar] = key;
      written[provider.envVar] = key;
    }
  }
  return written;
}
