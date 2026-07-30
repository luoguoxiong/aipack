import { Type, Static, TSchema } from "../ai";
import type { TextContent, ImageContent, Usage } from "../ai";

export interface ToolContext {
  session_key: string;
  channel: string;
  chat_id: string;
  sender_id: string;
  workspace?: string;
}

export interface ToolResult<T = unknown> {
  content: (TextContent | ImageContent)[];
  details: T;
  usage?: Usage;
  addedToolNames?: string[];
  terminate?: boolean;
}

export interface ToolDefinition<TParameters extends TSchema = TSchema> {
  name: string;
  label: string;
  description: string;
  parameters: TParameters;
  execute: (
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: (partialResult: ToolResult) => void,
  ) => Promise<ToolResult>;
  prepareArguments?: (args: unknown) => Static<TParameters>;
  executionMode?: "sequential" | "parallel";
}

export const StringSchema = Type.String();
export const IntegerSchema = Type.Integer();
export const NumberSchema = Type.Number();
export const BooleanSchema = Type.Boolean();
export const ArraySchema = Type.Array;
export const ObjectSchema = Type.Object;
export const NullSchema = Type.Null();

export function toolParametersSchema<T extends Record<string, TSchema>>(properties: T) {
  return Type.Object(properties);
}

export function createToolResult(content: string | (TextContent | ImageContent)[], details?: unknown): ToolResult {
  const contentArray = typeof content === 'string' 
    ? [{ type: 'text' as const, text: content }] 
    : content;
  return {
    content: contentArray,
    details: details || {},
  };
}

export function createToolError(message: string): ToolResult {
  return {
    content: [{ type: 'text' as const, text: message }],
    details: { error: message },
  };
}

export function isToolErrorResult(result: ToolResult): boolean {
  return !!result.details && typeof result.details === 'object' && 'error' in result.details;
}

export interface PartialSuccessResult {
  successCount: number;
  failureCount: number;
  totalCount: number;
  successes: unknown[];
  failures: { item: unknown; error: string }[];
}

export function createPartialSuccess(
  message: string,
  partialResult: PartialSuccessResult
): ToolResult {
  return {
    content: [{ type: 'text' as const, text: message }],
    details: { 
      partial: true,
      ...partialResult 
    },
  };
}

export function isPartialSuccessResult(result: ToolResult): boolean {
  return !!result.details && typeof result.details === 'object' && 'partial' in result.details;
}
