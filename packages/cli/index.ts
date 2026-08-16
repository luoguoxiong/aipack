/**
 * @aipack-ai/cli - 公共导出
 *
 * CLI 本体经 bin（aipack）使用；此处导出可编程复用的组件
 * （参数解析、工具集、Runtime 构建、运行模式）。
 */
export { parseArgs, printHelp, isValidThinkingLevel } from './src/args.js';
export type { Args, Mode } from './src/args.js';

export { BUILTIN_TOOLS, selectTools, readTool, writeTool, editTool, bashTool } from './src/tools.js';

export {
  loadConfig,
  buildRuntime,
  resolveModel,
  resolveSessionKey,
  listSessionsByRecency,
} from './src/builder.js';
export type { AipackCliConfig, ResolvedModel, SessionChoice, BuiltRuntime } from './src/builder.js';

export { buildInitialMessage } from './src/initial-message.js';

export { select, isDangerousCommand, createToolConfirmHandler } from './src/confirm.js';
export type { SelectOption, ToolConfirmChoice, ToolConfirmHandlerOptions } from './src/confirm.js';

export { runInteractiveMode, pickSessionInteractively } from './src/modes/interactive.js';
export { runPrintMode } from './src/modes/print.js';
export { runJsonMode } from './src/modes/json.js';

export { main } from './src/cli.js';
export { APP_NAME, VERSION, defaultConfigDir, defaultSessionDir } from './src/version.js';
