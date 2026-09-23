/**
 * 交互模式启动横幅与首次使用引导。
 *
 * - 检测已配置 API Key 的提供商，未检测到时给出设置引导
 * - 展示模型 / 会话 / 操作提示，布局简洁
 */
import chalk from 'chalk';
import { getBuiltinProviders, hasProviderConfigured } from '@aipack-ai/agent';
import { APP_NAME, VERSION } from './version.js';

export interface BannerOptions {
  sessionKey: string;
  ephemeral?: boolean;
  /** provider/id 形式的模型标签 */
  modelLabel: string;
  /** 是否为自定义（目录外）模型 */
  customModel?: boolean;
}

export function printStartupBanner(opts: BannerOptions): void {
  const title = chalk.bold(`${APP_NAME} ${VERSION}`);

  const session = chalk.dim(
    `会话: ${opts.sessionKey}${opts.ephemeral ? ' (临时)' : ''}`,
  );
  const modelTag = opts.customModel
    ? `${opts.modelLabel} ${chalk.yellow('(自定义)')}`
    : opts.modelLabel;
  const model = chalk.dim(`模型: ${modelTag}`);

  // 检测 API Key 配置情况
  const apiKeyHint = detectApiKeyHint();

  // 第一行标题；其后两行元信息；空行后提示或引导
  console.log(title);
  console.log(session);
  console.log(model);
  if (apiKeyHint) {
    console.log(apiKeyHint);
  }
  console.log(
    chalk.dim('输入 /help 查看命令，Ctrl+C 中断运行，连按两次退出') +
      '\n',
  );
}

/**
 * 检测 API Key 配置：未检测到任何已配置提供商时返回引导文本，否则返回 null。
 */
function detectApiKeyHint(): string | null {
  const configured = getBuiltinProviders().filter(p =>
    hasProviderConfigured(p.id),
  );

  if (configured.length === 0) {
    const providers = getBuiltinProviders()
      .slice(0, 4)
      .map(p => `  export ${p.envVar}=sk-...`)
      .join('\n');
    return (
      '\n' +
      chalk.yellow('⚠ 未检测到任何 API Key，AI 调用将失败。') +
      '\n' +
      chalk.dim('任选一个提供商设置环境变量：') +
      '\n' +
      providers +
      '\n' +
      chalk.dim('查看全部模型：aipack --list-models') +
      '\n'
    );
  }
  return null;
}
