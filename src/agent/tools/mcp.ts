import { BaseTool, ToolContext, ToolResult, createToolResult, createToolError } from './base.js';
import { z, ZodTypeAny } from 'zod';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { logger } from '../../utils/logger.js';
import crypto from 'crypto';

const _TRANSIENT_ERROR_NAMES = new Set([
  'ClosedResourceError',
  'BrokenResourceError',
  'EndOfStream',
  'BrokenPipeError',
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'Error',
]);

const _MAX_TOOL_NAME_LENGTH = 64;
const _HASH_LENGTH = 8;

export interface MCPServerConfig {
  type?: 'stdio' | 'sse' | 'streamableHttp';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  enabled_tools?: string[];
  tool_timeout?: number;
}

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface MCPPrompt {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

interface MCPContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

interface MCPToolResult {
  content: MCPContentBlock[];
  isError?: boolean;
}

function _sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_');
}

function _limitToolName(name: string, maxLength = _MAX_TOOL_NAME_LENGTH): string {
  if (name.length <= maxLength) return name;
  const hash = crypto.createHash('sha1').update(name).digest('hex').slice(0, _HASH_LENGTH);
  const prefixLength = maxLength - _HASH_LENGTH - 1;
  return `${name.slice(0, prefixLength)}_${hash}`;
}

function _sanitizeMcpToolName(name: string): string {
  return _limitToolName(_sanitizeName(name));
}

function _isTransient(err: Error): boolean {
  return _TRANSIENT_ERROR_NAMES.has(err.name) ||
    ['session terminated', 'connection closed'].some(
      m => (err.message || '').toLowerCase().includes(m),
    );
}

function _normalizeSchemaForOpenAI(schema: unknown): Record<string, unknown> {
  if (typeof schema !== 'object' || schema === null) {
    return { type: 'object', properties: {} };
  }

  const normalized: Record<string, unknown> = { ...schema as Record<string, unknown> };

  const rawType = normalized.type;
  if (Array.isArray(rawType)) {
    const nonNull = rawType.filter(item => item !== 'null');
    if (rawType.includes('null') && nonNull.length === 1) {
      normalized.type = nonNull[0];
      normalized.nullable = true;
    }
  }

  for (const key of ['oneOf', 'anyOf']) {
    const nullableBranch = _extractNullableBranch(normalized[key]);
    if (nullableBranch) {
      const [branch] = nullableBranch;
      const merged: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(normalized)) {
        if (k !== key) merged[k] = v;
      }
      Object.assign(merged, branch);
      merged.nullable = true;
      Object.assign(normalized, merged);
      break;
    }
  }

  if (typeof normalized.properties === 'object' && normalized.properties !== null) {
    const props = normalized.properties as Record<string, unknown>;
    const newProps: Record<string, unknown> = {};
    for (const [name, prop] of Object.entries(props)) {
      newProps[name] = _normalizeSchemaForOpenAI(prop);
    }
    normalized.properties = newProps;
  }

  if (typeof normalized.items === 'object' && normalized.items !== null) {
    normalized.items = _normalizeSchemaForOpenAI(normalized.items);
  }

  if (normalized.type !== 'object') return normalized;
  if (!normalized.properties) normalized.properties = {};
  if (!normalized.required) normalized.required = [];
  return normalized;
}

function _extractNullableBranch(options: unknown): [Record<string, unknown>] | null {
  if (!Array.isArray(options)) return null;
  const nonNull: Record<string, unknown>[] = [];
  let sawNull = false;
  for (const option of options) {
    if (typeof option !== 'object' || option === null) return null;
    if ((option as Record<string, unknown>).type === 'null') {
      sawNull = true;
      continue;
    }
    nonNull.push(option as Record<string, unknown>);
  }
  if (sawNull && nonNull.length === 1) return [nonNull[0]];
  return null;
}

function _redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;
    const path = parsed.pathname && parsed.pathname !== '/' ? '/...' : parsed.pathname;
    return `${parsed.protocol}//${hostname}${parsed.port ? ':' + parsed.port : ''}${path}`;
  } catch {
    return '<redacted-url>';
  }
}

