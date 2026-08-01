import { Type } from "../ai";
import { BaseTool, createToolResult, createToolError } from './base';

export class EchoTool extends BaseTool<typeof EchoTool.parameters> {
  name = 'echo';
  label = 'Echo';
  description = '回显提供的文本';
  static parameters = Type.Object({
    text: Type.String({ description: '要回显的文本' }),
  });
  parameters = EchoTool.parameters;

  async execute(toolCallId: string, params: { text: string }) {
    return createToolResult(params.text);
  }
}

export class GetTimeTool extends BaseTool<typeof GetTimeTool.parameters> {
  name = 'get_time';
  label = 'Get Time';
  description = '获取当前时间和日期';
  static parameters = Type.Object({});
  parameters = GetTimeTool.parameters;

  async execute(toolCallId: string) {
    const now = new Date();
    return createToolResult(`当前时间：${now.toLocaleString()}\nUTC：${now.toISOString()}`);
  }
}

export class CalculateTool extends BaseTool<typeof CalculateTool.parameters> {
  name = 'calculate';
  label = 'Calculate';
  description = '执行数学计算';
  static parameters = Type.Object({
    expression: Type.String({ description: '要计算的数学表达式' }),
  });
  parameters = CalculateTool.parameters;

  async execute(toolCallId: string, params: { expression: string }) {
    try {
      const safeExpr = params.expression.replace(/[^0-9+\-*/().\s]/g, '');
      const result = new Function(`"use strict"; return (${safeExpr})`)();
      return createToolResult(`${safeExpr} = ${result}`);
    } catch (err) {
      return createToolError(`Error: ${(err as Error).message}`);
    }
  }
}

export class EncodeBase64Tool extends BaseTool<typeof EncodeBase64Tool.parameters> {
  name = 'encode_base64';
  label = 'Encode Base64';
  description = '将文本编码为 Base64';
  static parameters = Type.Object({
    text: Type.String({ description: '要编码的文本' }),
  });
  parameters = EncodeBase64Tool.parameters;

  async execute(toolCallId: string, params: { text: string }) {
    const encoded = Buffer.from(params.text).toString('base64');
    return createToolResult(encoded);
  }
}

export class DecodeBase64Tool extends BaseTool<typeof DecodeBase64Tool.parameters> {
  name = 'decode_base64';
  label = 'Decode Base64';
  description = '解码 Base64 文本';
  static parameters = Type.Object({
    text: Type.String({ description: '要解码的 Base64 文本' }),
  });
  parameters = DecodeBase64Tool.parameters;

  async execute(toolCallId: string, params: { text: string }) {
    try {
      const decoded = Buffer.from(params.text, 'base64').toString('utf-8');
      return createToolResult(decoded);
    } catch (err) {
      return createToolError(`Error: ${(err as Error).message}`);
    }
  }
}

export function getUtilityTools(): BaseTool[] {
  return [
    new EchoTool(),
    new GetTimeTool(),
    new CalculateTool(),
    new EncodeBase64Tool(),
    new DecodeBase64Tool(),
  ];
}
