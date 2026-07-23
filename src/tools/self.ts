import { Type } from "@earendil-works/pi-ai";
import { BaseTool, createToolResult, createToolError } from './base';

const MyToolSchema = Type.Object({
  action: Type.Enum({ check: 'check', set: 'set' }, { description: '操作类型: check（查看）或 set（设置）' }),
  key: Type.Optional(Type.String({ description: '要查看或设置的配置项。不传 key 时显示完整配置。' })),
  value: Type.Optional(Type.String({ description: '要设置的新值（仅 set 操作）' })),
});

interface RuntimeVars {
  [key: string]: string;
}

// Scratchpad that persists across turns within the same session
const runtimeVars: RuntimeVars = {};

export class MyTool extends BaseTool<typeof MyTool.parameters> {
  name = 'my';
  label = 'My';
  description = (
    '查看和设置自己的运行时状态。\n' +
    '操作: check（查看）, set（设置）。\n' +
    '- check（不传 key）：查看完整配置概览。\n' +
    '- check（传 key）：查看特定配置项。\n' +
    '- set key value：存储临时变量到 scratchpad（跨 turn 持久化）。'
  );
  static parameters = MyToolSchema;
  parameters = MyTool.parameters;

  async execute(toolCallId: string, params: { action: 'check' | 'set'; key?: string; value?: string }) {
    try {
      if (params.action === 'check') {
        if (!params.key) {
          return createToolResult(this._inspectAll());
        }
        return createToolResult(this._inspect(params.key));
      }

      if (params.action === 'set') {
        if (!params.key) {
          return createToolError("Error: 'key' is required for set action");
        }
        const oldValue = runtimeVars[params.key];
        runtimeVars[params.key] = params.value || '';
        return createToolResult(`Set scratchpad.${params.key} = ${JSON.stringify(params.value)} (was ${JSON.stringify(oldValue || null)})`);
      }

      return createToolError(`Unknown action: ${params.action}`);
    } catch (err) {
      return createToolError(`Error: ${(err as Error).message}`);
    }
  }

  private _inspectAll(): string {
    const info = [
      `node_version: ${JSON.stringify(process.version)}`,
      `platform: ${JSON.stringify(process.platform)}`,
      `arch: ${JSON.stringify(process.arch)}`,
      `cwd: ${JSON.stringify(process.cwd())}`,
    ];

    if (Object.keys(runtimeVars).length > 0) {
      info.push(`scratchpad: ${JSON.stringify(runtimeVars)}`);
    } else {
      info.push('scratchpad: (empty)');
    }

    return info.join('\n');
  }

  private _inspect(key: string): string {
    if (key === 'scratchpad') {
      if (Object.keys(runtimeVars).length === 0) {
        return 'scratchpad is empty';
      }
      return `scratchpad: ${JSON.stringify(runtimeVars)}`;
    }

    if (key in runtimeVars) {
      return `scratchpad.${key}: ${JSON.stringify(runtimeVars[key])}`;
    }

    if (key === 'node_version') return JSON.stringify(process.version);
    if (key === 'platform') return JSON.stringify(process.platform);
    if (key === 'arch') return JSON.stringify(process.arch);
    if (key === 'cwd') return JSON.stringify(process.cwd());

    return `Error: '${key}' not found`;
  }
}

export function getSelfTools(): BaseTool[] {
  return [new MyTool()];
}