abstract class MCPSession {
  abstract initialize(): Promise<void>;
  abstract listTools(): Promise<MCPToolDefinition[]>;
  abstract listResources(): Promise<MCPResource[]>;
  abstract listPrompts(): Promise<MCPPrompt[]>;
  abstract callTool(name: string, args: Record<string, unknown>): Promise<MCPToolResult>;
  abstract readResource(uri: string): Promise<{ contents: MCPContentBlock[] }>;
  abstract getPrompt(name: string, args: Record<string, unknown>): Promise<{ messages: Array<{ content: MCPContentBlock | MCPContentBlock[] }> }>;
  abstract close(): Promise<void>;
}

class StdioMCPSession extends MCPSession {
  private proc: ChildProcessWithoutNullStreams;
  private requestId = 0;
  private pendingRequests = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private buffer = '';
  private initialized = false;

  constructor(config: { command: string; args?: string[]; env?: Record<string, string>; cwd?: string }) {
    super();
    this.proc = spawn(config.command, config.args || [], {
      env: { ...process.env, ...config.env },
      cwd: config.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout.on('data', (data: Buffer) => {
      this.buffer += data.toString('utf-8');
      this._processBuffer();
    });

    this.proc.stderr.on('data', (data: Buffer) => {
      logger.debug({ server: 'stdio', data: data.toString().slice(0, 500) }, 'MCP stderr');
    });

    this.proc.on('error', (err) => {
      logger.error({ error: err.message }, 'MCP stdio process error');
      this._rejectAll(err);
    });

    this.proc.on('exit', (code) => {
      logger.debug({ code }, 'MCP stdio process exited');
      this._rejectAll(new Error(`MCP process exited with code ${code}`));
    });
  }

  private _processBuffer(): void {
    while (true) {
      const idx = this.buffer.indexOf('\n');
      if (idx === -1) break;
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        this._handleMessage(msg);
      } catch (e) {
        logger.debug({ line: line.slice(0, 200) }, 'MCP invalid JSON line');
      }
    }
  }

  private _handleMessage(msg: any): void {
    if (msg.id !== undefined && msg.jsonrpc) {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        this.pendingRequests.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(msg.error.message || 'MCP error'));
        } else {
          pending.resolve(msg.result);
        }
      }
    }
  }

  private _sendRequest(method: string, params?: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      this.pendingRequests.set(id, { resolve, reject });
      const request = {
        jsonrpc: '2.0',
        id,
        method,
        params: params || {},
      };
      this.proc.stdin.write(JSON.stringify(request) + '\n', (err) => {
        if (err) {
          this.pendingRequests.delete(id);
          reject(err);
        }
      });
    });
  }

  private _rejectAll(err: Error): void {
    for (const [, pending] of this.pendingRequests) {
      pending.reject(err);
    }
    this.pendingRequests.clear();
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this._sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'nanobot', version: '1.0.0' },
    });
    this.initialized = true;
  }

  async listTools(): Promise<MCPToolDefinition[]> {
    const result = await this._sendRequest('tools/list');
    return result.tools || [];
  }

  async listResources(): Promise<MCPResource[]> {
    const result = await this._sendRequest('resources/list');
    return result.resources || [];
  }

  async listPrompts(): Promise<MCPPrompt[]> {
    const result = await this._sendRequest('prompts/list');
    return result.prompts || [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    return await this._sendRequest('tools/call', { name, arguments: args });
  }

  async readResource(uri: string): Promise<{ contents: MCPContentBlock[] }> {
    return await this._sendRequest('resources/read', { uri });
  }

  async getPrompt(name: string, args: Record<string, unknown>): Promise<{ messages: Array<{ content: MCPContentBlock | MCPContentBlock[] }> }> {
    return await this._sendRequest('prompts/get', { name, arguments: args });
  }

  async close(): Promise<void> {
    this.proc.kill();
  }
}

