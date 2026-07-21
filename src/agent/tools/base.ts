import { z, ZodType } from 'zod';

export interface Schema {
  toJsonSchema(): Record<string, unknown>;
}

export namespace Schema {
  export function fragment(value: unknown): Record<string, unknown> {
    if (value instanceof ZodType) {
      return { type: 'object' };
    }
    if (typeof value === 'object' && value !== null && 'toJsonSchema' in value) {
      return (value as Schema).toJsonSchema();
    }
    return value as Record<string, unknown>;
  }
}

export interface ToolContext {
  session_key: string;
  channel: string;
  chat_id: string;
  sender_id: string;
  workspace?: string;
  runtime?: unknown;
  extras?: Record<string, unknown>;
}

export interface ToolResult {
  content: string;
  is_error?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  tags?: string[];
  scope?: string;
}

export abstract class BaseTool {
  abstract name: string;
  abstract description: string;
  abstract input_schema: ZodType;
  tags: string[] = [];
  scope = 'global';

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.input_schema._def as unknown as Record<string, unknown>,
      tags: this.tags,
      scope: this.scope,
    };
  }

  toProviderTool(): { type: string; function: { name: string; description: string; parameters: Record<string, unknown> } } {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: this.zodToJsonSchema(this.input_schema),
      },
    };
  }

  private zodToJsonSchema(zodType: ZodType): Record<string, unknown> {
    const typeDef = (zodType as unknown as { _def: { typeName: string; innerType?: ZodType; of?: ZodType; shape?: Record<string, ZodType>; description?: string; options?: ZodType[]; values?: ZodType } })._def;
    const result: Record<string, unknown> = {};

    switch (typeDef.typeName) {
      case 'ZodObject': {
        result.type = 'object';
        const properties: Record<string, unknown> = {};
        const required: string[] = [];
        if (typeDef.shape) {
          for (const [key, value] of Object.entries(typeDef.shape)) {
            properties[key] = this.zodToJsonSchema(value);
            const valueDef = (value as unknown as { _def: { typeName: string } })._def;
            if (valueDef.typeName !== 'ZodOptional' && valueDef.typeName !== 'ZodNullable') {
              required.push(key);
            }
          }
        }
        result.properties = properties;
        if (required.length > 0) {
          result.required = required;
        }
        break;
      }
      case 'ZodString':
        result.type = 'string';
        if (typeDef.description) {
          result.description = typeDef.description;
        }
        break;
      case 'ZodNumber':
        result.type = 'number';
        if (typeDef.description) {
          result.description = typeDef.description;
        }
        break;
      case 'ZodBoolean':
        result.type = 'boolean';
        if (typeDef.description) {
          result.description = typeDef.description;
        }
        break;
      case 'ZodArray':
        result.type = 'array';
        if (typeDef.of) {
          result.items = this.zodToJsonSchema(typeDef.of);
        }
        break;
      case 'ZodOptional':
      case 'ZodNullable':
        if (typeDef.innerType) {
          return this.zodToJsonSchema(typeDef.innerType);
        }
        break;
      case 'ZodEnum':
        result.type = 'string';
        if (typeDef.options) {
          result.enum = (typeDef.options as unknown as string[]);
        }
        break;
      default:
        result.type = 'string';
    }

    return result;
  }

  validateArguments(args: unknown): unknown {
    return this.input_schema.parse(args);
  }

  abstract execute(args: unknown, context: ToolContext): Promise<ToolResult>;
}

export function isToolErrorResult(result: ToolResult): boolean {
  return result.is_error === true;
}

export function createToolError(message: string, metadata?: Record<string, unknown>): ToolResult {
  return {
    content: message,
    is_error: true,
    metadata,
  };
}

export function createToolResult(content: string, metadata?: Record<string, unknown>): ToolResult {
  return {
    content,
    is_error: false,
    metadata,
  };
}
