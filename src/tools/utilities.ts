import { Type } from "@earendil-works/pi-ai";
import { BaseTool, createToolResult, createToolError } from './base';

export class EchoTool extends BaseTool<typeof EchoTool.parameters> {
  name = 'echo';
  label = 'Echo';
  description = 'Echo back the provided text';
  static parameters = Type.Object({
    text: Type.String({ description: 'The text to echo' }),
  });
  parameters = EchoTool.parameters;

  async execute(toolCallId: string, params: { text: string }) {
    return createToolResult(params.text);
  }
}

export class GetTimeTool extends BaseTool<typeof GetTimeTool.parameters> {
  name = 'get_time';
  label = 'Get Time';
  description = 'Get the current time and date';
  static parameters = Type.Object({});
  parameters = GetTimeTool.parameters;

  async execute(toolCallId: string) {
    const now = new Date();
    return createToolResult(`Current time: ${now.toLocaleString()}\nUTC: ${now.toISOString()}`);
  }
}

export class CalculateTool extends BaseTool<typeof CalculateTool.parameters> {
  name = 'calculate';
  label = 'Calculate';
  description = 'Perform mathematical calculations';
  static parameters = Type.Object({
    expression: Type.String({ description: 'The mathematical expression to evaluate' }),
  });
  parameters = CalculateTool.parameters;

  async execute(toolCallId: string, params: { expression: string }) {
    try {
      const safeExpr = params.expression.replace(/[^0-9+\-*/().\s]/g, '');
      const result = eval(safeExpr);
      return createToolResult(`${safeExpr} = ${result}`);
    } catch (err) {
      return createToolError(`Error: ${(err as Error).message}`);
    }
  }
}

export class EncodeBase64Tool extends BaseTool<typeof EncodeBase64Tool.parameters> {
  name = 'encode_base64';
  label = 'Encode Base64';
  description = 'Encode text to Base64';
  static parameters = Type.Object({
    text: Type.String({ description: 'The text to encode' }),
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
  description = 'Decode Base64 text';
  static parameters = Type.Object({
    text: Type.String({ description: 'The Base64 text to decode' }),
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