async function createMCPSession(config: MCPServerConfig): Promise<MCPSession> {
  let type = config.type;
  if (!type) {
    if (config.command) type = 'stdio';
    else if (config.url) {
      type = config.url.replace(/\/$/, '').endsWith('/sse') ? 'sse' : 'streamableHttp';
    } else {
      throw new Error('MCP server config must have command or url');
    }
  }

  if (type === 'stdio') {
    if (!config.command) throw new Error('stdio MCP server requires command');
    const session = new StdioMCPSession({
      command: config.command,
      args: config.args,
      env: config.env,
      cwd: config.cwd,
    });
    await session.initialize();
    return session;
  }

  throw new Error(`Unsupported MCP transport type: ${type}`);
}

abstract class _MCPWrapperBase extends BaseTool {
  protected _session!: MCPSession;
  protected _serverName!: string;
  protected _reconnect: ((serverName: string, toolName: string, tool: BaseTool) => Promise<BaseTool | null>) | null = null;

  setMcpConnection(session: MCPSession, serverName: string): void {
    this._session = session;
    this._serverName = serverName;
  }

  setReconnectHandler(handler: (serverName: string, toolName: string, tool: BaseTool) => Promise<BaseTool | null>): void {
    this._reconnect = handler;
  }

  protected async _refreshSessionAfterTermination(
    exc: Error,
    alreadyRefreshed: boolean,
    capabilityKind: string,
  ): Promise<boolean> {
    if (alreadyRefreshed || !_isTransient(exc) || !this._reconnect) return false;
    logger.warn(
      { tool: this.name, server: this._serverName, kind: capabilityKind },
      'MCP session terminated; reconnecting',
    );
    const refreshedTool = await this._reconnect(this._serverName, this.name, this);
    const refreshedSession = (refreshedTool as any)?._session;
    if (!refreshedSession) {
      logger.warn({ tool: this.name, server: this._serverName }, 'MCP could not refresh session');
      return false;
    }
    this._session = refreshedSession;
    return true;
  }
}

export class MCPToolWrapper extends _MCPWrapperBase {
  private _originalName: string;
  private _name: string;
  private _description: string;
  private _parameters: Record<string, unknown>;
  private _toolTimeout: number;

  constructor(session: MCPSession, serverName: string, toolDef: MCPToolDefinition, toolTimeout = 30) {
    super();
    this._originalName = toolDef.name;
    this._name = _sanitizeMcpToolName(`mcp_${serverName}_${toolDef.name}`);
    this._description = toolDef.description || toolDef.name;
    const rawSchema = toolDef.inputSchema || { type: 'object', properties: {} };
    this._parameters = _normalizeSchemaForOpenAI(rawSchema);
    this._toolTimeout = toolTimeout;
    this.setMcpConnection(session, serverName);
  }

  get name(): string { return this._name; }
  get description(): string { return this._description; }
  get input_schema(): ZodTypeAny {
    return z.object({}).passthrough();
  }
  tags = ['mcp'];

  getDefinition() {
    return {
      name: this._name,
      description: this._description,
      input_schema: this._parameters as any,
      tags: this.tags,
      scope: this.scope,
    };
  }

  toProviderTool() {
    return {
      type: 'function' as const,
      function: {
        name: this._name,
        description: this._description,
        parameters: this._parameters,
      },
    };
  }

  validateArguments(args: unknown): unknown {
    return args;
  }

  async execute(args: unknown, _context: ToolContext): Promise<ToolResult> {
    let retriedTransient = false;
    let refreshedSession = false;
    const kwargs = (args || {}) as Record<string, unknown>;

    while (true) {
      try {
        const timeoutMs = this._toolTimeout * 1000;
        const result = await Promise.race([
          this._session.callTool(this._originalName, kwargs),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`MCP tool call timed out after ${this._toolTimeout}s`)), timeoutMs),
          ),
        ]);

        const rendered = this._renderCallResult(result.content, kwargs);
        if (result.isError) {
          return createToolError(rendered);
        }
        return createToolResult(rendered);
      } catch (exc: unknown) {
        const err = exc as Error;
        if (await this._refreshSessionAfterTermination(err, refreshedSession, 'tool')) {
          refreshedSession = true;
          continue;
        }
        if (_isTransient(err)) {
          if (!retriedTransient) {
            retriedTransient = true;
            logger.warn(
              { tool: this.name, error: err.name },
              'MCP tool hit transient error, retrying...',
            );
            await new Promise(r => setTimeout(r, 1000));
            continue;
          }
          logger.error({ tool: this.name, error: err.message }, 'MCP tool failed after retry');
          return createToolError(`(MCP tool call failed after retry: ${err.name})`);
        }
        logger.error({ tool: this.name, error: err.message }, 'MCP tool failed');
        return createToolError(`(MCP tool call failed: ${err.message})`);
      }
    }
  }

  private _renderCallResult(content: MCPContentBlock[], _arguments: Record<string, unknown>): string {
    const textParts: string[] = [];
    for (const block of content) {
      if (block.type === 'text' && block.text) {
        textParts.push(block.text);
      } else if (block.type === 'image' && block.data) {
        const mime = block.mimeType || 'image/png';
        textParts.push(`[Image: ${mime}, ${Math.round(block.data.length * 0.75)} bytes]`);
      } else {
        textParts.push(String(block));
      }
    }
    return textParts.join('\n') || '(no output)';
  }
}

