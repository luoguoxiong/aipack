/**
 * packages/agentpack-cli/src/init-config.ts
 *
 * 初始化配置文件向导：交互式生成项目级 agentpack.config.js 或全局 ~/.agentpack/config.json。
 * 步骤：确定目标位置 → 选择提供商 → 选择模型 → 可选 workspace / systemPrompt → 写入文件。
 * 项目级 .js 按当前目录 package.json 的 type 决定 ESM（export default）或 CJS（module.exports）语法。
 * 会话 key 无需配置：每次启动 CLI 时自动生成。
 * 交互风格对齐 src/setup-wizard.ts。
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { getBuiltinModels, getBuiltinProviders, type AiModel } from 'agentpack';
import type { RawFileConfig } from './config';
import { getConfigPath } from './config';

/** init 命令选项 */
export interface InitConfigOptions {
  /** 目标位置：local 项目级 / global 全局；缺省时交互选择 */
  target?: 'local' | 'global';
  /** 目标文件已存在时跳过确认 */
  force?: boolean;
}

/** 向导结果 */
export interface InitResult {
  filePath: string;
  provider: string;
  model: string;
}

interface WizardProvider {
  id: string;
  name: string;
  models: AiModel[];
}

function question(rl: readline.Interface, query: string): Promise<string> {
  return new Promise((resolve) => rl.question(query, resolve));
}

function confirmAction(rl: readline.Interface, message: string): Promise<boolean> {
  return question(rl, `${message} (y/N): `).then(
    (answer) => answer.trim().toLowerCase() === 'y',
  );
}

/** 列出内置提供商及其模型（按名称排序） */
function listWizardProviders(): WizardProvider[] {
  const meta = new Map(getBuiltinProviders().map((p) => [p.id, p.name]));
  const byProvider = new Map<string, AiModel[]>();
  for (const m of getBuiltinModels()) {
    if (!byProvider.has(m.provider)) byProvider.set(m.provider, []);
    byProvider.get(m.provider)!.push(m);
  }
  return [...byProvider.entries()]
    .map(([id, models]) => ({ id, name: meta.get(id) ?? id, models }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** 项目级配置文件路径 */
function getProjectConfigPath(): string {
  return path.join(process.cwd(), 'agentpack.config.js');
}

/** 检测当前目录模块类型：package.json 中 type=module 为 ESM，否则 CJS */
function detectModuleType(): 'esm' | 'cjs' {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'),
    ) as { type?: string };
    return pkg.type === 'module' ? 'esm' : 'cjs';
  } catch {
    return 'cjs';
  }
}

// ─── 交互选择 ──────────────────────────────────────────────────────

async function selectTarget(rl: readline.Interface): Promise<'local' | 'global'> {
  console.log('配置文件目标位置：');
  console.log('');
  console.log(`  1. 项目级: ${getProjectConfigPath()}（当前目录，随项目分发，可用 JS 写逻辑）`);
  console.log(`  2. 全局:   ${getConfigPath()}（用户级，所有项目生效）`);
  console.log('  0. 退出');

  while (true) {
    const answer = await question(rl, '\n请选择 (1-2 / 0): ');
    const trimmed = answer.trim().toLowerCase();
    if (trimmed === '0') {
      console.log('\n已退出，未写入配置文件。');
      process.exit(0);
    }
    if (trimmed === '1') return 'local';
    if (trimmed === '2') return 'global';
    console.log('❌ 无效选择，请重试。');
  }
}

async function selectProvider(rl: readline.Interface): Promise<WizardProvider> {
  const providers = listWizardProviders();

  console.log('可用的模型提供商：');
  console.log('');
  providers.forEach((p, i) => {
    console.log(
      `  ${i + 1}. ${p.name} (${p.id}) - 推荐模型: ${p.models[0]?.id}，共 ${p.models.length} 个`,
    );
  });
  console.log('  0. 退出');

  while (true) {
    const answer = await question(rl, '\n请选择 (1-N / 0): ');
    const trimmed = answer.trim().toLowerCase();
    if (trimmed === '0') {
      console.log('\n已退出，未写入配置文件。');
      process.exit(0);
    }
    const choice = parseInt(trimmed, 10);
    if (!isNaN(choice) && choice >= 1 && choice <= providers.length) {
      return providers[choice - 1];
    }
    console.log('❌ 无效选择，请重试。');
  }
}

async function selectModel(
  rl: readline.Interface,
  provider: WizardProvider,
): Promise<AiModel> {
  console.log(`\n${provider.name} 可用模型：`);
  console.log('');
  provider.models.forEach((m, i) => {
    console.log(`  ${i + 1}. ${m.id}${m.name ? ` - ${m.name}` : ''}`);
  });

  while (true) {
    const answer = await question(
      rl,
      `\n请选择模型 (1-${provider.models.length}，回车使用默认 ${provider.models[0]?.id}): `,
    );
    const trimmed = answer.trim();
    if (!trimmed) return provider.models[0];
    const choice = parseInt(trimmed, 10);
    if (!isNaN(choice) && choice >= 1 && choice <= provider.models.length) {
      return provider.models[choice - 1];
    }
    console.log('❌ 无效选择，请重试。');
  }
}

/** 可选输入：直接回车返回 undefined */
async function inputOptional(
  rl: readline.Interface,
  label: string,
  hint: string,
): Promise<string | undefined> {
  const answer = await question(rl, `${label}${hint ? `（${hint}）` : ''}（回车跳过）: `);
  const trimmed = answer.trim();
  return trimmed || undefined;
}

/** 生成 .js 配置内容：类型引导注释 + 已配置字段 + 未配置字段的示例注释 */
function buildJsConfigContent(config: RawFileConfig): string {
  const moduleType = detectModuleType();
  const lines: string[] = [];

  lines.push('/**');
  lines.push(' * agentpack 配置文件（字段均可选，可直接写 JS 逻辑）');
  lines.push(' * 取消注释并按需修改下面的示例字段；保存后运行 "agentpack chat" 生效。');
  lines.push(" * @type {import('agentpack-cli').AgentpackConfigFile}");
  lines.push(' */');
  lines.push(moduleType === 'esm' ? 'export default {' : 'module.exports = {');

  const shown = new Set<string>();
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined) continue;
    lines.push(`  ${key}: ${JSON.stringify(value)},`);
    shown.add(key);
  }

  const examples: Array<[string, string]> = [
    ['systemPrompt', '"你是一个简洁的 AI 助手"'],
    ['workspace', '"~/my-workspace"'],
  ];
  const missing = examples.filter(([k]) => !shown.has(k));
  if (missing.length > 0) {
    lines.push('');
    lines.push('  // 可选字段示例：');
    for (const [k, v] of missing) lines.push(`  // ${k}: ${v},`);
  }
  if (!shown.has('sessions')) {
    lines.push('  // sessions: {');
    lines.push('  //   enabled: true,');
    lines.push('  //   baseDir: "./sessions",');
    lines.push('  //   maxAge: 30,');
    lines.push('  // },');
  }
  lines.push('');
  lines.push('  // 高级：透传给 agentpack Runtime 的选项（.js 配置可 import 模块/类实例）');
  lines.push('  // tools: [],');
  lines.push('  // extensions: [],');
  lines.push('  // transformers: [],');
  lines.push('  // pipeline: undefined,');
  lines.push('  // sessionStorage: undefined,');

  lines.push('};');
  return lines.join('\n') + '\n';
}