export class MCPResourceWrapper extends _MCPWrapperBase {
  private _uri: string;
  private _name: string;
  private _description: string;
  private _resourceTimeout: number;

  constructor(session: MCPSession, serverName: string, resource: MCPResource, resourceTimeout = 30) {
    super();
    this._uri = resource.uri;
    this._name = _sanitizeMcpToolName(`mcp_${serverName}_resource_${resource.name}`);
    const desc = resource.description || resource.name;
    this._description = `[MCP Resource] ${desc}\nURI: ${this._uri}`;
    this._resourceTimeout = resourceTimeout;
    this.setMcpConnection(session, serverName);
  }

  get name(): string { return this._name; }
  get description(): string { return this._description; }
  get input_schema(): ZodTypeAny {
    return z.object({});
  }
  tags = ['mcp', 'resource'];

  async execute(_args: unknown, _context: ToolContext): Promise<ToolResult> {
    let retriedTransient = false;
    let refreshedSession = false;

    while (true) {
      try {
        const timeoutMs = this._resourceTimeout * 1000;
        const result = await Promise.race([
          this._session.readResource(this._uri),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`MCP resource read timed out after ${this._resourceTimeout}s`)), timeoutMs),
          ),
        ]);

        const parts: string[] = [];
        for (const block of result.contents) {
          if (block.type === 'text' && block.text) {
            parts.push(block.text);
          } else if (block.type === 'blob') {
            parts.push(`[Binary resource]`);
          } else {
            parts.push(String(block));
          }
        }
        return createToolResult(parts.join('\n') || '(no output)');
      } catch (exc: unknown) {
        const err = exc as Error;
        if (await this._refreshSessionAfterTermination(err, refreshedSession, 'resource')) {
          refreshedSession = true;
          continue;
        }
        if (_isTransient(err)) {
          if (!retriedTransient) {
            retriedTransient = true;
            logger.warn({ tool: this.name }, 'MCP resource hit transient error, retrying...');
            await new Promise(r => setTimeout(r, 1000));
            continue;
          }
          return createToolError(`(MCP resource read failed after retry: ${err.name})`);
        }
        return createToolError(`(MCP resource read failed: ${err.message})`);
      }
    }
  }
}

export class MCPPromptWrapper extends _MCPWrapperBase {
  private _promptName: string;
  private _name: string;
  private _description: string;
  private _promptTimeout: number;

  constructor(session: MCPSession, serverName: string, prompt: MCPPrompt, promptTimeout = 30) {
    super();
    this._promptName = prompt.name;
    this._name = _sanitizeMcpToolName(`mcp_${serverName}_prompt_${prompt.name}`);
    const desc = prompt.description || prompt.name;
    this._description = `[MCP Prompt] ${desc}\nReturns a filled prompt template that can be used as a workflow guide.`;
    this._promptTimeout = promptTimeout;
    this.setMcpConnection(session, serverName);
  }

  get name(): string { return this._name; }
  get description(): string { return this._description; }
  get input_schema(): ZodTypeAny {
    return z.object({}).passthrough();
  }
  tags = ['mcp', 'prompt'];