// ─── 主流程 ────────────────────────────────────────────────────────

export async function runInitConfig(
  options: InitConfigOptions = {},
): Promise<InitResult> {
  if (!process.stdin.isTTY) {
    console.error('❌ 初始化向导需要在交互式终端运行。');
    console.error('   请直接在终端执行 "agentpack init"，');
    console.error('   或手动创建 agentpack.config.json / ~/.agentpack/config.json 配置文件。');
    process.exit(1);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log('');
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║   ⚙️  agentpack 初始化配置文件向导           ║');
    console.log('╚══════════════════════════════════════════════╝');
    console.log('');

    // 1. 确定目标路径
    let targetPath =
      options.target === 'local'
        ? getProjectConfigPath()
        : options.target === 'global'
          ? getConfigPath()
          : undefined;
    if (!targetPath) {
      const target = await selectTarget(rl);
      targetPath =
        target === 'local' ? getProjectConfigPath() : getConfigPath();
    }

    // 2. 覆盖确认
    if (fs.existsSync(targetPath) && !options.force) {
      const confirmed = await confirmAction(
        rl,
        `⚠️  配置文件已存在：${targetPath}\n   确定覆盖吗？`,
      );
      if (!confirmed) {
        console.log('已取消，未写入配置文件。');
        process.exit(0);
      }
    }

    // 3. 交互配置
    const provider = await selectProvider(rl);
    const model = await selectModel(rl, provider);
    const workspace = await inputOptional(rl, '工作区路径', `默认 ${process.cwd()}`);
    const systemPrompt = await inputOptional(rl, '系统提示词', '');

    // 4. 组装并写入（undefined 字段在序列化时自动省略）
    const config: RawFileConfig = {
      provider: provider.id,
      model: model.id,
      workspace,
      systemPrompt,
    };
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });

    const isJs = path.extname(targetPath).toLowerCase() === '.js';
    const content = isJs
      ? buildJsConfigContent(config)
      : `${JSON.stringify(config, null, 2)}\n`;
    fs.writeFileSync(targetPath, content, 'utf-8');

    console.log(`\n✅ 配置文件已生成: ${targetPath}`);
    console.log(`   提供商: ${provider.id}`);
    console.log(`   模型:   ${model.id}`);
    console.log('   运行 "agentpack chat" 使用该配置。');

    return { filePath: targetPath, provider: provider.id, model: model.id };
  } finally {
    rl.close();
  }
}