  async execute(args: unknown, _context: ToolContext): Promise<ToolResult> {
    let retriedTransient = false;
    let refreshedSession = false;
    const kwargs = (args || {}) as Record<string, unknown>;

    while (true) {
      try {
        const timeoutMs = this._promptTimeout * 1000;
        const result = await Promise.race([
          this._session.getPrompt(this._promptName, kwargs),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`MCP prompt call timed out after ${this._promptTimeout}s`)), timeoutMs),
          ),
        ]);

        const parts: string[] = [];
        for (const message of result.messages) {
          const content = message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text' && block.text) parts.push(block.text);
              else parts.push(String(block));
            }
          } else if (typeof content === 'object' && content !== null) {
            const c = content as MCPContentBlock;
            if (c.type === 'text' && c.text) parts.push(c.text);
            else parts.push(String(c));
          } else {
            parts.push(String(content));
          }
        }
        return createToolResult(parts.join('\n') || '(no output)');
      } catch (exc: unknown) {
        const err = exc as Error;
        if (await this._refreshSessionAfterTermination(err, refreshedSession, 'prompt')) {
          refreshedSession = true;
          continue;
        }
        if (_isTransient(err)) {
          if (!retriedTransient) {
            retriedTransient = true;
            logger.warn({ tool: this.name }, 'MCP prompt hit transient error, retrying...');
            await new Promise(r => setTimeout(r, 1000));
            continue;
          }
          return createToolError(`(MCP prompt call failed after retry: ${err.name})`);
        }
        return createToolError(`(MCP prompt call failed: ${err.message})`);
      }
    }
  }
}

export interface MCPConnection {
  session: MCPSession;
  serverName: string;
  close(): Promise<void>;
}

export async function connectMcpServers(
  mcpServers: Record<string, MCPServerConfig>,
  registry: { register: (tool: BaseTool) => void },
): Promise<Record<string, MCPConnection>> {
  const connections: Record<string, MCPConnection> = {};

  for (const [name, cfg] of Object.entries(mcpServers)) {
    try {
      logger.info({ server: name }, 'Connecting to MCP server');
      const session = await createMCPSession(cfg);

      const tools = await session.listTools();
      const enabledTools = new Set(cfg.enabled_tools || []);
      const allowAllTools = enabledTools.has('*');
      let registeredCount = 0;

      for (const toolDef of tools) {
        const wrappedName = _sanitizeMcpToolName(`mcp_${name}_${toolDef.name}`);
        if (!allowAllTools && !enabledTools.has(toolDef.name) && !enabledTools.has(wrappedName)) {
          logger.debug({ tool: wrappedName, server: name }, 'MCP skipping tool (not in enabled_tools)');
          continue;
        }
        const wrapper = new MCPToolWrapper(session, name, toolDef, cfg.tool_timeout || 30);
        registry.register(wrapper);
        logger.debug({ tool: wrapper.name, server: name }, 'MCP registered tool');
        registeredCount++;
      }

      if (allowAllTools) {
        try {
          const resources = await session.listResources();
          for (const resource of resources) {
            const wrapper = new MCPResourceWrapper(session, name, resource, cfg.tool_timeout || 30);
            registry.register(wrapper);
            registeredCount++;
            logger.debug({ tool: wrapper.name, server: name }, 'MCP registered resource');
          }
        } catch (e) {
          logger.debug({ server: name, error: (e as Error).message }, 'MCP resources not supported');
        }

        try {
          const prompts = await session.listPrompts();
          for (const prompt of prompts) {
            const wrapper = new MCPPromptWrapper(session, name, prompt, cfg.tool_timeout || 30);
            registry.register(wrapper);
            registeredCount++;
            logger.debug({ tool: wrapper.name, server: name }, 'MCP registered prompt');
          }
        } catch (e) {
          logger.debug({ server: name, error: (e as Error).message }, 'MCP prompts not supported');
        }
      }

      connections[name] = {
        session,
        serverName: name,
        close: async () => { await session.close(); },
      };

      logger.info({ server: name, count: registeredCount }, 'MCP server connected');
    } catch (e) {
      logger.error({ server: name, error: (e as Error).message }, 'MCP server failed to connect');
    }
  }

  return connections;
}
